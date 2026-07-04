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
  runSubAgent: (label: string, prompt: string, onEvent: (ev: CliStreamEvent) => void) => Promise<DesignSubAgentResult>;
}

const sessionStateMap = new Map<string, DesignDelegateSessionState>();

export function registerDesignDelegateSession(state: DesignDelegateSessionState): void {
  sessionStateMap.set(state.sessionId, state);
}

export function unregisterDesignDelegateSession(sessionId: string): void {
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
    async ({ label, prompt }: { label: string; prompt: string; workspace?: string }): Promise<ToolResult> => {
      if (state.signal.aborted) return errorResult("已取消");
      const taskText = typeof prompt === "string" ? prompt.trim() : "";
      const jobLabel = typeof label === "string" && label.trim() ? label.trim() : "page";
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
      const result = await state.runSubAgent(jobLabel, taskText, onEvent);
      if (!result.ok) {
        return errorResult(`子任务「${jobLabel}」执行失败:${result.error ?? "未知错误"}`);
      }
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
