// Loop 工作流 MCP server（U14）：把 enabled && callableByAgent 的工作流暴露为
// list_workflows / run_workflow 两个 MCP 工具，供 claude/codex agent 在会话中调用。
//
// 架构复用：完全对照 capabilities/media-gen/server.ts 的范式——
//   - 经 createMcpHost('cortex-loop-workflows') 工厂起独立实例（独立 port/token）。
//   - per-session Map<sessionId, SessionState>：每个 agent session 各持独立 cwd，
//     多并发 session 互不干扰。
//   - buildLoopWorkflowsMcpServerConfig 返回注入配置；无 callable workflow 时返回 null。
//
// 安全决定（Open Questions 已闭合）：
//   run_workflow 不暴露 workspace_root 覆盖参数。工作区取自 session 的 cwd（由 cli.ts
//   在启动 agent 时从 req.cwd 注入）。理由：
//     1. 若允许 AI 自行传 workspace_root，任意路径注入即可读写 agent 无权访问的目录；
//     2. session cwd 已经是用户选定的合法工作区，无需 AI 端再指定；
//     3. 与 media-gen server 的 cwd 来源保持一致（也从 sessionStateMap 取，不接受覆盖）。
//
// gate 逻辑：若当前无任何 enabled && callableByAgent 的工作流，
//   buildLoopWorkflowsMcpServerConfig 返回 null，不注入（避免给 agent 无工具的 server）。

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle, type ToolContext } from "../mcp-host/server";
import type { McpServerConfig } from "../../ipc/types";
// 仅取类型：避免在模块顶层 eager 引入 workflow/index → scheduler（electron.powerMonitor），
// 否则 ipc/cli.ts（及经它的 ask/pty）的测试 electron mock 会因缺 powerMonitor 而加载失败。
// 运行时实例在 run_workflow handler 内按需动态 import。
import type { getWorkflowRuntime } from "../../workflow/index";
import { loadWorkflows } from "../../workflow/store";
import type { WorkflowDef, WorkflowManualTriggerConfig } from "../../workflow/types";

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（见 mcp-config.isValidServerId）。
export const LOOP_WORKFLOWS_SERVER_ID = "cortex-loop-workflows";

// Loop 工作流 MCP host 实例（独立 port/token，与浏览器/文档抽取/媒体生成互不干扰）。
const loopWorkflowsHost = createMcpHost(LOOP_WORKFLOWS_SERVER_ID);

// ── 并发会话状态（session-scoped，解决多会话竞态） ─────────────────────────────
//
// 并发约定：token 是 host 级共享，但 cwd 是 per-session 的。
// 多个并发 session 各自调用 buildLoopWorkflowsMcpServerConfig（不同 cwd），
// 必须按 sessionId 存储，而非用全局变量覆盖——后者会导致后来的 session
// 覆盖前一 session 的 cwd，使 run_workflow 跑到错误工作区。
//
// per-request McpServer 注册时从 sessionStateMap.get(ctx.sessionId) 取本 session 的 cwd；
// host 级 token 仍共享（认证），session 级 cwd 独立（隔离）。

interface SessionState {
  cwd: string;
}

const sessionStateMap = new Map<string, SessionState>();

export function registerLoopWorkflowsSession(sessionId: string, cwd: string): void {
  // 幂等：同一 session 多轮 run 时用新 cwd 刷新（实际上同会话 cwd 通常不变）；
  // 清理时调 unregisterLoopWorkflowsSession，不影响此处覆盖写。
  sessionStateMap.set(sessionId, { cwd });
}

export function unregisterLoopWorkflowsSession(sessionId: string): void {
  sessionStateMap.delete(sessionId);
}

// ── 构造结构化工具结果 ────────────────────────────────────────────────────────

