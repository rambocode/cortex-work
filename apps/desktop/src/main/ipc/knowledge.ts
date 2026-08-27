// 公司知识库设置的 IPC 域：保存连接配置 + 连通性自检。
//
// 只有两个 channel，且都**不经过任何 service**——知识库的 MCP server 在远端，
// 本地没有需要拉起的东西，设置页要的就是「把令牌安全地存下来」和「告诉我现在能不能连上」。
//
// 明文令牌的**唯一**归宿是 setKnowledgeCredential：safeStorage 加密 → base64 →
// 落进 personal-workspace.json。那份 JSON 是明文文件，所以明文令牌绝不能进去；
// 这也是本模块存在的全部理由——让 renderer 无法绕过加密直接写该字段。
import { ipcMain, safeStorage } from "electron";
import { z } from "zod";

import { createLogger } from "../log";
import { updatePersistedState } from "./store";
// MCP 握手/调用的实现在 capabilities/knowledge/client.ts，本文件只做 IPC 编排与凭据落盘。
import {
  callKnowledgeTool,
  getKnowledgeCapabilitiesCached,
  openKnowledgeSession,
  primeKnowledgeCapabilities,
  probeKnowledgeCapabilities,
  resolveKnowledgeEndpoint,
} from "../capabilities/knowledge/client";
import {
  clearKnowledgeCapabilitiesCache,
  looksLikeAuthError,
  pickAuthProbeTool,
  type KnowledgeCapabilities,
  type KnowledgeToolRoles,
} from "../capabilities/knowledge/tools";
import type { KnowledgeBaseSettings, KnowledgeDocResult } from "./types";

const log = createLogger("knowledge-ipc");

/// 归一化用户粘贴的令牌：剥掉 `Bearer ` 前缀与首尾空白。
///
/// **为什么必须剥**：管理员给的往往是一整段 MCP 配置（`"Authorization": "Bearer gs_xxx"`），
/// 用户很自然地把 `Bearer gs_xxx` 整个粘进来。拼进请求头就成了
/// `Authorization: Bearer Bearer gs_xxx`，服务端解析不出令牌 →「缺少有效的 API Token」。
/// 这个错误极难自查：界面显示「已配置」，连通性自检也过（很多服务端的 tools/list 不校验
/// 鉴权），只有 agent 真正调用工具时才炸，而报错文案看起来像是服务端没配好。
function normalizeToken(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, "").trim();
}

const credentialSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string(),
  // 明文令牌。**只在这一个方向上出现**（renderer → main），且不落盘、不回传、不记日志。
  // undefined = 不改动已存的令牌（用户只改了地址时不必重填令牌）。
  token: z.string().optional(),
});

/// 把落盘后的切片整理成回传给 renderer 的形状。
///
/// **必须带上 encryptedToken**（密文，不是明文）。曾经这里刻意抹掉它，想着「UI 连密文都不看」，
/// 结果是一个很隐蔽的 bug：renderer 拿回传值更新 store 后，usePersonalPersistence 会把整个
/// store 全量写回 personal-workspace.json —— 那份副本里没有 encryptedToken，于是刚加密落盘的
/// 令牌被立刻覆盖成 undefined，表现为「保存成功，但测试连接说没填令牌」。
/// 同 research 的 setSearchServerCredential 注释所警告的 clobber。
///
/// 明文与密文的边界仍然清晰：明文只在 renderer → main 单向流动，从不回传；
/// 密文回传只为让 renderer 的快照与磁盘一致，UI 侧只读 hasToken。
function toClientSlice(s: KnowledgeBaseSettings): KnowledgeBaseSettings {
  return {
    enabled: s.enabled,
    baseUrl: s.baseUrl,
    encryptedToken: s.encryptedToken,
    hasToken: Boolean(s.encryptedToken),
  };
}

