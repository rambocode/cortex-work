// CRE 引用校验（spec §10.4、§19.1.6）：报告生成后的**最后一道防伪造闸门**。
//
// 为什么必须存在：Report Generator 是 LLM，它有能力凭空造出「看起来很像引用」的标记。
// 只要有一个伪造引用留在输出里，整个「每条事实都可回溯到抓取到的原文」的契约就废了。
// 因此本模块的红线是——**未知 chunkId 的引用一律从 markdown 中物理删除**，
// 并把因此失去全部支撑的事实段落标为 unsupported，交给上层显式降级展示。
//
// ## 引用语法（report-generator 的 prompt 必须与此保持一致）
//
//     [^<chunkId>]
//
// 行内脚注式标记，紧跟在被支撑的句子后面，例如：`地球是圆的[^chunk_7]。`
// chunkId 允许的字符集是 `[A-Za-z0-9_][A-Za-z0-9_.:-]*`。
// **代码围栏（``` / ~~~）与行内代码（`…`）里的同形文本不算引用**：技术报告里
// `list[^idx]` 这类代码片段很常见，把它当引用删掉会破坏代码正确性。
//
// 命名风格：TS 领域模型，camelCase。

/// 失去引用支撑的段落在最终 markdown 中的位置。offset **相对校验后的 markdown**
/// （即 CitationValidationResult.markdown），因为删除伪造标记会让原文 offset 全部失效。
export interface UnsupportedSpan {
  start: number;
  end: number;
  text: string;
}

/// 引用校验结果。markdown 是清洗后的安全产物，调用方必须使用它而不是原始输入。
export interface CitationValidationResult {
  markdown: string;
  /// 被判定为伪造并已删除的 chunkId（去重，按首次出现顺序）。
  removedChunkIds: string[];
  /// 清洗后仍缺少任何有效引用的事实段落。
  unsupportedSpans: UnsupportedSpan[];
  /// 清洗后仍保留的合法引用 chunkId（去重，按首次出现顺序）。
  citedChunkIds: string[];
}

/// 引用标记的词法。刻意不允许空白与中文，避免把正文里的方括号误判成引用。
const CITATION_RE = /\[\^([A-Za-z0-9_][A-Za-z0-9_.:-]*)\]/g;

/// 围栏代码块的起止行（允许最多 3 个前导空格，这是 CommonMark 的规定）。
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/// 行内代码：反引号数量必须首尾一致，非贪婪匹配最近的同长度收尾。
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g;

/// 半开区间。
interface Span {
  start: number;
  end: number;
}

/// 代码区间分析结果。fences 与 inline 分开返回，是因为两者对「事实段落」的影响不同：
/// 整个围栏块不是断言（不该被标 unsupported），但一段夹着行内代码的正文仍然是断言。
interface CodeRanges {
  fences: Span[];
  all: Span[];
}

/// 找出所有「引用不算数」的代码区间：先按行扫出围栏块，再在围栏之外扫行内代码。
/// 分两步是因为围栏内的反引号会把行内代码正则带偏，必须先把围栏整体挖掉。
function findCodeRanges(markdown: string): CodeRanges {
  const fences: Span[] = [];
  let fenceStart = -1;
  let fenceMarker = "";
  let offset = 0;

  for (const line of markdown.split("\n")) {
    const match = FENCE_LINE_RE.exec(line);
    if (match) {
      if (fenceStart < 0) {
        fenceStart = offset;
        fenceMarker = match[1]![0]!;
      } else if (match[1]![0] === fenceMarker) {
        fences.push({ start: fenceStart, end: offset + line.length });
        fenceStart = -1;
      }
    }
    offset += line.length + 1;
  }
  // 未闭合的围栏视为一直延伸到文末：模型输出被截断时，宁可多屏蔽也不能误删代码里的方括号
  if (fenceStart >= 0) fences.push({ start: fenceStart, end: markdown.length });

  const ranges: Span[] = [...fences];
  let cursor = 0;
  const scanInline = (from: number, to: number): void => {
    const segment = markdown.slice(from, to);
    INLINE_CODE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_CODE_RE.exec(segment)) !== null) {
      ranges.push({ start: from + match.index, end: from + match.index + match[0].length });
    }
  };
  for (const fence of fences) {
    scanInline(cursor, fence.start);
    cursor = fence.end;
  }
  scanInline(cursor, markdown.length);

  return { fences, all: ranges.sort((a, b) => a.start - b.start) };
}

/// 一次引用标记的出现。
interface CitationMatch extends Span {
  chunkId: string;
}

/// 扫出所有**有效位置**上的引用标记（自动跳过代码区间）。
function findCitations(markdown: string): CitationMatch[] {
  const codeRanges = findCodeRanges(markdown).all;
  const inCode = (index: number): boolean =>
    codeRanges.some((range) => index >= range.start && index < range.end);

  const found: CitationMatch[] = [];
  CITATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(markdown)) !== null) {
    if (inCode(match.index)) continue;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      chunkId: match[1]!,
    });
  }
  return found;
}

