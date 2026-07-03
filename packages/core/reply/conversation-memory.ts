// 对话级记忆的纯逻辑层：按「app + 联系人」分桶记住既往互动（最近采纳回复 + 蒸馏要点），
// 下次对同一对话起草时注入 prompt。落盘由 main 侧 conversation-store.ts 负责。
//
// 与全局 5 分区记忆（memory.ts）的关系：全局记忆管「用户怎么写」，对话记忆管「对这个人
// 该怎么写/有什么事实」。counterpart 依赖窗口标题解析，IM 下常拿不到——拿不到就不分桶
// （conversationKey 返回 null），退回全局记忆兜底；绝不只按 bundleId 分桶（会把微信全部
// 联系人混成一桶，污染注入，弊大于利）。

import type { DistillPrompt } from "./memory";

/// 一个对话桶的记忆：最近采纳回复（零成本 few-shot）+ 蒸馏要点（事实/偏好，可空）。
export interface ConversationMemory {
  appName: string;
  counterpart: string;
  /// 蒸馏产出的事实/偏好要点（`- ` 行清单；learningEnabled 开启时后台生成，失败留空）。
  summary: string;
  /// 最近 N 条已采纳回复，newest-first（无 LLM 成本，采纳即更新）。
  recentReplies: string[];
  /// 最近一次更新时刻（epoch ms），LRU 淘汰依据。
  updatedAt: number;
}

/// 全部对话桶，按 conversationKey 索引（落盘文件的 conversations 字段即此形）。
export type ConversationMemoryMap = Record<string, ConversationMemory>;

/// 每桶保留的最近采纳回复条数。
export const RECENT_REPLIES_LIMIT = 5;

/// 对话桶总数上限（与回复历史 200 对齐），超过按 updatedAt LRU 淘汰。
export const MAX_CONVERSATIONS = 200;

/// 归一化生成对话 key：`<bundleId>|<counterpart>`（均 trim + 小写）。
/// bundleId 或 counterpart 为空 → null（不分桶，见文件头取舍）。
export function conversationKey(appBundleId: string, counterpart: string): string | null {
  const bundle = appBundleId.trim().toLowerCase();
  const partner = counterpart.trim().toLowerCase();
  if (bundle.length === 0 || partner.length === 0) return null;
  return `${bundle}|${partner}`;
}

/// 追加一条采纳回复（纯函数）：newest-first；空白忽略；同文去重（提升到最新位）；超限截断。
export function appendRecentReply(
  replies: readonly string[],
  reply: string,
  limit = RECENT_REPLIES_LIMIT,
): string[] {
  const trimmed = reply.trim();
  if (trimmed.length === 0) return [...replies];
  return [trimmed, ...replies.filter((r) => r !== trimmed)].slice(0, limit);
}

/// 对话桶 LRU 裁剪：未超上限原样返回（保持引用，调用方可据此跳过落盘）；
/// 超上限按 updatedAt 降序保留最近 max 个。
export function capConversations(
  map: ConversationMemoryMap,
  max = MAX_CONVERSATIONS,
): ConversationMemoryMap {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const kept = keys
    .sort((a, b) => (map[b]?.updatedAt ?? 0) - (map[a]?.updatedAt ?? 0))
    .slice(0, max);
  const next: ConversationMemoryMap = {};
  for (const key of kept) {
    const memory = map[key];
    if (memory) next[key] = memory;
  }
  return next;
}

/// 组装注入 prompt 的对话记忆段：summary 优先（蒸馏要点信息密度高）；无 summary 时
/// 列最近采纳回复作 few-shot；两者皆空返回空串（调用方不注入该段）。
export function composeConversationMemory(memory: ConversationMemory): string {
  const summary = memory.summary.trim();
  if (summary.length > 0) {
    return `与「${memory.counterpart}」的既往互动要点（此前对话中记下的事实与偏好）：\n${summary}`;
  }
  const replies = memory.recentReplies.map((r) => r.trim()).filter((r) => r.length > 0);
  if (replies.length === 0) return "";
  const listed = replies.map((r) => `- ${r}`).join("\n");
  return `我最近发给「${memory.counterpart}」的回复（供语气与称呼参考）：\n${listed}`;
}

/// 构造「从本次对话蒸馏对话级要点」的 prompt（温度 0.2 单发，输出经 cleanDistilledRules 清洗）。
/// 与全局蒸馏（memory.buildDistillPrompt）的差异：采集目标是「关于这个对话对象的事实与
/// 相处偏好」，而非用户自身的写作风格。
export function buildConversationDistillPrompt(params: {
  appName: string;
  counterpart: string;
  conversation: string;
  acceptedDraft: string;
  existingSummary: string;
}): DistillPrompt {
  const { appName, counterpart, conversation, acceptedDraft, existingSummary } = params;
  const system = `你是一个对话记忆整理器。根据一段对话与用户实际发出的回复,总结关于对话对象「${counterpart}」的稳定事实与相处偏好（身份/关系、正在推进的事、对方偏好、用户对其的语气习惯）。
要求：
- 只输出要点列表,每行一条,以「- 」开头,不超过 8 条
- 只记稳定、下次回复还用得上的信息;忽略一次性的寒暄细节
- 与「已记住的要点」合并:仍然成立的保留,矛盾的以新对话为准
- 不要输出任何解释、标题或多余文字`;

  const sections: string[] = [];
  const trimmedSummary = existingSummary.trim();
  if (trimmedSummary.length > 0) {
    sections.push(`已记住的要点：\n${trimmedSummary}`);
  }
  sections.push(`应用：${appName}；对话对象：${counterpart}`);
  sections.push(`本次对话：\n${conversation}`);
  sections.push(`用户实际发出的回复：\n${acceptedDraft}`);
  return { system, user: sections.join("\n\n") };
}