/// 写入知识库连接配置（设置页「保存」）。
///
/// 写入走 updatePersistedState（main 侧窄写）而不是让 renderer 传全量状态：
/// 后者会有陈旧快照 clobber（见 store.ts 注释）。
///
/// **返回落盘后的切片**（含密文）：renderer 必须拿它更新自己的 store，
/// 否则它那份缺 encryptedToken 的副本会在下一次全量写回时把刚存的令牌抹掉（见 toClientSlice）。
export async function setKnowledgeCredential(input: {
  enabled: boolean;
  baseUrl: string;
  token?: string;
}): Promise<KnowledgeBaseSettings> {
  let encryptedToken: string | undefined;
  const hasNewToken = Boolean(input.token && normalizeToken(input.token));
  if (hasNewToken) {
    if (!safeStorage.isEncryptionAvailable()) {
      // fail closed：钥匙串不可用时**宁可拒绝保存**，也不把明文写进 JSON。
      throw new Error("系统密钥库不可用，无法安全保存令牌");
    }
    encryptedToken = safeStorage.encryptString(normalizeToken(input.token!)).toString("base64");
  }

  const next = await updatePersistedState((state) => {
    const prev = state.generalSettings?.knowledgeBase;
    return {
      ...state,
      generalSettings: {
        ...state.generalSettings!,
        knowledgeBase: {
          enabled: input.enabled,
          baseUrl: input.baseUrl.trim(),
          // 没传新令牌 → 保留旧密文（用户只改地址时不必重填令牌）。
          encryptedToken: hasNewToken ? encryptedToken : prev?.encryptedToken,
        },
      },
    };
  });
  const saved = next.generalSettings?.knowledgeBase;
  // 地址或令牌变了，旧能力快照必须作废：拿只读令牌的缓存去渲染写权限令牌的 prompt，
  // 会告诉模型「本会话只读」而它其实能写（反之则更糟——让它去调一个拿不到的工具）。
  clearKnowledgeCapabilitiesCache();
  // 后台探测一次，让下一轮会话启动时注入侧能同步读到能力块（探测本身不阻塞保存）。
  if (saved?.enabled && saved.baseUrl?.trim() && saved.encryptedToken) primeKnowledgeCapabilities();
  return toClientSlice(saved ?? { enabled: false, baseUrl: "" });
}

/// 清除已保存的令牌（设置页「移除令牌」）。
export async function clearKnowledgeCredential(): Promise<KnowledgeBaseSettings> {
  const next = await updatePersistedState((state) => {
    const prev = state.generalSettings?.knowledgeBase;
    return {
      ...state,
      generalSettings: {
        ...state.generalSettings!,
        knowledgeBase: { enabled: prev?.enabled ?? false, baseUrl: prev?.baseUrl ?? "" },
      },
    };
  });
  clearKnowledgeCapabilitiesCache();
  return toClientSlice(next.generalSettings?.knowledgeBase ?? { enabled: false, baseUrl: "" });
}

export interface KnowledgeTestResult {
  ok: boolean;
  message: string;
  /// 连通时列出服务端实际提供的工具名，让用户一眼看到这枚令牌到底能干什么。
  tools?: string[];
  /// 工具名 → 语义角色的映射结果。UI 据此判断读写能力，**不再按固定工具名去猜**
  /// （从前写死 kb_write_doc，接第三方知识库时永远判成只读）。
  roles?: KnowledgeToolRoles;
}

