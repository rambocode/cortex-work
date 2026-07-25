// CRE 证据分块（spec §8.2、§10.4）：把抓取到的正文切成**可定位回原文**的片段。
//
// 与写作侧 markdown 分块的根本区别：这里的每一块都必须携带它在原文中的字符区间
// （startOffset/endOffset）与所处标题路径，因为报告里的每条引用最终都要能回溯到
// 「哪个文档 > 哪个章节 > 哪几个字符」。因此本模块的**核心不变量**是：
//
//     text.slice(chunk.startOffset, chunk.endOffset) === chunk.text
//
// 任何「顺手清理一下文本」的改写都会破坏这个不变量。所以正文清洗集中在
// normalizeExtractedText 里**一次性**做完，切块函数只做切分、绝不改写字符。
//
// 命名风格：TS 领域模型，camelCase。Worker 协议侧（snake_case 的 start_offset /
// heading_path，见 ./protocol）由 main 的 rpc-client 边界做转换。

/// 分块参数。默认值面向「一块≈一段可独立阅读的证据」：900 字符约等于中文 2~3 段。
export interface ChunkingOptions {
  /// 单块字符数上限；超过就在段落内强切。
  maxChars?: number;
  /// 单块字符数下限；不足此长度的碎片会并入前一块，没有前一块则丢弃。
  minChars?: number;
  /// 相邻块之间向前重叠的字符数，用于避免关键句正好被切在边界上。默认 0。
  overlapChars?: number;
}

/// 一块待入库的证据片段。offset 是**相对本次切块入参文本**的字符下标
/// （chunkPagedText 里则是相对该页文本），不是相对整篇文档。
export interface ChunkDraft {
  text: string;
  startOffset: number;
  endOffset: number;
  /// 所处的标题层级路径（由外到内）；无标题信息时为空数组。
  headingPath: string[];
  /// PDF 等分页来源的页码；非分页来源不带此字段。
  page?: number;
}

/// 标题锚点：offset 是标题行在正文中的起始下标，level 是层级（1 最外层）。
export interface HeadingAnchor {
  offset: number;
  level: number;
  title: string;
}

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_MIN_CHARS = 48;
const DEFAULT_OVERLAP_CHARS = 0;

/// 强切时优先寻找空白断点的窗口下界比例：只有落在后 40% 的空白才值得为它牺牲块长度，
/// 否则宁可硬切，避免把块切得过短。
const SOFT_BREAK_RATIO = 0.6;

/// 零宽字符（含 BOM）会污染 offset 与 hash，且对语义无贡献，统一清除。
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/// 抓取正文的一次性清洗。**必须在切块之前调用**：切块产出的 offset 语义是
/// 「相对 normalize 之后的文本」，落库时也应存 normalize 之后的正文，
/// 否则引用回溯会整体错位。
export function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(ZERO_WIDTH_RE, "")
    // 折叠行内连续空白（不含换行），把 HTML 抽取常见的大量缩进压平
    .replace(/[^\S\n]+/g, " ")
    // 去掉行首行尾空格，避免它们在后续正则里被当成内容
    .replace(/ *\n */g, "\n")
    // 3 个及以上换行（即 2 个以上空行）压成一个空行：段落边界只需要一个空行
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/// 文本中的一个半开区间。切块过程全程只传区间，最后一步才 slice 出文本，
/// 这样 offset 与 text 不可能对不上。
interface Span {
  start: number;
  end: number;
}

/// 按空行切出段落区间。返回的区间都已剔除首尾空白，且保证 start < end。
function splitParagraphSpans(text: string): Span[] {
  const spans: Span[] = [];
  const separator = /\n[^\S\n]*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const push = (start: number, end: number): void => {
    const trimmed = trimSpan(text, start, end);
    if (trimmed) spans.push(trimmed);
  };

  while ((match = separator.exec(text)) !== null) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);
  return spans;
}

/// 去掉区间两端的空白；整段皆空白时返回 null。
function trimSpan(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s += 1;
  while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
  return s < e ? { start: s, end: e } : null;
}

/// 把超长段落强切成不超过 maxChars 的单元。
/// 优先在窗口后段的空白处断开（避免劈开单词），找不到空白才硬切——中日韩正文没有词间
/// 空白，硬切是唯一选择，这也是为什么不能只靠空白断点。
function hardSplit(text: string, span: Span, maxChars: number): Span[] {
  const units: Span[] = [];
  let start = span.start;

  while (span.end - start > maxChars) {
    const windowEnd = start + maxChars;
    const softFloor = start + Math.floor(maxChars * SOFT_BREAK_RATIO);
    let cut = -1;
    for (let i = windowEnd; i > softFloor; i -= 1) {
      if (/\s/.test(text[i]!)) {
        cut = i;
        break;
      }
    }

    if (cut < 0) {
      units.push({ start, end: windowEnd });
      start = windowEnd;
      continue;
    }

    units.push({ start, end: cut });
    // 断点处的空白既不属于前块也不属于后块，直接跳过
    let next = cut;
    while (next < span.end && /\s/.test(text[next]!)) next += 1;
    start = next;
  }

  if (start < span.end) units.push({ start, end: span.end });
  return units;
}

