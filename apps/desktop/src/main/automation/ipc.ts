// 自动化 IPC handlers：**只做传输层适配**，领域逻辑全在 service.ts（与 MCP 工具共用同一份，
// 见该文件头注释）。create/update/setEnabled 返回含算好 nextRunAt 的完整 meta;runNow 立即触发并
// 返回初始 run（执行在后台,完成经 automation:run-event 推送）。

import { ipcMain } from "electron";
import type { AutomationInput } from "../ipc/types";
import { validateCron } from "./schedule-cron";
import {
  createAutomation,
  deleteAutomation,
  runAutomationNow,
  setAutomationEnabled,
  updateAutomation,
} from "./service";
import { deleteRun, loadAutomations, loadRuns } from "./store";

export function registerAutomationHandlers(): void {
  ipcMain.handle("automation:list", () => loadAutomations());

  // 经 UI 创建 → createdBy 省略（视为 user）；MCP 路径会显式传 "agent"。
  ipcMain.handle("automation:create", (_e, input: AutomationInput) => createAutomation(input));

  ipcMain.handle("automation:update", (_e, id: string, patch: Partial<AutomationInput>) =>
    updateAutomation(id, patch),
  );

  ipcMain.handle("automation:setEnabled", (_e, id: string, enabled: boolean) =>
    setAutomationEnabled(id, enabled),
  );

  ipcMain.handle("automation:delete", (_e, id: string) => deleteAutomation(id));

  ipcMain.handle("automation:runNow", (_e, id: string) => runAutomationNow(id));

  ipcMain.handle("automation:listRuns", (_e, id: string) => loadRuns(id));

  // 删除单条运行记录。只动该自动化的历史文件,不影响 meta,故无需 broadcastChanged;
  // renderer 侧靠 mutation 乐观更新对账缓存。
  ipcMain.handle("automation:deleteRun", (_e, id: string, runId: string) => deleteRun(id, runId));

  ipcMain.handle("automation:validateCron", (_e, expression: string, timezone?: string) =>
    validateCron(expression, timezone),
  );
}
