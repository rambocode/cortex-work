// 设计委派（design-delegate）MCP host：给「设计工作台」的多页并行生成回合提供一个通用的
// `delegate_task` 工具，让父设计 agent 一轮内并行派发 N 个子 agent、每个子 agent 负责写一页。
//
// 与 capabilities/delegate（role-based `ask_<id>`）的区别：
//   · delegate 是「本轮被 @ 的协作者」→ 每协作者一个 ask_<id>，MAX_CALLS_PER_ROLE 护栏。
//   · 本模块是「通用任务派发」→ 单个 `delegate_task({ label, prompt })`，子 agent 用**父 agent 同款**
//     底层 agent、fresh sessionId spawn，跑任意 prompt。这对齐移植自 Kun 的并行页面 prompt（它要求
//     agent 用 delegate_task 逐页 fanout，每个 label=page:<artifactId> 供画布回映每页进度）。
//
// 复用 createMcpHost + runSubAgent 回调（由 cli.ts 注入）；防递归同 delegate：子 agent 用 fresh
// sessionId 且不注册本 session → 子 agent 取不到 state → 无 delegate_task 工具 → 无法再派发。
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle } from "../mcp-host/server";
import type { McpServerConfig, CliStreamEvent } from "../../ipc/types";

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（codex -c mcp_servers.<id>）。
export const DESIGN_DELEGATE_SERVER_ID = "cortex-design-delegate";

// 一轮内 delegate_task 调用总次数上限：防父 agent 失控狂派子 agent（对齐 delegate 的资源护栏，
// 但设计多页可能有较多页，放宽到 12）。
const MAX_DELEGATE_CALLS = 12;
const MAX_DELEGATE_LABEL_CHARS = 256;
const MAX_DELEGATE_PROMPT_CHARS = 32_000;
const MAX_EMBEDDED_BASE64_CHARS = 12 * 1024 * 1024;
const designDelegateHost = createMcpHost(DESIGN_DELEGATE_SERVER_ID);
let hostStartPromise: Promise<McpHostHandle> | null = null;

// 子 agent 一次执行的结果。
export interface DesignSubAgentResult {
  text: string;
  ok: boolean;
  error?: string;
}

// per-session 运行时状态（由 cli.ts cli:start 构造并注册；含运行时回调）。
export interface DesignDelegateSessionState {
  sessionId: string;
  runId: string;
  signal: AbortSignal;
  abort: () => void;
  // 把子 agent 事件推渲染端（cli.ts 内部 = sender.send("cli:event", ...)）。
  pushEvent: (ev: CliStreamEvent) => void;
  // 喂主进程 inactivity 看门狗（长子任务期间父 agent 静默会被误杀）。
  bumpWatchdog: () => void;
  // 本轮已派发次数（护栏）。
  callCount: { n: number };
  // cli.ts 注入：以「父 agent 同款底层 agent」spawn 子 agent 执行 prompt。label 作为子 agent 的
  // roleId/stageLabel 透传（page:<artifactId>），供渲染端/画布把子 agent 进度回映到对应页。
  runSubAgent: (
    label: string,
    prompt: string,
    onEvent: (ev: CliStreamEvent) => void,
    signal?: AbortSignal,
  ) => Promise<DesignSubAgentResult>;
}

const sessionStateMap = new Map<string, DesignDelegateSessionState>();

export function registerDesignDelegateSession(state: DesignDelegateSessionState): void {
  sessionStateMap.set(state.sessionId, state);
}

export function unregisterDesignDelegateSession(
  sessionId: string,
  expectedState?: DesignDelegateSessionState,
): void {
  // 同一个父会话可以在上一轮异步收尾前启动新一轮。旧代释放时必须带上自己登记的 state，
  // 否则一个迟到的 child/abort 会把新一轮刚注册的 delegate_task 能力一并摘掉。
  // expectedState 缺省时保留 app 退出与旧调用方“按 session 强制清理”的既有语义。
  if (expectedState && sessionStateMap.get(sessionId) !== expectedState) return;
  sessionStateMap.delete(sessionId);
}