/// 删除若干标记区间，并顺手收拾标记两侧留下的多余空格。
/// 不做整体空白归一化：报告 markdown 的缩进与换行是有语义的，只在删除点做最小修补。
function removeRanges(source: string, ranges: readonly Span[]): string {
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += source.slice(cursor, range.start);
    const previous = range.start > 0 ? source[range.start - 1] : "";
    const next = source[range.end] ?? "";
    cursor = range.end;
    if (previous === " " && next === " ") {
      cursor += 1;
    } else if (previous === " ") {
      out = out.slice(0, -1);
    }
  }
  return out + source.slice(cursor);
}

/// 去重且保序。
function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/// 空行分隔的段落块（已剔除首尾空白）。
function splitBlocks(text: string): Span[] {
  const blocks: Span[] = [];
  const separator = /\n[^\S\n]*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const push = (start: number, end: number): void => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s]!)) s += 1;
    while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
    if (s < e) blocks.push({ start: s, end: e });
  };

  while ((match = separator.exec(text)) !== null) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);
  return blocks;
}

/// 标题行。
const HEADING_RE = /^#{1,6}(\s|$)/;
/// 列表引导行（无序或有序）。
const LIST_RE = /^([-*+]|\d+[.)])\s/;
/// 分隔线。
const THEMATIC_BREAK_RE = /^(-{3,}|\*{3,}|_{3,})$/;
/// 至少包含一个字母、数字或表意文字才算「有内容」。
const HAS_WORD_RE = /[\p{L}\p{N}]/u;

/// 判断一个块是否是「需要引用支撑的事实段落」。
/// 标题、列表引导、代码块、分隔线、表格行都不是断言本身，不该因为没有引用被标红——
/// 否则报告里每个小标题都会被打上「无依据」，降级提示就彻底失去信噪比了。
/// 注意只用 fences 判定：段落里夹一段行内代码不影响它是断言。
function isFactualBlock(markdown: string, block: Span, fences: readonly Span[]): boolean {
  if (fences.some((range) => block.start >= range.start && block.start < range.end)) return false;

  const text = markdown.slice(block.start, block.end);
  const firstLine = text.split("\n", 1)[0]!.trim();
  if (firstLine === "") return false;
  if (HEADING_RE.test(firstLine)) return false;
  if (THEMATIC_BREAK_RE.test(firstLine)) return false;
  if (LIST_RE.test(firstLine)) return false;
  if (firstLine.startsWith("|")) return false;
  return HAS_WORD_RE.test(text);
}

/// 校验并清洗报告里的引用（spec §10.4）。
///
/// 三件事，顺序不可换：
/// 1. 删除 knownChunkIds 之外的全部引用标记 —— 伪造引用绝不允许出现在最终产物里；
/// 2. 在**清洗后**的文本上重新划分段落，把没有任何有效引用的事实段记为 unsupported；
/// 3. 汇总仍然有效的引用 id，供上层构造 CitationRef。
///
/// 第 2 步必须在清洗之后做：伪造标记被删掉之前，那些段落看起来是「有引用」的。
export function validateCitations(input: {
  markdown: string;
  knownChunkIds: ReadonlySet<string> | readonly string[];
}): CitationValidationResult {
  const known =
    input.knownChunkIds instanceof Set
      ? (input.knownChunkIds as ReadonlySet<string>)
      : new Set(input.knownChunkIds as readonly string[]);

  const citations = findCitations(input.markdown);
  const forged = citations.filter((citation) => !known.has(citation.chunkId));
  const markdown = forged.length === 0 ? input.markdown : removeRanges(input.markdown, forged);

  // 清洗后重扫：此时文本里剩下的标记按构造全都是合法的
  const survivors = findCitations(markdown);
  const { fences } = findCodeRanges(markdown);
  const unsupportedSpans: UnsupportedSpan[] = [];

  for (const block of splitBlocks(markdown)) {
    if (!isFactualBlock(markdown, block, fences)) continue;
    const supported = survivors.some(
      (citation) => citation.start >= block.start && citation.end <= block.end,
    );
    if (supported) continue;
    unsupportedSpans.push({
      start: block.start,
      end: block.end,
      text: markdown.slice(block.start, block.end),
    });
  }

  return {
    markdown,
    removedChunkIds: uniqueInOrder(forged.map((citation) => citation.chunkId)),
    unsupportedSpans,
    citedChunkIds: uniqueInOrder(survivors.map((citation) => citation.chunkId)),
  };
}

/// 移除全部引用标记，得到纯净正文。用于导出 txt / 复制到外部编辑器等场景。
/// 注意：这会丢失可回溯性，只能用于展示或导出，不能拿它回灌研究流程。
export function stripAllCitations(markdown: string): string {
  return removeRanges(markdown, findCitations(markdown));
}

/// 按出现顺序收集被引用的 chunkId（去重）。不校验合法性——需要校验请用 validateCitations。
export function collectCitedChunkIds(markdown: string): string[] {
  return uniqueInOrder(findCitations(markdown).map((citation) => citation.chunkId));
}
