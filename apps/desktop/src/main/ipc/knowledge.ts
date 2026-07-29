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
  openKnowledgeSession,
  parseRpcResult,
  resolveKnowledgeEndpoint,
  withKnowledgeTool,
} from "../capabilities/knowledge/client";
import type { KnowledgeBaseSettings, KnowledgeDocResult } from "./types";

const log = createLogger("knowledge-ipc");

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
  const hasNewToken = Boolean(input.token && input.token.trim());
  if (hasNewToken) {
    if (!safeStorage.isEncryptionAvailable()) {
      // fail closed：钥匙串不可用时**宁可拒绝保存**，也不把明文写进 JSON。
      throw new Error("系统密钥库不可用，无法安全保存令牌");
    }
    encryptedToken = safeStorage.encryptString(input.token!.trim()).toString("base64");
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
  return toClientSlice(next.generalSettings?.knowledgeBase ?? { enabled: false, baseUrl: "" });
}

export interface KnowledgeTestResult {
  ok: boolean;
  message: string;
  /// 连通时列出服务端实际提供的工具名，让用户一眼看出令牌 scope 够不够
  /// （只有 read scope 时不会出现 kb_write_doc）。
  tools?: string[];
}

/// 连通性自检：按 MCP 协议真跑一次 initialize + tools/list。
///
/// 不用「GET 一下首页看通不通」这种弱检查——那只能证明网络可达，
/// 证明不了令牌有效、端点正确、scope 够用。用户配错的绝大多数情况恰恰在后三者。
export async function testKnowledgeConnection(): Promise<KnowledgeTestResult> {
  const ep = await resolveKnowledgeEndpoint();
  if (typeof ep === "string") return { ok: false, message: ep };
  try {
    const session = await openKnowledgeSession(ep);
    if (typeof session === "string") return { ok: false, message: session };
    const res = await fetch(session.url, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = parseRpcResult<{ tools?: { name?: string }[] }>(await res.text());
    const tools = (result?.tools ?? []).map((t) => t.name ?? "").filter(Boolean);
    if (!tools.length) return { ok: true, message: "已连接，但服务端未提供任何工具" };
    return { ok: true, message: `连接正常，可用工具 ${tools.length} 个`, tools };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`知识库连通性自检失败: ${msg}`);
    return { ok: false, message: `无法连接：${msg}` };
  }
}

/// 单次预览最多取多少字符。取服务端 kb_read_doc 的硬上限——
/// 预览面板是给人读的，再多也不会有人往下翻，且一次拉完省掉分页交互。
const PREVIEW_LIMIT = 20_000;

/// 取一篇知识库文档的正文（点开会话里的引用时用）。
///
/// 走的是主进程自己的 MCP 通道，与 agent 会话完全无关——用户点一下引用不该
/// 也不能触发一次 agent 回合。
export async function readKnowledgeDoc(input: {
  sourceId: string;
  relPath: string;
}): Promise<KnowledgeDocResult> {
  const { structured, errorText } = await withKnowledgeTool<{
    fileName?: string;
    sourceId?: string;
    relPath?: string;
    text?: string;
    totalRunes?: number;
    hasMore?: boolean;
    note?: string;
  }>("kb_read_doc", {
    sourceId: input.sourceId,
    relPath: input.relPath,
    limit: PREVIEW_LIMIT,
  });
  if (!structured) return { ok: false, message: errorText ?? "读取失败" };
  return {
    ok: true,
    fileName: structured.fileName,
    sourceId: structured.sourceId ?? input.sourceId,
    relPath: structured.relPath ?? input.relPath,
    text: structured.text ?? "",
    totalRunes: structured.totalRunes,
    hasMore: structured.hasMore,
    note: structured.note,
  };
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
