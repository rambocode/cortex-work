// 分身调用审计（U6/U16）：拥有者读自己分身的调用记录。走 React Query（服务端态硬约定），
// query key 含 wsId（切 workspace 不串场），enabled 仅在 apiClient 存在时（真实后端在线）。
// 纯 query options + 展示纯函数（终态标签 / 用量摘要），供 AvatarAuditSection 与单测共用。

import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";
import type { AvatarAuditRecord, AvatarAuditResponse } from "../api/types";
import type { AvatarSessionOutcome } from "../desktop/avatar-types";

// 审计列表 60s 内视为新鲜（审计非高频，避免频繁重拉）。
const auditStaleTime = 60 * 1000;

export const avatarAuditKeys = {
  all: (wsId: string) => ["avatar-audit", wsId] as const,
  list: (wsId: string, runtimeId?: string) =>
    [...avatarAuditKeys.all(wsId), "list", runtimeId ?? null] as const,
};

// 审计列表 query options。runtimeId 可选（不传 = 该拥有者全部分身的记录）。
// enabled 双闸：apiClient 存在（真实后端）+ wsId 非空。
export function avatarAuditListOptions(
  wsId: string,
  api?: ApiClient | null,
  runtimeId?: string,
) {
  return queryOptions({
    queryKey: avatarAuditKeys.list(wsId, runtimeId),
    queryFn: (): Promise<AvatarAuditResponse> => api!.listAvatarAudit({ runtime_id: runtimeId }),
    enabled: !!api && !!wsId,
    staleTime: auditStaleTime,
  });
}

// 终态 → 拥有者视角中文标签（无终态即进行中）。与 §1 的 8 值终态集对齐。
// 导出以便 avatar-sessions（W3 会话列表）复用同一套终态文案，避免两处漂移。
export const OUTCOME_LABELS: Record<AvatarSessionOutcome, string> = {
  done: "已完成",
  unanswerable: "无法回答",
  rejected_quota: "超限拒绝",
  rejected_approval: "审批拒绝",
  timeout_approval: "审批超时",
  canceled: "已取消",
  interrupted: "执行中断",
  failed: "执行失败",
};

// 审计一行的展示摘要（终态标签 + 用量文本 + 问题摘要），纯函数便于单测。
// 记录 action 三态：invocation（受理）/ finished（终态）/ rejected（受理即拒）。
export interface AvatarAuditRow {
  id: string;
  callerName: string;
  createdAt: string;
  promptSummary: string;
  outcomeLabel: string;
  usageLabel: string;
}

// 问题摘要：截断到 max 字符（默认 60），超出加省略号——审计列表不铺全文。
// prompt 可空防御：历史 finished/rejected 记录的 details 可能不带 prompt（服务端
// 后补了落 prompt，但旧行仍在），空值显示「—」而不是崩溃。
export function summarizePrompt(prompt: string | null | undefined, max = 60): string {
  const s = (prompt ?? "").trim();
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 用量摘要：有 token 计数则「入 X · 出 Y」，否则「—」（尚无用量或非终态）。
// details 整体可空防御（异常/历史数据）。
export function summarizeUsage(details: AvatarAuditRecord["details"] | null | undefined): string {
  const inTok = details?.input_tokens;
  const outTok = details?.output_tokens;
  if (inTok == null && outTok == null) return "—";
  return `入 ${inTok ?? 0} · 出 ${outTok ?? 0}`;
}

// 单条审计记录 → 展示行。action=rejected 时终态标签固定「超限拒绝」（受理即拒，无 outcome）。
export function toAuditRow(rec: AvatarAuditRecord): AvatarAuditRow {
  const outcome = rec.details.outcome;
  let outcomeLabel: string;
  if (rec.action === "avatar.invocation.rejected") {
    outcomeLabel = OUTCOME_LABELS.rejected_quota;
  } else if (outcome) {
    outcomeLabel = OUTCOME_LABELS[outcome] ?? outcome;
  } else {
    outcomeLabel = "进行中";
  }
  return {
    id: rec.id,
    callerName: rec.caller_name || rec.actor_id.slice(0, 8),
    createdAt: rec.created_at,
    promptSummary: summarizePrompt(rec.details.prompt),
    outcomeLabel,
    usageLabel: summarizeUsage(rec.details),
  };
}

// 列表映射：只保留「有终态呈现价值」的记录——finished / rejected（受理条 invocation 是中间态，
// 与 finished 重复，列表只展示结果行，避免每次调用出现两行）。
export function toAuditRows(records: AvatarAuditRecord[]): AvatarAuditRow[] {
  return records
    .filter((r) => r.action === "avatar.invocation.finished" || r.action === "avatar.invocation.rejected")
    .map(toAuditRow);
}
