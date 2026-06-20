// 自动化 IPC handlers。main 是 owner:校验 + 持久化 + 调度 + 广播。
// create/update/setEnabled 返回含算好 nextRunAt 的完整 meta;runNow 立即触发并
// 返回初始 run（执行在后台,完成经 automation:run-event 推送）。

import { ipcMain } from "electron";
import type { AutomationInput, AutomationMeta } from "../ipc/types";
import { broadcastChanged } from "./events";
import { runAutomation } from "./runner";
import { computeNextRun, validateCron, validateScheduleSpec } from "./schedule-cron";
import { scheduleOne, unschedule } from "./scheduler";
import {
  deleteAutomationStore,
  deleteRun,
  getAutomation,
  loadAutomations,
  loadRuns,
  newAutomationId,
  patchAutomation,
  upsertAutomation,
} from "./store";

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function registerAutomationHandlers(): void {
  ipcMain.handle("automation:list", () => loadAutomations());

  ipcMain.handle("automation:create", async (_e, input: AutomationInput) => {
    const v = validateScheduleSpec(input.schedule);
    if (!v.ok) throw new Error(v.error ?? "定时规则无效");
    const now = Date.now();
    const timezone = input.timezone ?? localTimezone();
    const enabled = input.enabled ?? true;
    const meta: AutomationMeta = {
      id: newAutomationId(),
      name: input.name,
      enabled,
      projectId: input.projectId,
      cwd: input.cwd,
      agent: input.agent,
      model: input.model,
      effort: input.effort,
      prompt: input.prompt,
      useOwnSkills: input.useOwnSkills,
      providerId: input.providerId,
      schedule: input.schedule,
      timezone,
      createdAt: now,
      updatedAt: now,
      nextRunAt: enabled ? (computeNextRun(input.schedule, timezone) ?? undefined) : undefined,
    };
    await upsertAutomation(meta);
    scheduleOne(meta);
    broadcastChanged(await loadAutomations());
    return meta;
  });

  ipcMain.handle("automation:update", async (_e, id: string, patch: Partial<AutomationInput>) => {
    const existing = await getAutomation(id);
    if (!existing) return null;
    if (patch.schedule) {
      const v = validateScheduleSpec(patch.schedule);
      if (!v.ok) throw new Error(v.error ?? "定时规则无效");
    }
    const merged: AutomationMeta = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    merged.nextRunAt = merged.enabled
      ? (computeNextRun(merged.schedule, merged.timezone) ?? undefined)
      : undefined;
    await upsertAutomation(merged);
    scheduleOne(merged);
    broadcastChanged(await loadAutomations());
    return merged;
  });

  ipcMain.handle("automation:setEnabled", async (_e, id: string, enabled: boolean) => {
    const existing = await getAutomation(id);
    if (!existing) return null;
    const nextRunAt = enabled
      ? (computeNextRun(existing.schedule, existing.timezone) ?? undefined)
      : undefined;
    const updated = await patchAutomation(id, { enabled, nextRunAt });
    if (updated) scheduleOne(updated);
    broadcastChanged(await loadAutomations());
    return updated;
  });

  ipcMain.handle("automation:delete", async (_e, id: string) => {
    unschedule(id);
    await deleteAutomationStore(id);
    broadcastChanged(await loadAutomations());
  });

  ipcMain.handle("automation:runNow", async (_e, id: string) => {
    const meta = await getAutomation(id);
    if (!meta) return null;
    return runAutomation(meta, "manual");
  });

  ipcMain.handle("automation:listRuns", (_e, id: string) => loadRuns(id));

  // 删除单条运行记录。只动该自动化的历史文件,不影响 meta,故无需 broadcastChanged;
  // renderer 侧靠 mutation 乐观更新对账缓存。
  ipcMain.handle("automation:deleteRun", (_e, id: string, runId: string) => deleteRun(id, runId));

  ipcMain.handle("automation:validateCron", (_e, expression: string, timezone?: string) =>
    validateCron(expression, timezone),
  );
}
