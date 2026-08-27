// 主进程侧的极简知识库 MCP 客户端。
//
// **为什么主进程自己也要连一次 MCP**：agent 会话里的 kb_* 工具是 agent 直连远端的，
// 主进程看不到内容。但「点开引用文档看正文」这类**产品自身**的能力（不经 agent）
// 需要主进程能自己取文，故在这里实现一条独立、极简的调用通道。
//
// 只实现「握手 + 单次 tools/call」，不做长连接与会话复用：
// 调用频次是人点一下的量级，握手成本（一次额外往返）远低于维护连接生命周期的复杂度。
//
// 与 preload 里的 pi-mcp-bridge 是两回事：那个是给 pi 用的工具代理，跑在 agent 侧。
import { safeStorage } from "electron";

import { createLogger } from "../../log";
import { getPersistedState } from "../../ipc/store";
import { normalizeKnowledgeBaseUrl } from "./inject";
import {
  cacheKnowledgeCapabilities,
  getCachedKnowledgeCapabilities,
  renderKnowledgeToolsBlock,
  type KnowledgeCapabilities,
  type KnowledgeToolInfo,
} from "./tools";

const log = createLogger("knowledge-client");

const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 15_000;

/// 已解析出的连接信息（地址 + 明文令牌）。令牌只在主进程内存里短暂存在，不外传。
interface Endpoint {
  url: string;
  token: string;
}

/// 从持久化设置里解出可用的端点。返回字符串表示失败原因（面向用户的一句话）。
export async function resolveKnowledgeEndpoint(): Promise<Endpoint | string> {
  const settings = (await getPersistedState()).generalSettings?.knowledgeBase;
  if (!settings?.baseUrl?.trim()) return "请先在 设置 → 知识库 中填写知识库地址";
  const url = normalizeKnowledgeBaseUrl(settings.baseUrl);
  if (!settings.encryptedToken) return "请先在 设置 → 知识库 中填写 MCP 令牌";
  try {
    if (!safeStorage.isEncryptionAvailable()) return "系统密钥库不可用，无法读取已保存的令牌";
    const token = safeStorage.decryptString(Buffer.from(settings.encryptedToken, "base64"));
    return { url, token };
  } catch {
    return "已保存的令牌无法解密，请在设置中重新填写";
  }
}

function baseHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // MCP 的 Streamable HTTP 要求客户端同时接受 JSON 与 SSE 两种响应，
    // 少了这个头部分服务端实现直接回 4xx。
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
}

/// 从响应体里取出 JSON-RPC 结果。服务端可能回纯 JSON，也可能回 SSE 帧（`event:` / `data:` 行），
/// 两种都要认——只按 JSON 解析会在 SSE 模式下静默失败。
export function parseRpcResult<T>(body: string): T | null {
  const payloads = body.includes("data:")
    ? body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
    : [body];
  for (const p of payloads) {
    if (!p) continue;
    try {
      const parsed = JSON.parse(p) as { result?: T };
      if (parsed.result !== undefined) return parsed.result;
    } catch {
      /* 非 JSON 帧（SSE 的 event: 行等）跳过 */
    }
  }
  return null;
}

/// 一个已完成握手的 MCP 会话：拿着它就能发 tools/call。
export interface McpSession {
  url: string;
  headers: Record<string, string>;
}

