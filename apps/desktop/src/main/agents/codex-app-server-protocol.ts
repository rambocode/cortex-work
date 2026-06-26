// codex app-server 协议类型(精炼子集)。
//
// 这是 `codex app-server generate-ts` 官方类型的**手工精炼子集** —— 只保留本项目 ws 传输实际
// 使用的方法、参数、通知形状(完整 89 文件的生成类型见 spike 留档,不入库以免 1200 行/维护负担)。
// 实测版本:codex-cli 0.142.2(2026-06-26 spike)。跨进程契约,改动需对照 generate-ts 重新核对。
//
// on-the-wire 约定(实测):JSON-RPC **省略 `jsonrpc` 字段**。
//   请求:  { method, id, params }
//   通知:  { method, params }            ← 无 id
//   响应:  { id, result } | { id, error } ← 有 id

/** thread/start 的 sandbox 取值(SandboxMode,实测为字符串枚举)。 */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** approvalPolicy 取值(AskForApproval 的常用子集);本项目恒用 "never"。 */
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

/** turn/start 输入项(UserInput 子集:文本与本地图片)。 */
export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

/** 出站请求方法名(本项目使用的)。 */
export type CodexRequestMethod =
  | "initialize"
  | "thread/start"
  | "thread/resume"
  | "turn/start"
  | "turn/interrupt";

/** 出站请求帧(省略 jsonrpc)。 */
export interface CodexRequestFrame {
  method: CodexRequestMethod;
  id: number;
  params: unknown;
}

/** 出站通知帧(无 id,如 initialized)。 */
export interface CodexNotifyFrame {
  method: string;
  params: unknown;
}

/** 入站消息:响应(有 id)或通知(有 method 无 id)。解析端按有无 id 区分。 */
export interface CodexResponseFrame {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string } | string;
}
export interface CodexNotificationFrame {
  method: string;
  params?: unknown;
}

// ── 我方消费的通知 params 形状(防御性,字段尽量可选) ──────────────────────────

/** thread/start 响应 result。threadId = thread.id(= sessionId)。 */
export interface ThreadStartResult {
  thread?: { id?: string; sessionId?: string; path?: string };
}

/** turn/start 响应 result。 */
export interface TurnStartResult {
  turn?: { id?: string; status?: string };
}

/** item/agentMessage/delta 通知:流式文本增量。itemId 用于查 phase(commentary/final_answer)。 */
export interface AgentMessageDeltaParams {
  itemId?: string;
  delta?: string;
  text?: string;
}

/** item/reasoning/summaryTextDelta | item/reasoning/textDelta 通知:推理摘要/原文增量。 */
export interface ReasoningDeltaParams {
  itemId?: string;
  delta?: string;
}

/** item/started | item/completed 通知。item.type 决定是工具还是 agentMessage 等。 */
export interface ItemNotificationParams {
  item?: CodexItem;
  threadId?: string;
  turnId?: string;
}
export interface CodexItem {
  type?: string; // userMessage | agentMessage | reasoning | commandExecution | fileChange | mcpToolCall | webSearch ...
  id?: string;
  text?: string; // agentMessage 完成时的最终文本
  phase?: string; // agentMessage: "commentary" | "final_answer"
  // command_execution / 工具项常见字段(尽力取 detail)
  command?: string;
  path?: string;
  query?: string;
  server?: string;
  tool?: string;
}

/** thread/tokenUsage/updated 通知:token 嵌套在 tokenUsage.total 下。 */
export interface TokenUsageParams {
  threadId?: string;
  turnId?: string;
  tokenUsage?: {
    total?: {
      totalTokens?: number;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
    };
  };
}

/** turn/completed 通知:turn.status 决定成败。 */
export interface TurnCompletedParams {
  threadId?: string;
  turn?: { id?: string; status?: string; error?: unknown };
  error?: unknown;
}

/** error 通知。 */
export interface ErrorNotificationParams {
  message?: string;
  code?: number | string;
}

// ── 通知方法名常量(避免散落字符串) ──────────────────────────────────────────
export const CODEX_NOTIF = {
  threadStarted: "thread/started",
  agentMessageDelta: "item/agentMessage/delta",
  reasoningSummaryDelta: "item/reasoning/summaryTextDelta",
  reasoningTextDelta: "item/reasoning/textDelta",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  tokenUsage: "thread/tokenUsage/updated",
  turnCompleted: "turn/completed",
  error: "error",
} as const;