// app 退出清理：取消所有在途设计委派。
export function killAllDesignDelegates(): void {
  for (const state of sessionStateMap.values()) {
    try {
      state.abort();
    } catch {
      /* abort 异常不阻断其余清理 */
    }
  }
  sessionStateMap.clear();
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function normalizeBoundedText(value: string, options: { field: string; maxChars: number }): string | null {
  const text = value.trim();
  if (!text) return null;
  if (text.length > options.maxChars) {
    throw new Error(`${options.field} 过长(>${options.maxChars} 字符)`);
  }
  return text;
}

function validateEmbeddedBase64Length(value: string, field: string): void {
  const matches = value.matchAll(/base64,([A-Za-z0-9+/=\r\n]+)/g);
  for (const match of matches) {
    const raw = match[1]?.replace(/\s+/g, "") ?? "";
    if (raw.length > MAX_EMBEDDED_BASE64_CHARS) {
      throw new Error(`${field} 内嵌 base64 过长(>${MAX_EMBEDDED_BASE64_CHARS} 字符)`);
    }
  }
}

function emitRoleResult(state: DesignDelegateSessionState, roleId: string, ok: boolean, error?: string): void {
  state.pushEvent({ type: "result", ok, error, roleId });
}

export function createTaskLimiter(maxConcurrency: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = (): void => {
    if (active >= maxConcurrency) return;
    const start = queue.shift();
    if (!start) return;
    active += 1;
    start();
  };

  return <T>(job: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        void job()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
}

// 注册通用 delegate_task 工具。
function registerDelegateTaskTool(mcp: McpServer, state: DesignDelegateSessionState): void {
  mcp.registerTool(
    "delegate_task",
    {
      description:
        "把一页设计的生成派发给一个子 agent 并行执行。子 agent 是独立进程,看不到你当前对话的上下文——" +
        "prompt 必须自包含(要写哪个文件、设计要求等全部信息)。在同一条 assistant 消息里为每一页各调一次" +
        "本工具即可并行;每次调用返回该子 agent 的结果文本。",
      inputSchema: {
        label: z
          .string()
          .min(1)
          .describe("该子任务的标签,固定用 `page:<artifactId>` 形式,供画布把子 agent 进度回映到对应页。"),
        prompt: z
          .string()
          .min(1)
          .describe("交给子 agent 的完整、自包含的任务描述(它看不到你的对话上下文)。"),
        workspace: z.string().optional().describe("工作目录(可选;缺省用父会话 cwd)。"),
      },
    },
    async ({ label, prompt }: { label: string; prompt: string; workspace?: string }, extra): Promise<ToolResult> => {
      const signal = extra.signal === state.signal
        ? state.signal
        : AbortSignal.any([state.signal, extra.signal]);
      if (signal.aborted) return errorResult("已取消");
      let taskText = "";
      let jobLabel = "page";
      try {
        taskText =
          typeof prompt === "string"
            ? (normalizeBoundedText(prompt, { field: "prompt", maxChars: MAX_DELEGATE_PROMPT_CHARS }) ?? "")
            : "";
        jobLabel =
          typeof label === "string"
            ? (normalizeBoundedText(label, { field: "label", maxChars: MAX_DELEGATE_LABEL_CHARS }) ?? "page")
            : "page";
        validateEmbeddedBase64Length(taskText, "prompt");
      } catch (error) {
        return errorResult(`委派失败:${error instanceof Error ? error.message : String(error)}`);
      }
      if (!taskText) {
        return errorResult(`委派「${jobLabel}」失败:prompt 为空,请提供完整、自包含的任务描述。`);
      }
      if (state.callCount.n >= MAX_DELEGATE_CALLS) {
        return errorResult(`本轮 delegate_task 调用已达上限(${MAX_DELEGATE_CALLS}),请基于已有结果收尾。`);
      }
      state.callCount.n += 1;
      // 先发 init(带 roleId/stageLabel=label)插入子 agent 段,渲染端据此把该页过程独立成段、回映进度。
      state.pushEvent({ type: "init", sessionId: state.sessionId, roleId: jobLabel, stageLabel: jobLabel });
      const onEvent = (ev: CliStreamEvent) => {
        state.pushEvent(ev);
        state.bumpWatchdog();
      };
      let result: DesignSubAgentResult;
      try {
        result = await state.runSubAgent(jobLabel, taskText, onEvent, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitRoleResult(state, jobLabel, false, message);
        return errorResult(`子任务「${jobLabel}」执行失败:${message}`);
      }
      if (!result.ok) {
        emitRoleResult(state, jobLabel, false, result.error ?? "未知错误");
        return errorResult(`子任务「${jobLabel}」执行失败:${result.error ?? "未知错误"}`);
      }
      emitRoleResult(state, jobLabel, true);
      return textResult(result.text || `(子任务「${jobLabel}」未产生文本输出)`);
    },
  );
}

export function startDesignDelegateHost(): Promise<McpHostHandle> {
  if (designDelegateHost.getHandle()) return designDelegateHost.start();
  if (hostStartPromise) return hostStartPromise;
  hostStartPromise = designDelegateHost.start((mcp, ctx) => {
    const state = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
    // 取不到 state（未注册 / 子 agent 的 fresh sessionId）→ 不注册 delegate_task,只剩 ping(防递归)。
    if (!state) return;
    registerDelegateTaskTool(mcp, state);
  });
  hostStartPromise.finally(() => {
    hostStartPromise = null;
  });
  return hostStartPromise;
}

export function stopDesignDelegateHost(): void {
  hostStartPromise = null;
  designDelegateHost.stop();
}

export function getDesignDelegateHostHandle(): McpHostHandle | null {
  return designDelegateHost.getHandle();
}

// 注入配置构建(纯函数;register 由 cli.ts 单独调用)。host 未起/不可用 → null(注入侧据此不注入)。
export function buildDesignDelegateMcpServerConfig(sessionId: string | undefined): McpServerConfig | null {
  if (!sessionId) return null;
  const handle = designDelegateHost.getHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;
  return {
    id: DESIGN_DELEGATE_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "X-Cortex-Session": sessionId,
    },
  };
}

export async function ensureDesignDelegateMcpServerConfig(
  sessionId: string | undefined,
): Promise<McpServerConfig | null> {
  if (!sessionId) return null;
  let cfg = buildDesignDelegateMcpServerConfig(sessionId);
  if (cfg) return cfg;
  const handle = await startDesignDelegateHost();
  if (!handle.serverAvailable) return null;
  cfg = buildDesignDelegateMcpServerConfig(sessionId);
  return cfg;
}
