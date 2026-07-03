// 回复历史的纯逻辑层：数据模型 + 追加/截断规则。落盘由 main 侧 history-store.ts 负责。
//
// KTD8 边界修订（经用户确认）：历史条目包含对话原文与全部候选草稿，明文存本地
// ~/.cortex-desktop/reply/history.json——受 replySettings.historyEnabled 开关门控（默认开），
// 且被设置页「数据清理」覆盖。除该文件外对话原文仍不落任何其它盘（调试记录维持内存态）。

import type { ReplyStance } from "./stance";

/// 历史条目里的单条候选草稿（含决策点立场，非决策候选为 null）。
export interface ReplyHistoryCandidate {
  text: string;
  stance: ReplyStance | null;
}

/// 一条回复历史 = 一次「已采纳写回」的草稿会话存档。
/// 只记采纳成功的会话（esc 关掉的不记），故无需 accepted 标记。
export interface ReplyHistoryEntry {
  id: string;
  /// 写回成功时刻（epoch ms）。
  ts: number;
  appName: string;
  appBundleId: string;
  /// 对方名（窗口标题解析，IM 下常为空串）。
  counterpart: string;
  /// 捕获重建的对话文稿（「我：/对方：」分说话人）。
  conversation: string;
  /// 当轮全部候选草稿（含翻牌追加的）。
  candidates: ReplyHistoryCandidate[];
  /// 被采纳候选在 candidates 中的下标。
  acceptedIndex: number;
  /// 被采纳的正文（冗余存一份，读历史时无需按下标解引用）。
  acceptedText: string;
}

/// 历史保留上限：与 automation-runs 的 DEFAULT_KEEP_RUNS 对齐（200 条磁盘占用可控）。
export const HISTORY_KEEP = 200;

/// 追加一条历史（纯函数）：最新在前 + 按 id 去重（重复写入安全）+ 截断到 keep。
export function appendHistoryEntry(
  entries: readonly ReplyHistoryEntry[],
  entry: ReplyHistoryEntry,
  keep = HISTORY_KEEP,
): ReplyHistoryEntry[] {
  const deduped = [entry, ...entries.filter((e) => e.id !== entry.id)];
  return deduped.slice(0, keep);
}

const VALID_STANCES: readonly string[] = ["agree", "reject", "unsure"];

/// 宽松取字符串字段（缺失/非字符串归空串）。
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/// 归一化磁盘事件 JSON → ReplyHistoryEntry。兼容两种 schema（源文件可直接拷入 events 目录使用）：
///   1. 本项目事件：id + ts(number) + 结构化 candidates;
///   2. Reply.app 源事件：id + at(ISO 时间) + appBundleID / insertedText / pickedIndex /
///      contextPreview / candidates(string[])——字段逐一映射,counterpart 源无此概念归空串。
/// 无法识别（缺 id / 缺时间 / 时间非法）返回 null,由调用方跳过。
export function normalizeHistoryEvent(raw: unknown): ReplyHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;

  // 本项目 schema：ts 为毫秒数。
  if (typeof r.ts === "number") {
    const candidates = Array.isArray(r.candidates)
      ? r.candidates
          .filter((c): c is { text: string; stance?: unknown } =>
            !!c && typeof (c as { text?: unknown }).text === "string",
          )
          .map((c) => ({
            text: c.text,
            stance: (typeof c.stance === "string" && VALID_STANCES.includes(c.stance)
              ? c.stance
              : null) as ReplyStance | null,
          }))
      : [];
    return {
      id: r.id,
      ts: r.ts,
      appName: str(r.appName),
      appBundleId: str(r.appBundleId),
      counterpart: str(r.counterpart),
      conversation: str(r.conversation),
      candidates,
      acceptedIndex: typeof r.acceptedIndex === "number" ? r.acceptedIndex : 0,
      acceptedText: str(r.acceptedText),
    };
  }

  // Reply.app 源 schema：at 为 ISO 时间字符串。
  if (typeof r.at === "string") {
    const ts = Date.parse(r.at);
    if (Number.isNaN(ts)) return null;
    const candidates = Array.isArray(r.candidates)
      ? r.candidates
          .filter((c): c is string => typeof c === "string")
          .map((text) => ({ text, stance: null as ReplyStance | null }))
      : [];
    const acceptedIndex = typeof r.pickedIndex === "number" ? r.pickedIndex : 0;
    return {
      id: r.id,
      ts,
      appName: str(r.appName),
      appBundleId: str(r.appBundleID),
      counterpart: "",
      conversation: str(r.contextPreview),
      candidates,
      acceptedIndex,
      acceptedText: str(r.insertedText) || candidates[acceptedIndex]?.text || "",
    };
  }

  return null;
}
