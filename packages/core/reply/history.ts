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