/// 完成 MCP 三步握手（initialize → 取 session id → notifications/initialized）。
///
/// 第三步的通知不能省：不发它，服务端会拒掉后续所有请求并回
/// 「method ... is invalid during session initialization」。
export async function openKnowledgeSession(ep: Endpoint): Promise<McpSession | string> {
  const headers = baseHeaders(ep.token);
  const initRes = await fetch(ep.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "cortex-desktop", version: "1" },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (initRes.status === 401) return "令牌无效或已吊销（401）";
  // 404 / 405 都是「路径不对」：405 常见于前置 nginx —— 路径不存在但静态规则不允许 POST，
  // 于是回 Method Not Allowed 而非 404。把端点原样回显出来，用户才知道实际请求打到了哪儿。
  if (initRes.status === 404 || initRes.status === 405) {
    return `地址不对：${ep.url} 上没有 MCP 端点（HTTP ${initRes.status}）。请确认地址是否需要带路径，如 /mcp`;
  }
  if (!initRes.ok) return `连接失败：HTTP ${initRes.status}`;

  const sessionId = initRes.headers.get("mcp-session-id");
  await initRes.text(); // 必须消费响应体，否则连接不释放
  const sessionHeaders = {
    ...headers,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    // 无状态实现不签发 session id；此时不带该头即可，其余流程一致。
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  if (sessionId) {
    await fetch(ep.url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).then((r) => r.text());
  }
  return { url: ep.url, headers: sessionHeaders };
}

/// tools/call 的结果投影。
///
/// `structured` 与 `text` 都要留着：声明了 output schema 的服务端给 structuredContent，
/// 而**很多第三方 MCP server 只回 content 文本**（实测某企业 wiki 的十个工具全都没有
/// outputSchema）。只认结构化输出的话，这类服务端的正文会被静默丢成 null。
export interface ToolCallResult<T> {
  structured: T | null;
  /// content 里的纯文本拼接。structured 缺失时由调用方作正文兜底。
  text?: string;
  /// 工具以错误形式返回时的可读文本（MCP 把工具错误打包进 content 而非协议错误）。
  errorText?: string;
}

/// 调一个知识库 MCP 工具。
export async function callKnowledgeTool<T>(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult<T>> {
  const res = await fetch(session.url, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.text();
  const result = parseRpcResult<{
    structuredContent?: T;
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  }>(body);
  if (!result) {
    log.warn(`知识库工具 ${name} 无法解析响应`);
    return { structured: null, errorText: "服务端返回了无法解析的响应" };
  }
  // 工具错误（如路径非法、文档不存在）走 isError + content，不是协议层错误。
  const text = result.content?.map((c) => c.text ?? "").join("\n").trim();
  if (result.isError) {
    return { structured: null, errorText: text || "知识库返回了一个错误" };
  }
  return { structured: result.structuredContent ?? null, text: text || undefined };
}

// ── 能力探测（tools/list）────────────────────────────────────────────────
//
// 探测与「测试连接」是同一次网络往返：用户点一下测试，顺带把能力快照灌进缓存，
// 于是下一轮会话启动时注入侧能同步读到。分成两次调用只会让用户多等一次。

/// 跑一次 tools/list 并把结果映射成能力快照写入缓存。
/// 失败返回面向用户的一句话（与本文件其它函数的错误约定一致）。
export async function probeKnowledgeCapabilities(): Promise<KnowledgeCapabilities | string> {
  const ep = await resolveKnowledgeEndpoint();
  if (typeof ep === "string") return ep;
  try {
    const session = await openKnowledgeSession(ep);
    if (typeof session === "string") return session;
    const res = await fetch(session.url, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const result = parseRpcResult<{ tools?: KnowledgeToolInfo[] }>(await res.text());
    const tools = (result?.tools ?? []).filter((t) => t?.name);
    return cacheKnowledgeCapabilities(ep.url, ep.token, tools);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`知识库能力探测失败: ${msg}`);
    return `无法连接：${msg}`;
  }
}

/// 供注入侧使用的能力快照：**只读缓存，绝不发起网络请求**。
///
/// 注入跑在会话启动的关键路径上，那里等一次跨网络的 tools/list 会把「起一轮对话」的延迟
/// 绑死在知识库服务的健康度上。没缓存就这轮不注入能力块（MCP 工具本身照常可用），
/// 同时后台预热一次，下一轮即可用。
export function getKnowledgeCapabilitiesCached(url: string, token: string): KnowledgeCapabilities | null {
  return getCachedKnowledgeCapabilities(url, token);
}

/// 后台预热（不阻塞调用方，失败只记日志）。保存配置成功后与注入未命中缓存时调用。
export function primeKnowledgeCapabilities(): void {
  void probeKnowledgeCapabilities().then((r) => {
    if (typeof r === "string") log.debug(`知识库能力预热未成功：${r}`);
  });
}

/// 构造注入会话系统提示的知识库能力块；不该注入或暂无能力快照时返回空串。
///
/// **这是「工具动态注册」的对外入口**（cli.ts 与 pi-session.ts 各调一次）。返回的正文里
/// 列的是服务端 tools/list 的真实方法名，而非任何写死的约定名。
///
/// 三种情况返回空串，调用方一律按「不追加」处理：
///   1. 知识库总开关关着；
///   2. 地址/令牌不可用（此时 MCP server 本身也不会被注入，块自然无意义）；
///   3. **能力快照还没探测到**——此时后台预热一次，下一轮就有了。
///      这一条是刻意的取舍：注入跑在会话启动的关键路径上，在这里等一次跨网络的
///      tools/list，等于把「起一轮对话」的延迟绑死在知识库服务的健康度上。少一段
///      用法指引只是模型少点策略提示，MCP 工具本身照常可用；卡住启动则是真事故。
export async function buildKnowledgeSystemPromptBlock(): Promise<string> {
  const settings = (await getPersistedState()).generalSettings?.knowledgeBase;
  if (!settings?.enabled) return "";
  const ep = await resolveKnowledgeEndpoint();
  if (typeof ep === "string") return "";
  const caps = getCachedKnowledgeCapabilities(ep.url, ep.token);
  if (!caps) {
    primeKnowledgeCapabilities();
    return "";
  }
  return renderKnowledgeToolsBlock(caps);
}