/// 连通性自检：按 MCP 协议真跑一次 initialize + tools/list，并把结果灌进能力缓存。
///
/// 不用「GET 一下首页看通不通」这种弱检查——那只能证明网络可达，
/// 证明不了令牌有效、端点正确、scope 够用。用户配错的绝大多数情况恰恰在后三者。
///
/// 自检与能力探测**合并成同一次往返**：用户点一下「测试连接」，顺带把注入 prompt 用的
/// 能力快照准备好，下一轮会话启动即可同步读到，不必再等一次网络。
export async function testKnowledgeConnection(): Promise<KnowledgeTestResult> {
  const caps = await probeKnowledgeCapabilities();
  if (typeof caps === "string") return { ok: false, message: caps };
  const tools = caps.tools.map((t) => t.name);
  if (!tools.length) return { ok: true, message: "已连接，但服务端未提供任何工具" };

  // **必须真调一次工具**：握手 + tools/list 在不少服务端上根本不校验鉴权（实测某企业 wiki
  // 不带任何令牌也照样列出全部工具），只做到那一步的自检会给出假阳性——界面显示「连接正常、
  // 令牌可写入」，而 agent 一调用就报「缺少有效的 API Token」，用户完全无从下手。
  // 这正是本函数原注释批评过的「GET 首页」式弱检查，只是换了个地方犯。
  const probeTool = pickAuthProbeTool(caps);
  if (probeTool) {
    const ep = await resolveKnowledgeEndpoint();
    if (typeof ep !== "string") {
      try {
        const session = await openKnowledgeSession(ep);
        if (typeof session !== "string") {
          const { errorText } = await callKnowledgeTool(session, probeTool, {});
          // 只有确实像鉴权失败才判失败；工具自身的业务错误（参数、空数据）不算连接问题。
          if (errorText && looksLikeAuthError(errorText)) {
            return {
              ok: false,
              message: `令牌未通过服务端校验：${errorText}。请确认令牌完整，且不要连 “Bearer ” 前缀一起粘贴。`,
              tools,
              roles: caps.roles,
            };
          }
        }
      } catch {
        // 探针本身连不上不改变结论：前面的握手已经证明网络与端点没问题。
      }
    }
  }

  // 报告里点名「检索 / 读取」两个关键角色：它们缺席时知识库虽然连得上，
  // 但 agent 拿不到完整链路，用户需要在这里就知道，而不是等对话里出问题。
  const missing = [!caps.roles.search && "检索", !caps.roles.read && "读取"].filter(Boolean);
  const suffix = missing.length ? `，但未识别出${missing.join(" / ")}工具` : "";
  return { ok: true, message: `连接正常，可用工具 ${tools.length} 个${suffix}`, tools, roles: caps.roles };
}

/// 解析端点并拿到能力快照（缓存优先，未命中就现探测一次）。
///
/// 这里可以等网络：调用方是「用户点了一下引用」，不在会话启动的关键路径上。
async function resolveEndpointWithCapabilities(): Promise<
  { ep: { url: string; token: string }; caps: KnowledgeCapabilities } | string
> {
  const ep = await resolveKnowledgeEndpoint();
  if (typeof ep === "string") return ep;
  const cached = getKnowledgeCapabilitiesCached(ep.url, ep.token);
  if (cached) return { ep, caps: cached };
  const probed = await probeKnowledgeCapabilities();
  if (typeof probed === "string") return probed;
  return { ep, caps: probed };
}

/// 单次预览最多取多少字符。预览面板是给人读的，再多也不会有人往下翻，
/// 且一次拉完省掉分页交互。只有当服务端的读工具确实声明了 limit 参数时才会传。
const PREVIEW_LIMIT = 20_000;

