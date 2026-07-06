// 写作助手的 prompt 拼装与选区引用(移植自 Kun 的 quoted-selection,按 cortex 一期裁剪:
// 去掉 PDF / retrieval / agent 人设,只保留「当前文件上下文 + 文本引用片段 + 改稿约定 + 用户正文」)。
// 哨兵常量集中导出,拼装与展示层反解析共用同一套边界标记(见 parseWritingPromptForDisplay),
// 避免两处各写一套导致漂移。
//
// 拼装顺序(与展示反解析严格对称):
//   [写作上下文]\n当前文件: <相对路径>
//   [引用片段] <标题>（第a-b行，共n字）路径: <绝对路径>\n[引用原文]\n<文本>\n[/引用原文]  (可 0..n 段)
//   [改稿约定] <约定正文>
//   <用户正文>
// 段与段之间以空行分隔;空段自动省略(filter(Boolean))。

// ── 哨兵常量(拼装 + 反解析共用)──────────────────────────────────────────
export const WRITING_CONTEXT_HEADING = "[写作上下文]";
export const WRITING_QUOTE_HEADING = "[引用片段]";
export const WRITING_QUOTE_ORIGINAL_START = "[引用原文]";
export const WRITING_QUOTE_ORIGINAL_END = "[/引用原文]";
export const WRITING_REVISION_HEADING = "[改稿约定]";

// 改稿约定正文:恒定注入,框定 agent 的落盘行为(R12 的 prompt 级契约,非强制沙箱)。
// 三条要点:① 用 Edit/Write 工具把改动直接写盘,不要只在回复里贴改后文本;② 只改写作空间内文件;
// ③ 告知用户改动将以行级红绿 diff 逐块审阅,可放心直接改。
export const WRITING_REVISION_RULE =
  "当用户要求修改、改写、润色、翻译、续写、扩写或整理「当前文件」所指的文档时," +
  "你必须用 Edit 或 Write 文件工具把改动直接写入该文件(建议先 Read 取到准确原文,再 Edit/Write)," +
  "完成后只用一两句话说明改了什么——绝不要只在回复里贴出修改后的文本却不落盘。" +
  "只允许改动当前写作空间(工作目录)内的文件,不要写空间外的路径。" +
  "用户会在编辑器里以行级红绿 Diff 审阅你的改动、逐块接受或拒绝,所以请放心直接改。" +
  "仅当用户只是提问、讨论,或处理的是只读引用片段时,才用纯文本回答、不改文件。";

// ── 选区引用模型 ──────────────────────────────────────────────────────────
// 编辑器选区快照:创建引用时冻结,后续文档变动不影响已建引用(快照语义,R11)。
export interface WritingSelectionSnapshot {
  text: string;
  charCount: number;
  // 1-based 起止行号(纯文本选区);缺省时省略行号展示。
  lineStart?: number;
  lineEnd?: number;
}

// 一条冻结的引用片段:承载文本 + 来源(相对标题 + 绝对路径)+ 行号 + 字数。
export interface WritingQuote {
  id: string;
  text: string;
  sourceTitle: string; // 相对写作空间根的路径(展示用)
  sourceFilePath: string; // 绝对路径(agent 定位用)
  lineStart?: number;
  lineEnd?: number;
  charCount: number;
  createdAt: number;
}

// 归一化路径:统一分隔符为 /、去尾部斜杠(不做 realpath,core 无 node path)。
function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

// 从绝对路径取 basename(末段),供无法算相对路径时回落。
function basenameFromPath(value: string): string {
  const parts = normalizePath(value).split("/").filter(Boolean);
  return parts[parts.length - 1] || normalizePath(value);
}

// 相对写作空间根的展示路径:命中根前缀则截掉,否则回落 basename。
export function relativeWritingPath(workspaceRoot: string, filePath: string): string {
  const root = normalizePath(workspaceRoot);
  const file = normalizePath(filePath);
  const prefix = `${root}/`;
  if (root && file.startsWith(prefix)) return file.slice(prefix.length);
  return basenameFromPath(filePath);
}

