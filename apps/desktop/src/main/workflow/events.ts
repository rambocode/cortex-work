// 工作流事件分发：main → 所有存活窗口。
// 对齐 automation/events.ts：窗口可能已关，getAllWindows() 返回 []，
// 事件丢失不影响落盘记录，renderer 重开后用 workflow:list/listRuns 补拉。

import { BrowserWindow } from "electron";
import { recordNotification } from "../ipc/notification-center";
import { NOTIFICATION_BODY_MAX } from "../ipc/notification-center-store";
import { loadWorkflows } from "./store";
import type { WorkflowDef, WorkflowRunEvent } from "./types";

/**
 * 广播全量工作流列表快照到所有存活窗口（workflow:changed 频道）。
 * 触发时机：create / update / setEnabled / setCallableByAgent / delete 任意 CRUD。
 */
export function broadcastWorkflowChanged(list: WorkflowDef[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("workflow:changed", list);
  }
}

/**
 * 广播单次运行的阶段事件（start / end）到所有存活窗口（workflow:run-event 频道）。
 * 由运行时引擎（U8/U9）在 run 开始与结束时调用；本单元（U3）不触发，仅声明契约。
 */
export function broadcastWorkflowRunEvent(event: WorkflowRunEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("workflow:run-event", event);
  }
  // 消息中心存档：终态才记。埋在广播层而不是 index.ts 的各个收尾分支——
  // 那里有 8 处 broadcastWorkflowRunEvent 调用（正常结束/出错/手动停止/审批超时…），
  // 逐处埋必然漏，而「广播了 end」正是「这次运行有结论了」的唯一口径。
  if (event.phase === "end") void archiveWorkflowRun(event);
}

// 工作流名要查库（run event 只带 workflowId），故独立成异步函数 fire-and-forget。
// 查不到名字就退回 id：宁可标题难看，也不能让存档因为一次读盘失败而丢。
async function archiveWorkflowRun(event: WorkflowRunEvent): Promise<void> {
  let name = event.workflowId;
  try {
    const list = await loadWorkflows();
    name = list.find((w) => w.id === event.workflowId)?.name ?? event.workflowId;
  } catch {
    // 读盘失败 → 用 id 兜底
  }
  const ok = event.run.status === "success";
  recordNotification({
    source: "workflow",
    level: ok ? "success" : "error",
    title: ok ? `${name} 运行完成` : `${name} 运行失败`,
    body: event.run.message?.trim().slice(0, NOTIFICATION_BODY_MAX) || undefined,
    refId: event.workflowId,
  });
}