/// 取一篇知识库文档的正文（点开会话里的引用时用）。
///
/// 走的是主进程自己的 MCP 通道，与 agent 会话完全无关——用户点一下引用不该
/// 也不能触发一次 agent 回合。
///
/// **工具名与参数名都是动态的**：从能力快照里取 read 角色对应的真实工具，
/// 把 `kb://<a>/<b>` 的两段按 readLocatorParams 的顺序填回去。写死 kb_read_doc /
/// sourceId / relPath 的旧实现，在任何非自家知识库上都必然失败。
export async function readKnowledgeDoc(input: {
  sourceId: string;
  relPath: string;
}): Promise<KnowledgeDocResult> {
  const resolved = await resolveEndpointWithCapabilities();
  if (typeof resolved === "string") return { ok: false, message: resolved };
  const { ep, caps } = resolved;

  const toolName = caps.roles.read;
  if (!toolName) {
    return { ok: false, message: "当前知识库没有可识别的「读取文档」工具，无法预览原文" };
  }

  const readSchema = caps.tools.find((t) => t.name === toolName)?.inputSchema;

  // `kb://<a>/<b>` 的两段在 URL 里天然是字符串，但服务端的坐标参数未必是字符串类型
  // （实测某企业 wiki 的 knowledgeBaseId 是整数）。按 schema 声明的类型回转一次，
  // 否则会被服务端的参数校验直接拒掉，而错误信息只会说「参数类型不对」。
  const coerce = (param: string, value: string): string | number => {
    const declared = (readSchema?.properties?.[param] as { type?: string } | undefined)?.type;
    return (declared === "number" || declared === "integer") && /^\d+$/.test(value) ? Number(value) : value;
  };

  const [locatorA, locatorB] = caps.readLocatorParams;
  const args: Record<string, unknown> = {};
  if (locatorA) args[locatorA] = coerce(locatorA, input.sourceId);
  if (locatorB) args[locatorB] = coerce(locatorB, input.relPath);
  // limit 只在服务端声明了它时才传：MCP server 对未声明的入参可以直接拒绝，
  // 多传一个参数换来一次「参数校验失败」得不偿失。
  if (readSchema?.properties && "limit" in readSchema.properties) args.limit = PREVIEW_LIMIT;

  try {
    const session = await openKnowledgeSession(ep);
    if (typeof session === "string") return { ok: false, message: session };
    // 结构化结果的字段名各家不同（自家 text/fileName/totalRunes，实测某 wiki 是
    // content/documentName/totalChars），故按别名逐个兜底取值，取不到就留空。
    const { structured, text, errorText } = await callKnowledgeTool<Record<string, unknown>>(
      session,
      toolName,
      args,
    );
    if (errorText) return { ok: false, message: errorText };
    const pick = <T>(...keys: string[]): T | undefined => {
      for (const k of keys) {
        const v = structured?.[k];
        if (v !== undefined && v !== null && v !== "") return v as T;
      }
      return undefined;
    };
    // structuredContent 缺失时拿 content 文本兜底——不少第三方 server 不声明 outputSchema，
    // 只认结构化输出的话会把一篇正常读到的文档报成「读取失败」。
    const body = pick<string>("text", "content", "body", "markdown") ?? text ?? "";
    if (!body) return { ok: false, message: "读取成功但没有正文内容" };
    return {
      ok: true,
      // 文件名服务端未必回；退回用 relPath 的最后一段，总比空标题强。
      fileName: pick<string>("fileName", "documentName", "name") ?? input.relPath.split("/").pop(),
      sourceId: input.sourceId,
      relPath: pick<string>("relPath", "documentPath", "path") ?? input.relPath,
      text: body,
      totalRunes: pick<number>("totalRunes", "totalChars", "totalLength"),
      hasMore: pick<boolean>("hasMore"),
      note: pick<string>("note"),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`知识库取文失败: ${msg}`);
    return { ok: false, message: `无法连接知识库：${msg}` };
  }
}

const docRefSchema = z.object({ sourceId: z.string().min(1), relPath: z.string().min(1) });

/// 注册知识库 IPC handler。
export function registerKnowledgeHandlers(): void {
  // 入参含明文令牌，**刻意不记录任何入参日志**。
  ipcMain.handle("knowledge:setCredential", async (_e, raw: unknown) =>
    setKnowledgeCredential(credentialSchema.parse(raw)),
  );
  ipcMain.handle("knowledge:clearCredential", async () => clearKnowledgeCredential());
  ipcMain.handle("knowledge:test", async () => testKnowledgeConnection());
  ipcMain.handle("knowledge:readDoc", async (_e, raw: unknown) => readKnowledgeDoc(docRefSchema.parse(raw)));
}
