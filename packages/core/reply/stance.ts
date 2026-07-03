// 快捷回复候选的「立场」纯逻辑：类型、渲染标签映射、模型输出标记行解析。
// 协议约定（与 prompt-builder 的 SYSTEM_PROMPT 配套）：模型在输出首行给出机器可读标记
// `[stance:agree|reject|unsure|none]`，正文从次行起。枚举 key 用英文保证跨语言对话稳定，
// 中文标签只在气泡渲染端经 REPLY_STANCE_LABELS 映射。

/** 候选立场三档：同意 / 拒绝 / 不确定（需先追问关键信息）。 */
export type ReplyStance = "agree" | "reject" | "unsure";

/** 立场 → 气泡 chip 中文标签（渲染端唯一映射源，勿在 UI 内重复硬编码）。 */
export const REPLY_STANCE_LABELS: Record<ReplyStance, string> = {
  agree: "同意",
  reject: "拒绝",
  unsure: "不确定",
};

/** parseStanceLine 的解析结果：stance 为 null 表示非决策点（`none` / 标记缺失均归一为 null）。 */
export interface ParsedStance {
  stance: ReplyStance | null;
  /** 剥掉标记行后的回复正文（未做进一步清洗，调用方自行处理引号等外壳）。 */
  body: string;
}

// 标记行容错，两条通路（只匹配文本开头/首行，避免把正文里偶然出现的同形片段误剥）：
//   1) 带 `stance:` 前缀：值**任意**都剥掉（实测模型会自造 `[stance:question]` 之类协议外值，
//      不剥会漏进正文首行）——已知别名归一化，未知值降级为 null（无 chip）；
//   2) 裸方括号缩写（`[none]` / `[question]` / `[同意]`）：只认已知别名——IM 正文常以
//      `[抱拳]` 类中文表情开头，中文裸标记只认四个词，任意值剥除会误伤真实内容。
// 大小写、半/全角冒号与方括号、括号内外空白均容错。
const STANCE_LINE_RE =
  /^\s*[[【]\s*(?:stance\s*[:：]\s*([a-z_\-一-鿿]+)|(agree|accept|reject|decline|refuse|unsure|uncertain|question|ask|clarify|none|同意|拒绝|不确定|无))\s*[\]】]\s*/i;

// 标记别名 → 归一化立场（none/无 归一为 null，即非决策点）。question/ask 等「追问」语义
// 的自造值归入 unsure（与协议 unsure=先问关键问题一致）。
const STANCE_ALIASES: Record<string, ReplyStance | null> = {
  agree: "agree",
  accept: "agree",
  reject: "reject",
  decline: "reject",
  refuse: "reject",
  unsure: "unsure",
  uncertain: "unsure",
  question: "unsure",
  ask: "unsure",
  clarify: "unsure",
  none: null,
  同意: "agree",
  拒绝: "reject",
  不确定: "unsure",
  无: null,
};

/**
 * 从模型输出开头剥离立场标记行：返回归一化立场与剩余正文。
 * 模型漏输出标记（小模型不遵守协议）→ stance 为 null、正文原样返回——宽松降级，不报错。
 */
export function parseStanceLine(text: string): ParsedStance {
  const match = text.match(STANCE_LINE_RE);
  if (!match) return { stance: null, body: text };
  // 捕获组二选一命中（带前缀任意值 / 裸缩写已知值）；?? 兜底仅满足 noUncheckedIndexedAccess。
  const key = (match[1] ?? match[2] ?? "none").toLowerCase();
  return {
    stance: STANCE_ALIASES[key] ?? null,
    body: text.slice(match[0].length),
  };
}
