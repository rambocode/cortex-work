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
  if (initRes.status === 404) return "地址不对：该服务上没有 /api/mcp 端点（404）";
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

/// tools/call 的结果投影：优先取结构化输出（服务端的工具都声明了 output schema）。
export interface ToolCallResult<T> {
  structured: T | null;
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
  if (result.isError) {
    const text = result.content?.map((c) => c.text ?? "").join("\n").trim();
    return { structured: null, errorText: text || "知识库返回了一个错误" };
  }
  return { structured: result.structuredContent ?? null };
}

/// 便捷组合：解析端点 → 握手 → 调工具。失败一律返回面向用户的一句话。
export async function withKnowledgeTool<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult<T>> {
  const ep = await resolveKnowledgeEndpoint();
  if (typeof ep === "string") return { structured: null, errorText: ep };
  try {
    const session = await openKnowledgeSession(ep);
    if (typeof session === "string") return { structured: null, errorText: session };
    return await callKnowledgeTool<T>(session, name, args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`知识库工具 ${name} 调用失败: ${msg}`);
    return { structured: null, errorText: `无法连接知识库：${msg}` };
  }
}