// 从编辑器选区快照 + 文件路径构造一条冻结引用(空选区返回 null)。now 注入便于测试确定 id/createdAt。
export function quoteFromSelection(
  selection: WritingSelectionSnapshot,
  filePath: string,
  workspaceRoot: string,
  now: number = Date.now(),
): WritingQuote | null {
  const text = selection.text.trim();
  if (!text || selection.charCount <= 0) return null;
  return {
    id: `quote-${now}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    sourceTitle: relativeWritingPath(workspaceRoot, filePath),
    sourceFilePath: filePath,
    ...(selection.lineStart != null ? { lineStart: selection.lineStart } : {}),
    ...(selection.lineEnd != null ? { lineEnd: selection.lineEnd } : {}),
    charCount: selection.charCount,
    createdAt: now,
  };
}

// 单条引用格式化为 prompt 片段(标题含行号/字数元信息,文本包裹在原文哨兵之间)。
function formatQuoteForPrompt(quote: WritingQuote): string {
  const meta =
    quote.lineStart != null && quote.lineEnd != null
      ? `（第${quote.lineStart}-${quote.lineEnd}行，共${quote.charCount}字）`
      : `（共${quote.charCount}字）`;
  return [
    `${WRITING_QUOTE_HEADING} ${quote.sourceTitle}${meta}路径: ${quote.sourceFilePath}`,
    WRITING_QUOTE_ORIGINAL_START,
    quote.text,
    WRITING_QUOTE_ORIGINAL_END,
  ].join("\n");
}

export interface WritingPromptContext {
  workspaceRoot?: string;
  activeFilePath?: string | null;
}

// 拼装完整 prompt:上下文块(当前文件相对路径)+ 引用片段(0..n)+ 改稿约定 + 用户正文。
// 改稿约定恒在(即便无正文/无引用),确保每回合都带落盘契约。
export function composeWritingPrompt(
  input: string,
  quotes: WritingQuote[],
  context: WritingPromptContext = {},
): string {
  const body = input.trim();
  const contextLines: string[] = [];
  if (context.activeFilePath?.trim()) {
    contextLines.push(
      `当前文件: ${relativeWritingPath(context.workspaceRoot ?? "", context.activeFilePath)}`,
    );
  }
  const contextText = contextLines.length > 0
    ? `${WRITING_CONTEXT_HEADING}\n${contextLines.join("\n")}`
    : "";
  const quoteText = quotes.map(formatQuoteForPrompt).join("\n\n");
  const revisionText = `${WRITING_REVISION_HEADING}\n${WRITING_REVISION_RULE}`;
  return [contextText, quoteText, revisionText, body].filter(Boolean).join("\n\n");
}

// ── 展示层反解析(哨兵驱动)──────────────────────────────────────────────
// 从完整 prompt 反解析出展示结构:去掉上下文/引用/改稿约定噪音,还原用户正文与引用元信息。
// 主展示路径用 run-manager 的 displayText 直显;本函数供需要拆出引用/上下文的展示场景复用。
export interface WritingPromptDisplayQuote {
  sourceTitle: string;
  sourceFilePath?: string;
  lineStart?: number;
  lineEnd?: number;
  charCount?: number;
  text: string;
}

export interface WritingPromptDisplay {
  userInput: string;
  activeFile?: string;
  quotes: WritingPromptDisplayQuote[];
}

// 解析引用头行,取出标题/路径/行号/字数(与 formatQuoteForPrompt 的格式严格对称)。
function parseQuoteHeader(header: string): Omit<WritingPromptDisplayQuote, "text"> {
  const body = header.replace(WRITING_QUOTE_HEADING, "").trim();
  const pathSplit = body.match(/^(.*?)\s*路径:\s*(.+)$/);
  const titleAndMeta = (pathSplit?.[1] ?? body).trim();
  const sourceFilePath = pathSplit?.[2]?.trim();
  const metaMatch = titleAndMeta.match(/^(.*?)（(?:第(\d+)-(\d+)行，)?共(\d+)字）$/);
  const sourceTitle = (metaMatch?.[1] ?? titleAndMeta).trim();
  const lineStart = metaMatch?.[2] ? Number.parseInt(metaMatch[2], 10) : undefined;
  const lineEnd = metaMatch?.[3] ? Number.parseInt(metaMatch[3], 10) : undefined;
  const charCount = metaMatch?.[4] ? Number.parseInt(metaMatch[4], 10) : undefined;
  return {
    sourceTitle,
    ...(sourceFilePath ? { sourceFilePath } : {}),
    ...(lineStart != null ? { lineStart } : {}),
    ...(lineEnd != null ? { lineEnd } : {}),
    ...(charCount != null ? { charCount } : {}),
  };
}

// 反解析完整 prompt。无任何哨兵时返回 null(说明是裸文本,展示层直显即可)。
export function parseWritingPromptForDisplay(text: string): WritingPromptDisplay | null {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (
    !normalized.includes(WRITING_CONTEXT_HEADING) &&
    !normalized.includes(WRITING_QUOTE_HEADING) &&
    !normalized.includes(WRITING_REVISION_HEADING)
  ) {
    return null;
  }
  // 以「空行」切段;逐段按哨兵归类,未命中哨兵的连续尾段合成用户正文。
  const segments = normalized.split(/\n{2,}/);
  let activeFile: string | undefined;
  const quotes: WritingPromptDisplayQuote[] = [];
  const bodyParts: string[] = [];
  for (const seg of segments) {
    const s = seg.trim();
    if (s.startsWith(WRITING_CONTEXT_HEADING)) {
      const fileMatch = s.match(/当前文件:\s*(.+)$/m);
      if (fileMatch?.[1]) activeFile = fileMatch[1].trim();
      continue;
    }
    if (s.startsWith(WRITING_QUOTE_HEADING)) {
      const firstNl = s.indexOf("\n");
      const header = firstNl < 0 ? s : s.slice(0, firstNl);
      const startIdx = s.indexOf(WRITING_QUOTE_ORIGINAL_START);
      const endIdx = s.indexOf(WRITING_QUOTE_ORIGINAL_END);
      const quoteText =
        startIdx >= 0 && endIdx > startIdx
          ? s.slice(startIdx + WRITING_QUOTE_ORIGINAL_START.length, endIdx).trim()
          : "";
      quotes.push({ ...parseQuoteHeader(header), text: quoteText });
      continue;
    }
    if (s.startsWith(WRITING_REVISION_HEADING)) continue; // 改稿约定不展示
    bodyParts.push(s);
  }
  return {
    userInput: bodyParts.join("\n\n").trim(),
    ...(activeFile ? { activeFile } : {}),
    quotes,
  };
}
