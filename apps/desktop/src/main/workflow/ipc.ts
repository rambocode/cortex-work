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
import { exportWorkflowDsl, parseWorkflowDsl, hasCodeNodes } from "./dsl";
import { createLogger } from "../log";

const log = createLogger("workflow-ipc");

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

  // 立即触发一次运行（fire-and-forget：立即返回初始 WorkflowRun，执行在后台进行）。
  // P1 AC-001：返回完整 WorkflowRun 而非 {ok,runId,status}，与 bridge.ts 契约一致。
  // P1 AC-003：入参支持可选 input（对应 manual-trigger inputSchema），让 UI 传值生效。
  ipcMain.handle("workflow:runNow", async (_e, id: string, input: Record<string, unknown> = {}) => {
    assertId(id);
    const result = await getWorkflowRuntime().runNow(id, "manual", input);
    // bridge 契约：workflowRunNow?(id, input?) → Promise<WorkflowRun|null>
    return result.ok ? result.run : null;
  });

  // 停止正在运行的 run（cancel + 级联拒绝 pending approvals + kill AI 进程 +
  // 强制收尾仍 running 的持久化记录，覆盖孤儿/挂起 run 让 UI 不再永久卡「运行中」）。
  // 传入 workflowId 使孤儿 run（不在 activeRuns）也能被定位收尾。
  ipcMain.handle("workflow:stop", (_e, workflowId: string, runId: string) => {
    assertId(workflowId, "workflowId");
    assertId(runId, "runId");
    return getWorkflowRuntime().stopRun(runId, workflowId);
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
  // 入参 { token, decision }：token 由 executeHumanApproval 广播到 UI，UI 持有后通过此 handler resolve。
  // P0 Fix-1：不再无条件 throw；改调 runtime.resolveApproval(token, decision)。
  ipcMain.handle("workflow:approval:resolve", (_e, token: string, decision: "approved" | "rejected") => {
    assertId(token, "token");
    if (decision !== "approved" && decision !== "rejected") {
      throw new Error("decision 只能是 'approved' 或 'rejected'");
    }
    const found = getWorkflowRuntime().resolveApproval(token, decision);
    // found=false 说明 token 已超时/被 stop 级联拒绝，属正常竞争情形，不报错。
    return { ok: found };
  });

  // 从 DSL JSON 导入工作流（U15 接线）。
  // 入参：任意 unknown（来自 renderer 解析或用户粘贴的 JSON）。
  // 流程：parseWorkflowDsl → 分配新 id → 处理重名 → upsert + 广播。
  // ADV-011 P2 Fix-15：DSL 导入节点数上限。
  // 超大 DSL（数百节点）反序列化后送进 normalizeWorkflow → runGraph 会占用大量主进程 CPU，
  // 在 Electron 单线程主进程中等同于 DoS。在解析成功后、落盘前提前拒绝。
  const DSL_IMPORT_MAX_NODES = 500;

  ipcMain.handle("workflow:import", async (_e, dsl: unknown) => {
    const now = new Date().toISOString();
    const result = parseWorkflowDsl(dsl, now);
    if (!result.ok) {
      throw new Error(`工作流 DSL 解析失败：${result.error}`);
    }

    // P2 Fix-15：节点数超上限直接拒绝，防止超大 DSL 阻塞主进程（ADV-011）。
    if (result.workflow.nodes.length > DSL_IMPORT_MAX_NODES) {
      throw new Error(
        `DSL 导入失败：节点数（${result.workflow.nodes.length}）超过上限 ${DSL_IMPORT_MAX_NODES}，` +
          `请拆分后分批导入。`,
      );
    }

    // 分配新 id（不信任 DSL 中的 id，防止与现有工作流冲突）
    const existing = await loadWorkflows();
    const newId = newWorkflowId();

    // 重名处理：若已有同名工作流，自动追加「副本」后缀
    const existingNames = new Set(existing.map((w) => w.name));
    let importName = result.workflow.name || "导入的 loop";
    if (existingNames.has(importName)) {
      importName = `${importName} 副本`;
      // 若「副本」也重名，继续追加数字序号
      let n = 2;
      while (existingNames.has(importName)) {
        importName = `${result.workflow.name || "导入的 loop"} 副本 ${n}`;
        n++;
      }
    }

    // 含 code/custom 节点时，记录到 console（安全提示由 UI 层在调用前展示）
    if (hasCodeNodes(result.workflow)) {
      log.info(`工作流「${importName}」含可执行代码节点（code/custom），已通过安全确认`);
    }

    const def = normalizeWorkflow(
      {
        ...result.workflow,
        id: newId,
        name: importName,
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

  // 导出工作流为 DSL JSON（U15 接线）。
  // 入参：工作流 id（string）。
  // 返回：WorkflowDslV1 对象（由 renderer 序列化为 JSON 文件）。
  ipcMain.handle("workflow:export", async (_e, id: string) => {
    assertId(id);
    const wf = await getWorkflow(id);
    if (!wf) throw new Error(`workflow:export 找不到 id=${id} 的工作流`);
    return exportWorkflowDsl(wf, new Date().toISOString());
  });
}
