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

  // 立即触发一次运行（需图执行引擎 U8 + 调度器 U9）。
  ipcMain.handle("workflow:runNow", (_e, _id: string) => {
    throw new Error("workflow:runNow 尚未接线（待 U9 实现图执行引擎后替换）");
  });

  // 停止正在运行的 run（需引擎 abort 信号 U8/U9）。
  ipcMain.handle("workflow:stop", (_e, _id: string, _runId: string) => {
    throw new Error("workflow:stop 尚未接线（待 U9 实现引擎 abort 后替换）");
  });

  // 单节点运行（画布「运行节点」按钮，需引擎单节点沙箱 U8）。
  ipcMain.handle("workflow:node:run", (_e, _workflowId: string, _nodeId: string, _input: unknown) => {
    throw new Error("workflow:node:run 尚未接线（待 U8 实现单节点执行后替换）");
  });

  // 单节点测试（配置面板「测试」按钮，同上依赖 U8）。
  ipcMain.handle("workflow:node:test", (_e, _workflowId: string, _nodeId: string, _input: unknown) => {
    throw new Error("workflow:node:test 尚未接线（待 U8 实现单节点沙箱后替换）");
  });

  // human-approval 节点挂起/resolve（需引擎挂起队列 U10/U8）。
  ipcMain.handle("workflow:approval:resolve", (_e, _runId: string, _decision: "approved" | "rejected") => {
    throw new Error("workflow:approval:resolve 尚未接线（待 U10 实现 human-approval 节点后替换）");
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