/// 贪心地把相邻单元合并成块：只要「首单元起点 → 末单元终点」的跨度不超过 maxChars 就继续合并。
/// 用跨度而非文本长度求和，是因为块文本必须是原文的连续切片（含段落之间的换行）。
function packUnits(units: Span[], maxChars: number): Span[] {
  const packed: Span[] = [];
  let current: Span | null = null;

  for (const unit of units) {
    if (!current) {
      current = { ...unit };
      continue;
    }
    if (unit.end - current.start <= maxChars) {
      current.end = unit.end;
    } else {
      packed.push(current);
      current = { ...unit };
    }
  }
  if (current) packed.push(current);
  return packed;
}

/// 处理过短碎片：并入前一块（宁可让该块略微超过 maxChars，也不产出无法独立成立的碎片），
/// 没有前一块时直接丢弃——一个只有几个字的「文档」不具备证据价值。
function mergeShortSpans(spans: Span[], minChars: number): Span[] {
  const merged: Span[] = [];
  for (const span of spans) {
    if (span.end - span.start >= minChars) {
      merged.push({ ...span });
      continue;
    }
    const previous = merged[merged.length - 1];
    if (previous) previous.end = span.end;
  }
  return merged;
}

/// 应用重叠：把每一块（首块除外）的起点向前挪 overlapChars。
/// 只挪起点不挪终点，slice 不变量因此依旧成立，代价是块长度会超过 maxChars。
function applyOverlap(spans: Span[], overlapChars: number): Span[] {
  if (overlapChars <= 0) return spans;
  return spans.map((span, index) =>
    index === 0 ? span : { start: Math.max(0, span.start - overlapChars), end: span.end },
  );
}

/// 纯文本切块：按空行段落边界切，超长段落强切，过短碎片并入前块。
/// 产出的 headingPath 恒为空数组——标题信息由 chunkStructuredText 补。
///
/// **offset 往返一致性是引用可回溯的根基**（本模块头部的核心不变量）：
/// 返回的每一块都满足 `text.slice(startOffset, endOffset) === chunk.text`。
/// 报告里的每条引用最终要靠这对 offset 定位回原文的具体字符区间；一旦切块过程顺手改写了
/// 字符（trim、替换全角标点、补空格…），offset 就与落库正文错位，引用会指向别的句子——
/// 这是「模型没伪造引用、但引用指错地方」这类最难排查的问题的根源。
/// 因此本函数只做切分，任何清洗都必须提前在 normalizeExtractedText 里一次性完成。
export function chunkPlainText(text: string, options: ChunkingOptions = {}): ChunkDraft[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const minChars = Math.max(0, options.minChars ?? DEFAULT_MIN_CHARS);
  const overlapChars = Math.max(0, options.overlapChars ?? DEFAULT_OVERLAP_CHARS);

  const units = splitParagraphSpans(text).flatMap((span) =>
    span.end - span.start > maxChars ? hardSplit(text, span, maxChars) : [span],
  );

  const spans = applyOverlap(mergeShortSpans(packUnits(units, maxChars), minChars), overlapChars);

  return spans.map((span) => ({
    text: text.slice(span.start, span.end),
    startOffset: span.start,
    endOffset: span.end,
    headingPath: [],
  }));
}

/// 结构化正文切块：在 chunkPlainText 的基础上，为每块补上它所处的标题路径。
///
/// 定位规则：取「起点不晚于块起点」的最后一个标题，用它当时的标题栈作为路径。
/// 也就是说跨标题的块归属于它**开头**所在的章节——报告里引用定位以块起点为准。
export function chunkStructuredText(
  input: { text: string; headings: readonly HeadingAnchor[] },
  options: ChunkingOptions = {},
): ChunkDraft[] {
  const chunks = chunkPlainText(input.text, options);
  if (input.headings.length === 0) return chunks;

  // 入参 heading 可能乱序（不同抽取器行为不一致），先按 offset 排好再建栈
  const sorted = [...input.headings].sort((a, b) => a.offset - b.offset);
  const stack: HeadingAnchor[] = [];
  const snapshots: Array<{ offset: number; path: string[] }> = [];

  for (const heading of sorted) {
    // 遇到同级或更外层的标题就先出栈，保证「二级 → 三级 → 二级」不会越堆越深
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    stack.push(heading);
    snapshots.push({ offset: heading.offset, path: stack.map((item) => item.title) });
  }

  return chunks.map((chunk) => {
    let path: string[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.offset > chunk.startOffset) break;
      path = snapshot.path;
    }
    return { ...chunk, headingPath: path };
  });
}

/// 分页正文切块（PDF 等）：逐页独立切块，每块带页码。
/// **offset 相对该页文本**，不是相对全文档拼接串——PDF 引用要定位到页，跨页拼接的
/// 全局 offset 反而无法还原「第几页第几个字符」。
export function chunkPagedText(
  pages: ReadonlyArray<{ page: number; text: string }>,
  options: ChunkingOptions = {},
): ChunkDraft[] {
  return pages.flatMap((page) =>
    chunkPlainText(page.text, options).map((chunk) => ({ ...chunk, page: page.page })),
  );
}
