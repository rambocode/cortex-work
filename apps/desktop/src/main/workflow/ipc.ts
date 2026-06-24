// 工作流 IPC handlers（workflow:* 频道）。
// 对齐 automation/ipc.ts 的风格：校验 → 持久化 → 调度 → 广播。
// main 是 owner，渲染层只通过这里读写；入参校验拒绝格式错误的请求。
//
// ── 划分说明 ──────────────────────────────────────────────────────────────────
// 「现在就实现」：store 支撑的 CRUD + validateCron（U2 已落地）。
// 「运行时占位」：引擎（U8）/MCP（U14）/DSL（U15）才能完整接线的 handler 已注册
//   但 body 抛明确错误，避免渲染层收到「no handler」的静默失败。

import { ipcMain } from "electron";
import { validateCron } from "../automation/schedule-cron";
import { broadcastWorkflowChanged } from "./events";
import {
  deleteRun,
  deleteWorkflow,
  getWorkflow,
  loadRuns,
  loadWorkflows,
  newWorkflowId,
  patchWorkflow,
  upsertWorkflow,
} from "./store";
import { normalizeWorkflow } from "./normalize";
import type { WorkflowDef } from "./types";
import { getWorkflowRuntime } from "./index";

// ── 帮助函数 ──────────────────────────────────────────────────────────────────

function assertId(id: unknown, label = "id"): string {
  if (typeof id !== "string" || !id) throw new Error(`workflow IPC: ${label} 不能为空`);
  return id;
}

// ── 完整实现（store 支撑）的 handlers ────────────────────────────────────────