// 工具失败时返回带 isError 标志的结果，让 agent 程序化判断失败态。
// 对照 media-gen/server.ts 的同名函数，保持一致（内联，因 media-gen 未导出）。
function makeErrorResult(message: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

// 工具成功时返回可读文本 + 可选结构化数据（json 字段供 agent 程序化提取）。
function makeSuccessResult(
  text: string,
  data?: Record<string, unknown>,
): { content: [{ type: "text"; text: string }] } {
  const fullText = data ? `${text}\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: "text", text: fullText }] };
}

// ── 工具注册 ─────────────────────────────────────────────────────────────────

/**
 * 注册 list_workflows 和 run_workflow 两个工具。
 *
 * 并发安全：此函数在 per-request McpServer 新建时调用（非全局单例），
 * cwd 参数来自 sessionStateMap.get(ctx.sessionId)，保证每个 session 使用
 * 自己的工作区路径，互不干扰。
 */
export function registerLoopWorkflowsTools(mcp: McpServer, ctx: ToolContext): void {
  // ── list_workflows ──────────────────────────────────────────────────────────
  mcp.registerTool(
    "list_workflows",
    {
      description:
        "列出当前可被 AI 调用的工作流（enabled 且 callableByAgent 的），" +
        "返回每个工作流的 id、名称、描述与输入参数 schema。" +
        "获取列表后可用 run_workflow 工具触发执行。",
      inputSchema: {},
    },
    async () => {
      let workflows: WorkflowDef[];
      try {
        workflows = await loadWorkflows();
      } catch (e) {
        return makeErrorResult(`list_workflows 错误：读取工作流列表失败 —— ${String(e)}`);
      }

      // 仅返回 enabled && callableByAgent 的工作流（callableByAgent gate）。
      const callable = workflows.filter((w) => w.enabled && w.callableByAgent);

      if (callable.length === 0) {
        return makeSuccessResult("当前没有可被 AI 调用的工作流。", { workflows: [] });
      }

      // 从 manual-trigger 节点提取 inputSchema（该节点定义了运行一次时的输入字段）。
      const items = callable.map((w) => {
        const manualNode = w.nodes.find((n) => n.type === "manual-trigger");
        // manual-trigger 节点的 config.inputSchema 为 WorkflowInputField[] 数组；
        // 转为 key→{ type, required, label } 映射方便 AI 理解输入结构。
        const rawSchema = manualNode
          ? (manualNode.config as WorkflowManualTriggerConfig).inputSchema
          : undefined;
        const inputSchema: Record<string, { type: string; required: boolean; label: string }> = {};
        if (rawSchema) {
          for (const field of rawSchema) {
            inputSchema[field.key] = { type: field.type, required: field.required, label: field.label };
          }
        }
        return {
          id: w.id,
          name: w.name,
          inputSchema,
        };
      });

      const summary = items.map((i) => `- ${i.name} (id: ${i.id})`).join("\n");
      return makeSuccessResult(`找到 ${items.length} 个可调用工作流：\n${summary}`, { workflows: items });
    },
  );

  // ── run_workflow ────────────────────────────────────────────────────────────
  mcp.registerTool(
    "run_workflow",
    {
      description:
        "按 workflow_id 执行指定工作流，等待执行完成后返回结果。" +
        "仅允许执行 enabled 且 callableByAgent 的工作流。" +
        "inputs 为可选的键值对，对应工作流 manual-trigger 节点定义的输入字段。",
      inputSchema: {
        workflow_id: z.string().min(1).describe("工作流 ID（来自 list_workflows 返回的 id 字段）"),
        inputs: z.record(z.string(), z.unknown()).optional().describe("输入参数（键值对，对应工作流的输入字段定义）"),
      },
    },
    async ({ workflow_id, inputs }: { workflow_id: string; inputs?: Record<string, unknown> }) => {
      // 从 per-session 状态获取 cwd，避免跨 session 数据泄漏。
      // 安全约束：不接受 AI 传入的 workspace_root 覆盖——cwd 由主进程在启动 agent 时
      // 从 req.cwd 注入（用户选定的合法工作区），AI 端无法篡改为任意路径。
      const sessionState = ctx.sessionId ? sessionStateMap.get(ctx.sessionId) : undefined;
      const sessionCwd = sessionState?.cwd;

      // 读取工作流列表，校验 callableByAgent（双重门控：buildConfig 时已 gate，
      // 但工作流可能在 agent 会话期间被改为 non-callable，故调用时再次检查）。
      let workflows: WorkflowDef[];
      try {
        workflows = await loadWorkflows();
      } catch (e) {
        return makeErrorResult(`run_workflow 错误：读取工作流列表失败 —— ${String(e)}`);
      }

      const workflow = workflows.find((w) => w.id === workflow_id);
      if (!workflow) {
        return makeErrorResult(`run_workflow 错误：工作流 "${workflow_id}" 不存在。请先用 list_workflows 获取可用工作流。`);
      }

      // callableByAgent 硬检：非 callable 的 id 直接拒绝（安全边界）。
      if (!workflow.enabled || !workflow.callableByAgent) {
        return makeErrorResult(
          `run_workflow 错误：工作流 "${workflow.name}" 不允许被 AI 调用（需同时启用「已启用」与「AI 可调用」开关）。`,
        );
      }

      // 调用运行时执行工作流，同步等待完成（MCP tool 须同步返回结果）。
      // sessionCwd 优先；若 session 未注册（极少发生），运行时会取全局工作区或 homedir 兜底。
      let runtime: ReturnType<typeof getWorkflowRuntime>;
      try {
        // 动态 import：断开顶层 eager 链（见文件头 import type 注释）。
        const { getWorkflowRuntime } = await import("../../workflow/index");
        runtime = getWorkflowRuntime();
      } catch (e) {
        return makeErrorResult(`run_workflow 错误：工作流运行时未初始化 —— ${String(e)}`);
      }

      try {
        const result = await runtime.runForTool(workflow_id, inputs ?? {}, sessionCwd);
        if (!result.ok) {
          return makeErrorResult(`run_workflow 执行失败：${result.error ?? "未知错误"}`);
        }

        // 构造可读摘要 + 结构化输出，让 agent 既能读懂文本也能程序化提取。
        const outputData = result.output
          ? { text: result.output.text ?? "", json: result.output.json }
          : undefined;
        const textSummary = result.output?.text
          ? `工作流「${workflow.name}」执行完成。\n输出：${result.output.text}`
          : `工作流「${workflow.name}」执行完成。`;

        return makeSuccessResult(textSummary, outputData ? { output: outputData } : undefined);
      } catch (e) {
        return makeErrorResult(`run_workflow 执行异常：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

// ── host 生命周期 ─────────────────────────────────────────────────────────────

/**
 * 启动 loop 工作流 MCP host（index.ts 在 whenReady 调用）。
 *
 * per-request McpServer 在每次 HTTP 请求时新建，注册回调从 sessionStateMap 取
 * 本 session 的 cwd；各 session 互不干扰（并发安全）。
 */
export function startLoopWorkflowsHost(): Promise<McpHostHandle> {
  return loopWorkflowsHost.start((mcp, ctx) => {
    registerLoopWorkflowsTools(mcp, ctx);
  });
}

export function stopLoopWorkflowsHost(): void {
  loopWorkflowsHost.stop();
}

export function getLoopWorkflowsHostHandle(): McpHostHandle | null {
  return loopWorkflowsHost.getHandle();
}

// ── 注入配置构建 ──────────────────────────────────────────────────────────────

/**
 * 构建 loop 工作流 MCP server 的注入配置。
 *
 * gate 逻辑：
 *   - 无任何 enabled && callableByAgent 的工作流 → 返回 null（不注入，
 *     避免给 agent 一个无意义工具的 server）。
 *   - 至少一个可调用工作流 → 注入，token 经 Authorization 头（不进 URL）。
 *
 * 并发安全：本函数把 (sessionId → { cwd }) 存入 sessionStateMap，
 * 而非写全局变量。多个并发 session 各自持有独立 cwd，per-request McpServer
 * 按 ctx.sessionId 查取本 session 的 cwd，不会互相覆盖。
 *
 * @param workflows 当前工作流列表（由 cli.ts 从 loadWorkflows() 读取后传入）
 * @param sessionId 当前 agent session id
 * @param cwd       当前工作区根目录（来自 cli:start 请求的 req.cwd）
 */
export function buildLoopWorkflowsMcpServerConfig(
  workflows: WorkflowDef[],
  sessionId: string | undefined,
  cwd: string,
): McpServerConfig | null {
  // gate：无任何 enabled && callableByAgent 工作流 → 不注入。
  const hasCallable = workflows.some((w) => w.enabled && w.callableByAgent);
  if (!hasCallable) return null;

  const handle = getLoopWorkflowsHostHandle();
  // host 未起或不可用 → 不注入，避免 agent 连接失败。
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;

  // 注册 per-session 状态（cwd）。
  // 幂等：同一 session 多轮 run 时覆盖写，不影响同 session 下一轮；
  // 清理由 unregisterLoopWorkflowsSession（cli.ts onExit）负责。
  if (sessionId) {
    registerLoopWorkflowsSession(sessionId, cwd);
  }

  return {
    id: LOOP_WORKFLOWS_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      ...(sessionId ? { "X-Cortex-Session": sessionId } : {}),
    },
  };
}
