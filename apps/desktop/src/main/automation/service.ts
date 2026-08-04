// 自动化领域层：校验 + 持久化 + 调度 + 广播的四联动，是 IPC 与 MCP 两条入口的**唯一真源**。
//
// 为什么要有这一层：create 的正确语义是「校验 schedule → 补 timezone/nextRunAt → upsert →
// scheduleOne → broadcastChanged」四步缺一不可。若第二个调用方（capabilities/automation 的 MCP
// 工具）自己重抄一遍，最容易漏掉的是 scheduleOne —— 后果是「任务建好了、列表里也看得见，但永远
// 不触发」，且完全静默，要等用户发现某天早上没收到日报才暴露。上提到本文件后两侧共享同一份实现，
// 结构上不可能漂。
//
// 本层不含 IPC/MCP 任何传输细节，只吃领域类型（AutomationInput / AutomationMeta），便于单测。

import type { AutomationInput, AutomationMeta, AutomationRun } from "../ipc/types";
import { broadcastChanged } from "./events";
import { runAutomation } from "./runner";
import { computeNextRun, validateScheduleSpec } from "./schedule-cron";
import { scheduleOne, unschedule } from "./scheduler";
import {
  deleteAutomationStore,
  getAutomation,
  loadAutomations,
  newAutomationId,
  patchAutomation,
  upsertAutomation,
} from "./store";

/** 取本机 IANA 时区；Intl 不可用时退回 UTC（croner 接受 UTC）。 */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * 新建一条自动化。schedule 非法直接抛错（错误文案来自 validateScheduleSpec，面向用户/模型可读）。
 *
 * createdBy 标记来源：MCP 工具建的传 "agent"，UI 建的省略（视为 user）。用于列表角标，让用户能
 * 一眼审计「哪些定时任务是 AI 替我建的」。
 */
export async function createAutomation(
  input: AutomationInput,
  createdBy: AutomationMeta["createdBy"] = undefined,
): Promise<AutomationMeta> {
  const v = validateScheduleSpec(input.schedule);
  if (!v.ok) throw new Error(v.error ?? "定时规则无效");
  const now = Date.now();
  const timezone = input.timezone ?? localTimezone();
  const enabled = input.enabled ?? true;
  // ⚠️ 逐字段构造（不用 ...input 展开）：AutomationMeta 有 id/createdAt 等 input 没有的字段，
  // 展开会把 input 里的多余键原样带进落盘数据。代价是新增字段必须在这里显式补一行 ——
  // notifyChannels 曾因漏补而在 create 路径静默丢失（update 走 ...patch 自动透传，掩盖了问题）。
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
    notifyChannels: input.notifyChannels,
    providerId: input.providerId,
    schedule: input.schedule,
    timezone,
    createdBy,
    createdAt: now,
    updatedAt: now,
    nextRunAt: enabled ? (computeNextRun(input.schedule, timezone) ?? undefined) : undefined,
  };
  await upsertAutomation(meta);
  scheduleOne(meta);
  broadcastChanged(await loadAutomations());
  return meta;
}

/**
 * 修改一条自动化；id 不存在返回 null。
 *
 * schedule 是**整体替换**语义（不做字段级 patch）：调用方要么不传 schedule，要么传一个完整的
 * ScheduleSpec。nextRunAt 每次按合并后的 schedule + timezone 重算，避免旧值残留导致列表显示
 * 与实际触发时刻不符。
 */
export async function updateAutomation(
  id: string,
  patch: Partial<AutomationInput>,
): Promise<AutomationMeta | null> {
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
}

/** 启用/暂停。停用时清空 nextRunAt，避免列表显示「已暂停却有下次运行时间」的歧义态。 */
export async function setAutomationEnabled(
  id: string,
  enabled: boolean,
): Promise<AutomationMeta | null> {
  const existing = await getAutomation(id);
  if (!existing) return null;
  const nextRunAt = enabled
    ? (computeNextRun(existing.schedule, existing.timezone) ?? undefined)
    : undefined;
  const updated = await patchAutomation(id, { enabled, nextRunAt });
  if (updated) scheduleOne(updated);
  broadcastChanged(await loadAutomations());
  return updated;
}

/** 删除：先摘调度（否则已建的 croner job 会在文件删掉后继续触发），再删配置与运行历史。 */
export async function deleteAutomation(id: string): Promise<void> {
  unschedule(id);
  await deleteAutomationStore(id);
  broadcastChanged(await loadAutomations());
}

/**
 * 立即触发一次；id 不存在返回 null。
 *
 * 注意返回的是**初始 run**（status 通常为 "running"），执行在后台继续，最终结果经
 * automation:run-event 的 phase:"end" 推送。并发去重命中时返回的是 status:"skipped" 的终态。
 */
export async function runAutomationNow(id: string): Promise<AutomationRun | null> {
  const meta = await getAutomation(id);
  if (!meta) return null;
  return runAutomation(meta, "manual");
}
