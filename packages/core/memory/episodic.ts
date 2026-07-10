// 情景记忆采样的纯逻辑层：从已落盘的会话历史（chats/<sessionId>.json 的消息数组）中
// 选出「尚未消化」的部分，抽取正文文本、按预算截断，产出喂给做梦 prompt 的 episodes。
// 文件系统遍历在 main 侧 memory/episodic-source.ts，此处只做纯函数（就近 vitest 单测）。

import type { DreamSources } from "./memory";

/// main 侧读盘后交给采样的单会话输入。messages 对本模块半透明（按需窄化字段）。
export interface EpisodicSessionInput {
  sessionId: string;
  /// 会话标题（来自 personal-workspace.json 的 SessionMeta，可缺失）。
  title?: string;
  /// 最近活动时刻（排序用；缺失按 0 处理排最后）。
  lastActivity?: number;
  messages: unknown[];
}

/// 一段可供做梦消化的会话情景：抽取后的对话行（「用户：」/「助手：」前缀）。
export interface EpisodeSample {
  sessionId: string;
  title?: string;
  lines: string[];
}

/// 采样预算（做梦一次消化的上限，防 prompt 爆炸）。
export interface EpisodicBudget {
  /// 一次最多消化的会话数。
  maxSessions: number;
  /// 单会话正文字符上限（超出截尾，保留最近的行）。
  maxCharsPerSession: number;
  /// 全部会话合计字符上限。
  maxTotalChars: number;
}

export const DEFAULT_EPISODIC_BUDGET: EpisodicBudget = {
  maxSessions: 12,
  maxCharsPerSession: 1600,
  maxTotalChars: 8000,
};

// 消息结构的最小窄化视图（真源 core/types Message，联合判别键 kind；此处按 unknown 防御解析,
// 使 main 侧读到的旧版/异形消息不致抛错——异形条目直接忽略）。
interface TextLikeMessage {
  kind?: unknown;
  who?: unknown;
  text?: unknown;
}

/// RichText → 纯文本：string 原样；{kind:"rich",parts} 取各 part 的 v 拼接；其余返回空串。
function richTextToPlain(text: unknown): string {
  if (typeof text === "string") return text;
  if (text && typeof text === "object" && Array.isArray((text as { parts?: unknown }).parts)) {
    return ((text as { parts: Array<{ v?: unknown }> }).parts)
      .map((part) => (typeof part?.v === "string" ? part.v : ""))
      .join("");
  }
  return "";
}

/// 从消息数组抽取对话正文行：只取 kind==="text" 的消息（用户侧 who==="me" 标「用户：」，
/// 其余标「助手：」），过滤 typing/reasoning/tool/agentLog 等过程噪音与空白行。
export function extractEpisodeLines(messages: unknown[]): string[] {
  const lines: string[] = [];
  for (const raw of messages) {
    const msg = raw as TextLikeMessage;
    if (!msg || msg.kind !== "text") continue;
    const body = richTextToPlain(msg.text).trim();
    if (body.length === 0) continue;
    const speaker = msg.who === "me" ? "用户" : "助手";
    lines.push(`${speaker}：${body}`);
  }
  return lines;
}

/// 判断会话是否有未消化的新消息（messages 总数超过已记录水位）。
export function hasUndigestedMessages(input: EpisodicSessionInput, sources: DreamSources): boolean {
  const digested = sources[input.sessionId]?.digestedMsgCount ?? 0;
  return input.messages.length > digested;
}

/// 行数组按字符预算截尾：超出预算时**保留最近的行**（情景记忆里越新的越有价值），
/// 从尾部向前累计，装不下的旧行丢弃。
function clipLinesToBudget(lines: string[], maxChars: number): string[] {
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // +1 计入换行符
    if (total + line.length + 1 > maxChars && kept.length > 0) break;
    kept.unshift(line);
    total += line.length + 1;
    if (total >= maxChars) break;
  }
  return kept;
}

/// 采样结果：episodes（喂 prompt）+ watermarks（做梦成功后应推进到的新水位）。
export interface EpisodicSampleResult {
  episodes: EpisodeSample[];
  /// sessionId → 采样时刻的消息总数。仅在做梦成功后由主进程写回 dream-state，
  /// 失败不写——同一批内容下次重试（幂等合并语义由 dream prompt 保证）。
  watermarks: Record<string, number>;
}

/// 从全部会话中选出未消化的部分并按预算采样：
///   1) 过滤出有新消息的会话，按最近活动降序取前 maxSessions 个；
///   2) 每会话只取水位之后的**新增**消息（增量消化），抽正文行、按单会话预算截尾；
///   3) 合计字符超总预算时停止纳入后续会话（下次做梦再消化，不丢失——水位只记已纳入的）。
export function sampleUndigestedEpisodes(
  inputs: EpisodicSessionInput[],
  sources: DreamSources,
  budget: EpisodicBudget = DEFAULT_EPISODIC_BUDGET,
): EpisodicSampleResult {
  const fresh = inputs
    .filter((input) => hasUndigestedMessages(input, sources))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .slice(0, budget.maxSessions);

  const episodes: EpisodeSample[] = [];
  const watermarks: Record<string, number> = {};
  let totalChars = 0;

  for (const input of fresh) {
    const remaining = budget.maxTotalChars - totalChars;
    if (remaining <= 0) break;
    const digested = sources[input.sessionId]?.digestedMsgCount ?? 0;
    // 只消化水位之后的新增消息（增量语义）；水位异常大于当前长度时按全量兜底。
    const newMessages = digested < input.messages.length ? input.messages.slice(digested) : input.messages;
    const lines = clipLinesToBudget(
      extractEpisodeLines(newMessages),
      Math.min(budget.maxCharsPerSession, remaining),
    );
    if (lines.length === 0) {
      // 新增消息全是过程噪音（无正文）：水位照常推进，避免每次做梦都重扫这段空内容。
      watermarks[input.sessionId] = input.messages.length;
      continue;
    }
    const cost = lines.reduce((sum, line) => sum + line.length + 1, 0);
    // clipLinesToBudget 有「保底一行」语义,单行超预算仍会保留——首个会话例外放行
    // (保证至少消化一段),后续会话装不下则停止纳入(水位不推进,下次做梦再消化)。
    if (cost > remaining && episodes.length > 0) break;
    episodes.push({ sessionId: input.sessionId, title: input.title, lines });
    watermarks[input.sessionId] = input.messages.length;
    totalChars += cost;
  }

  return { episodes, watermarks };
}