export function registerWorkflowHandlers(): void {
  // 列表快照（无参数，直接返回缓存）。
  ipcMain.handle("workflow:list", () => loadWorkflows());

  // 创建工作流：normalize → 分配 id + 时间戳 → 持久化 → 广播。
  ipcMain.handle("workflow:create", async (_e, input: Partial<WorkflowDef>) => {
    const now = new Date().toISOString();
    // normalize 负责枚举校正、数值钳制；id/时间字段由主进程分配，不信任 renderer 传入。
    const def = normalizeWorkflow(
      {
        ...input,
        id: newWorkflowId(),
        createdAt: now,
        updatedAt: now,
      },
      0,
      now,
    );
    await upsertWorkflow(def);
    broadcastWorkflowChanged(await loadWorkflows());
    return def;
  });

  // 全量更新（字段级合并由 renderer 组装，server 侧只做 normalize + 时间戳 + 持久化）。
  ipcMain.handle("workflow:update", async (_e, id: string, patch: Partial<WorkflowDef>) => {
    assertId(id);
    const existing = await getWorkflow(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const merged = normalizeWorkflow({ ...existing, ...patch, id: existing.id, updatedAt: now }, 0, now);
    await upsertWorkflow(merged);
    broadcastWorkflowChanged(await loadWorkflows());
    return merged;
  });

  // 切换启用状态（patch 最小字段 + 广播）。
  ipcMain.handle("workflow:setEnabled", async (_e, id: string, enabled: boolean) => {
    assertId(id);
    const updated = await patchWorkflow(id, { enabled });
    if (updated) broadcastWorkflowChanged(await loadWorkflows());
    return updated;
  });

  // 切换 AI 可调用标记（patch 最小字段 + 广播；MCP 服务在 U14 监听此变化刷新工具列表）。
  ipcMain.handle("workflow:setCallableByAgent", async (_e, id: string, callableByAgent: boolean) => {
    assertId(id);
    const updated = await patchWorkflow(id, { callableByAgent });
    if (updated) broadcastWorkflowChanged(await loadWorkflows());
    return updated;
  });

  // 删除工作流（含运行历史文件，由 deleteWorkflow 负责清理）。
  ipcMain.handle("workflow:delete", async (_e, id: string) => {
    assertId(id);
    await deleteWorkflow(id);
    broadcastWorkflowChanged(await loadWorkflows());
  });

  // 列出单个工作流的运行历史。
  ipcMain.handle("workflow:listRuns", (_e, id: string) => {
    assertId(id);
    return loadRuns(id);
  });

  // 删除单条运行记录（只动历史文件，不影响工作流 meta，无需广播 changed）。
  ipcMain.handle("workflow:deleteRun", (_e, id: string, runId: string) => {
    assertId(id);
    assertId(runId, "runId");
    return deleteRun(id, runId);
  });

  // cron 表达式即时校验（复用 automation/schedule-cron.ts 的 validateCron）。
  // ScheduleEditor 在用户输入时调用，主进程校验结果为真相源。
  ipcMain.handle("workflow:validateCron", (_e, expression: string, timezone?: string) =>
    validateCron(expression, timezone),
  );

  // ── 运行时占位 handlers（U8/U9/U14/U15 完整接线）────────────────────────────
  // 这些频道已注册，渲染层调用时得到明确错误而非「no handler registered」。
  // 引擎接线完成后替换 body 实现，删除此注释即可。

  // 立即触发一次运行（fire-and-forget：立即返回 running run，执行在后台进行）。
  ipcMain.handle("workflow:runNow", (_e, id: string, input: Record<string, unknown> = {}) => {
    assertId(id);
    return getWorkflowRuntime().runNow(id, "manual", input);
  });

  // 停止正在运行的 run（cancel + 级联拒绝 pending approvals + kill AI 进程）。
  ipcMain.handle("workflow:stop", (_e, _id: string, runId: string) => {
    assertId(runId, "runId");
    getWorkflowRuntime().stopRun(runId);
  });

  // 单节点运行（画布「运行节点」按钮；返回该节点的 output payload）。
  ipcMain.handle("workflow:node:run", (_e, workflowId: string, nodeId: string, input: unknown) => {
    assertId(workflowId);
    assertId(nodeId, "nodeId");
    const payload =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as { json?: unknown; text?: string })
        : { json: input, text: "" };
    return getWorkflowRuntime().runSingleNode(workflowId, nodeId, {
      json: payload.json ?? null,
      text: typeof payload.text === "string" ? payload.text : "",
    });
  });

  // 单节点测试（配置面板「测试」按钮；同 node:run，alias）。
  ipcMain.handle("workflow:node:test", (_e, workflowId: string, nodeId: string, input: unknown) => {
    assertId(workflowId);
    assertId(nodeId, "nodeId");
    const payload =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as { json?: unknown; text?: string })
        : { json: input, text: "" };
    return getWorkflowRuntime().runSingleNode(workflowId, nodeId, {
      json: payload.json ?? null,
      text: typeof payload.text === "string" ? payload.text : "",
    });
  });

  // human-approval 节点 resolve（approved/rejected → 唤醒挂起节点）。
  // RunContext.pendingApprovals Map 由 stop + 此 handler 双路 resolve（R11）。
  ipcMain.handle("workflow:approval:resolve", (_e, runId: string, decision: "approved" | "rejected") => {
    assertId(runId, "runId");
    if (decision !== "approved" && decision !== "rejected") {
      throw new Error("decision 只能是 'approved' 或 'rejected'");
    }
    // 从 activeRuns 取 ctx，遍历 pendingApprovals 找到对应 runId 的 approval。
    // human-approval 节点把自己的 resolve 注册进 ctx.pendingApprovals（key=approvalId）；
    // 这里以 runId 作为 approvalId（flow-control.ts 的约定，U10 实现）。
    const runtime = getWorkflowRuntime();
    // 直接调 stopRun 的 pendingApprovals.resolve（需要 runtime 暴露 resolveApproval）。
    // U10 实现的 human-approval 节点用 approvalId=runId+nodeId 注册；
    // 此处先广播 decision，由 resolveApproval 内部按 decision 分发。
    // 简化实现：approval decision 通过 IPC 发给所有正在等待此 runId 的节点。
    void runtime; // 占位：U10 flow-control.ts 已实现 pendingApprovals；handler 在 stop 时遍历
    // 真正的 resolve 路径：flow-control.ts 的 executeHumanApproval 已注册到 ctx.pendingApprovals，
    // ipc handler 需要找到对应 ctx。由于 pendingApprovals key 为 approvalId（nodeId+runId），
    // 此处遍历所有 activeRuns 找到含该 runId 的 ctx，resolve 其 pendingApprovals。
    // 注：getWorkflowRuntime 无法暴露 activeRuns，故此处用 import 方式访问内部状态。
    // 此占位将在 U10 完善时替换（activeRuns 结构已定义，只需导出 resolveApproval 工具函数）。
    throw new Error("workflow:approval:resolve 的 approvalId 映射待 U10 flow-control 完善后接线（RunContext.pendingApprovals 已就绪）");
  });

  // 从 DSL JSON 导入工作流（需 DSL 解析校验 U15）。
  ipcMain.handle("workflow:import", (_e, _dsl: unknown) => {
    throw new Error("workflow:import 尚未接线（待 U15 实现 DSL 导入后替换）");
  });

  // 导出工作流为 DSL JSON（需 secret 脱敏逻辑 U15）。
  ipcMain.handle("workflow:export", (_e, _id: string) => {
    throw new Error("workflow:export 尚未接线（待 U15 实现 DSL 导出后替换）");
  });
}
