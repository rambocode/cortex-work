// 写作检索的纯打分核心(移植自 Kun write-retrieval-service 的分词/分块/BM25+关键词打分)。
// 全部纯函数、不触碰 fs/electron —— 便于就近单测锁排序正确性;fs 扫描与内存索引缓存在 writing-retrieval.ts。
// 索引以「块(chunk)」为单位:一篇 md 按标题/段落切成若干块,每块独立参与 BM25 打分与 top-k 排序。
//
// 打分 = BM25(词频×IDF,块长归一)+ 关键词加成(命中标题/路径额外加权 + 短语精确命中)。
// 中英混合分词:拉丁词直接切,汉字段用 2..4-gram 滑窗(无第三方分词器,轻量够用)。

import type { WritingRetrievalSnippet, WritingRetrievalSnippetLocation } from "./writing-retrieval-types";

// ── 规模/长度上限(与 Kun 同量级,防超大空间拖垮索引)──────────────────────
const MAX_CHUNK_CHARS = 900;
const MIN_CHUNK_CHARS = 48;
const MAX_TOKENS_PER_CHUNK = 1_200;
const MAX_QUERY_TERMS = 36;
const MAX_SNIPPET_CHARS = 520;
const DEFAULT_MAX_SNIPPETS = 3;

// 停用词:高频虚词不参与打分(降噪 + 减少无意义命中)。
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "about", "there",
  "their", "will", "would", "could", "should", "have", "has", "are", "was", "were",
  "been", "not", "but", "you", "your", "our", "can", "then", "when", "what", "how",
]);

// 单个索引块:承载文本 + 预算好的分词/词频/标题词/路径词,供打分时零成本查表。
export interface WritingIndexedChunk {
  path: string;
  relativePath: string;
  title: string;
  text: string;
  lowerText: string;
  tokens: string[];
  termFrequency: Map<string, number>;
  titleTokens: Set<string>;
  pathTokens: Set<string>;
  location: WritingRetrievalSnippetLocation;
}

// 整个空间的内存索引:块列表 + 文档频率(IDF 用)+ 平均块长(BM25 长度归一用)。
export interface WritingRetrievalIndex {
  chunks: WritingIndexedChunk[];
  files: number;
  averageLength: number;
  documentFrequency: Map<string, number>;
}

// 待索引文件的原始输入(fs 层读好后喂给纯核心;核心不碰 fs)。文本档给整篇 content;
// PDF(U5)给逐页文本 pdfPages —— 两者切块策略与定位(行号 vs 页码)不同,故用判别联合区分。
export interface WritingTextIndexInput {
  path: string;
  relativePath: string;
  content: string;
}

// PDF 单页文本(1-based 页码);由主进程 readWritePdfText 抽取后喂入。
export interface WritingPdfPageText {
  page: number;
  text: string;
}

export interface WritingPdfIndexInput {
  path: string;
  relativePath: string;
  pdfPages: WritingPdfPageText[];
}

export type WritingIndexInput = WritingTextIndexInput | WritingPdfIndexInput;

// 查询模型:归一化查询文本 + 排序好的词项 + 各词权重(供 BM25 加权)。
interface QueryModel {
  text: string;
  terms: string[];
  weights: Map<string, number>;
  phrases: string[];
}

function compactText(text = ""): string {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

function clipTail(text = "", maxChars = 0): string {
  const source = String(text || "");
  if (!maxChars || source.length <= maxChars) return source;
  return source.slice(source.length - maxChars);
}

// NFKC 归一 + 小写:统一全半角/大小写,让分词与匹配稳定。
function normalizeLower(text = ""): string {
  return String(text || "").normalize("NFKC").toLowerCase();
}

function tokenAllowed(token: string): boolean {
  if (!token || STOP_WORDS.has(token)) return false;
  if (/^\d+$/.test(token)) return false; // 纯数字不作为独立词项(降噪)
  return token.length >= 2;
}

// 中英混合分词:拉丁词直接切;汉字段做 2..4-gram 滑窗(覆盖多字词的不同切分)。
export function tokenizeWritingRetrievalText(text = ""): string[] {
  const source = normalizeLower(text);
  const tokens: string[] = [];

  const latinTerms = source.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  for (const term of latinTerms) {
    if (tokenAllowed(term)) tokens.push(term);
  }

  const hanSegments = source.match(/\p{Script=Han}+/gu) ?? [];
  for (const segment of hanSegments) {
    const chars = [...segment].slice(0, 120);
    if (chars.length === 1) {
      tokens.push(chars[0]);
      continue;
    }
    for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        tokens.push(chars.slice(index, index + size).join(""));
      }
    }
  }

  return tokens;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

function cleanHeading(text: string): string {
  return text.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
}

function headingFromLine(text: string): string | null {
  const match = text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
  return match ? cleanHeading(match[0]) : null;
}

// basename(末段):无 node path 依赖,relativePath 已用 / 归一。
function basenameOf(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  return parts[parts.length - 1] || relativePath;
}

// 由若干行构造一个块:超长截断 + 太短丢弃(min chars),预算分词/词频/标题词/路径词。
function buildChunk(
  path: string,
  relativePath: string,
  title: string,
  lines: string[],
  location: WritingRetrievalSnippetLocation,
): WritingIndexedChunk | null {
  const raw = lines.join("\n").trim();
  const text = raw.length > MAX_CHUNK_CHARS + 160 ? `${raw.slice(0, MAX_CHUNK_CHARS).trimEnd()}...` : raw;
  if (compactText(text).length < MIN_CHUNK_CHARS) return null;

  const tokens = tokenizeWritingRetrievalText(`${title}\n${text}`).slice(0, MAX_TOKENS_PER_CHUNK);
  if (tokens.length === 0) return null;
  return {
    path,
    relativePath,
    title,
    text,
    lowerText: normalizeLower(text),
    tokens,
    termFrequency: termFrequency(tokens),
    titleTokens: new Set(tokenizeWritingRetrievalText(title)),
    pathTokens: new Set(tokenizeWritingRetrievalText(relativePath.replace(/[\\/._-]+/g, " "))),
    location,
  };
}

// 把一篇 md/txt 切块:遇标题起新块;段落空行 + 达阈值也切;标题作为块 title(便于展示定位)。
export function chunkWritingMarkdown(path: string, relativePath: string, content: string): WritingIndexedChunk[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const chunks: WritingIndexedChunk[] = [];
  let currentTitle = basenameOf(relativePath);
  let buffer: string[] = [];
  let lineStart = 1;
  let charCount = 0;

  const flush = (): void => {
    const chunk = buildChunk(path, relativePath, currentTitle, buffer, {
      kind: "text",
      lineStart,
      lineEnd: lineStart + buffer.length - 1,
    });
    if (chunk) chunks.push(chunk);
    buffer = [];
    charCount = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = headingFromLine(line);
    if (heading) {
      if (buffer.length > 0) flush();
      currentTitle = heading;
      lineStart = index + 1;
    } else if (buffer.length === 0) {
      lineStart = index + 1;
    }

    buffer.push(line);
    charCount += line.length + 1;
    // 空行且已积累足够字符 → 段落边界切块;或单块超上限强制切。
    const paragraphBreak = !line.trim() && charCount >= 360;
    if (paragraphBreak || charCount >= MAX_CHUNK_CHARS) flush();
  }

  if (buffer.length > 0) flush();
  return chunks;
}

// 把一篇 PDF 的逐页文本切块(U5):一页一块,location 用页码区间(pageStart=pageEnd=页),
// 块 title 标注「文件名 第N页」便于检索命中时展示定位。太短的页(< MIN_CHUNK_CHARS)由 buildChunk 丢弃。
export function chunkWritingPdf(
  path: string,
  relativePath: string,
  pages: WritingPdfPageText[],
): WritingIndexedChunk[] {
  const base = basenameOf(relativePath);
  const chunks: WritingIndexedChunk[] = [];
  for (const { page, text } of pages) {
    if (!compactText(text)) continue;
    const chunk = buildChunk(path, relativePath, `${base} 第${page}页`, [text], {
      kind: "pdf",
      pageStart: page,
      pageEnd: page,
    });
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

// 由已读好的文件列表构造内存索引:切块 + 汇总文档频率与平均块长(BM25 所需统计量)。
// 按输入类型分派:含 pdfPages 走 PDF 页切块(页码定位),否则走 Markdown/文本切块(行号定位)。
export function buildWritingIndex(inputs: WritingIndexInput[]): WritingRetrievalIndex {
  const chunks: WritingIndexedChunk[] = [];
  let indexedFiles = 0;
  for (const input of inputs) {
    const fileChunks =
      "pdfPages" in input
        ? chunkWritingPdf(input.path, input.relativePath, input.pdfPages)
        : chunkWritingMarkdown(input.path, input.relativePath, input.content);
    if (fileChunks.length > 0) indexedFiles += 1;
    chunks.push(...fileChunks);
  }

  const documentFrequency = new Map<string, number>();
  let tokenCount = 0;
  for (const chunk of chunks) {
    tokenCount += chunk.tokens.length;
    for (const token of new Set(chunk.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  return {
    chunks,
    files: indexedFiles,
    averageLength: chunks.length > 0 ? tokenCount / chunks.length : 1,
    documentFrequency,
  };
}

// 从查询正文构造查询模型:分词 + 取前 N 高权词项 + 记录首个长短语(供精确匹配加成)。
export function buildQueryModelFromText(text: string): QueryModel {
  const weights = new Map<string, number>();
  for (const token of tokenizeWritingRetrievalText(text)) {
    weights.set(token, (weights.get(token) ?? 0) + 2);
  }
  const compact = compactText(text);
  const ranked = [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_QUERY_TERMS);
  return {
    text: compact.slice(0, 240),
    terms: ranked.map(([term]) => term),
    weights: new Map(ranked),
    phrases: compact.length >= 8 ? [normalizeLower(clipTail(compact, 80))] : [],
  };
}

// BM25 打分(k1=1.2,b=0.72):词频饱和 + IDF + 块长归一,叠加查询词权重。
function bm25Score(chunk: WritingIndexedChunk, index: WritingRetrievalIndex, query: QueryModel): number {
  const totalDocs = Math.max(1, index.chunks.length);
  const averageLength = Math.max(1, index.averageLength);
  const k1 = 1.2;
  const b = 0.72;
  let score = 0;

  for (const term of query.terms) {
    const tf = chunk.termFrequency.get(term) ?? 0;
    if (!tf) continue;
    const df = index.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const normalized = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (chunk.tokens.length / averageLength)));
    const weight = query.weights.get(term) ?? 1;
    score += weight * idf * normalized;
  }

  return score;
}

// 关键词加成:命中标题/路径额外加权;命中词数量的平方根加成;长短语精确命中重奖。
function keywordScore(chunk: WritingIndexedChunk, query: QueryModel): { score: number; keywords: string[] } {
  const keywords: string[] = [];
  let score = 0;
  for (const term of query.terms) {
    if (!chunk.termFrequency.has(term)) continue;
    keywords.push(term);
    const weight = query.weights.get(term) ?? 1;
    if (chunk.titleTokens.has(term)) score += 0.35 * weight;
    if (chunk.pathTokens.has(term)) score += 0.18 * weight;
  }
  if (keywords.length > 0) score += Math.sqrt(keywords.length) * 0.18;

  for (const phrase of query.phrases) {
    if (phrase.length >= 8 && chunk.lowerText.includes(phrase)) score += 0.9;
  }

  return { score, keywords: keywords.slice(0, 8) };
}

// 从块内截取最能代表命中的片段:短则整块;长则以首个命中关键词为中心开窗截断。
function bestSnippetText(chunk: WritingIndexedChunk, keywords: string[]): string {
  const compact = chunk.text.replace(/\r\n?/g, "\n").trim();
  if (compact.length <= MAX_SNIPPET_CHARS) return compact;

  const lower = normalizeLower(compact);
  let bestIndex = -1;
  for (const keyword of keywords) {
    const index = lower.indexOf(keyword);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) bestIndex = index;
  }
  const center = bestIndex >= 0 ? bestIndex : Math.floor(compact.length / 2);
  const start = Math.max(0, center - Math.floor(MAX_SNIPPET_CHARS / 2));
  const end = Math.min(compact.length, start + MAX_SNIPPET_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}

// 在索引上跑一次查询:BM25+关键词打分 → 阈值/命中过滤 → 排序 → 每文件≤2 段、去重后取 top-k。
export function retrieveFromIndex(
  index: WritingRetrievalIndex,
  query: QueryModel,
  maxSnippets: number,
): WritingRetrievalSnippet[] {
  const ranked = index.chunks
    .map((chunk) => {
      const keyword = keywordScore(chunk, query);
      const score = bm25Score(chunk, index, query) + keyword.score;
      return { chunk, score, keywords: keyword.keywords };
    })
    // 至少命中一个查询词且分数达阈值,过滤纯噪声块。
    .filter((item) => item.score >= 0.25 && item.keywords.length > 0)
    .sort((a, b) => b.score - a.score);

  const snippets: WritingRetrievalSnippet[] = [];
  const perFile = new Map<string, number>();
  const seenText = new Set<string>();
  for (const item of ranked) {
    if (snippets.length >= maxSnippets) break;
    const used = perFile.get(item.chunk.path) ?? 0;
    if (used >= 2) continue; // 单文件最多贡献 2 段,保证来源多样性
    const snippetText = bestSnippetText(item.chunk, item.keywords);
    const signature = compactText(snippetText).slice(0, 120);
    if (!signature || seenText.has(signature)) continue; // 去重近似重复片段
    seenText.add(signature);
    perFile.set(item.chunk.path, used + 1);
    snippets.push({
      path: item.chunk.relativePath,
      title: item.chunk.title,
      text: snippetText,
      score: Number(item.score.toFixed(3)),
      keywords: item.keywords,
      location: item.chunk.location,
    });
  }
  return snippets;
}

// 夹取期望片段数到 1..8(默认 3):防越界/脏值。
export function clampSnippetCount(k: number | undefined): number {
  return Math.max(1, Math.min(8, Math.round(k ?? DEFAULT_MAX_SNIPPETS)));
}

export { buildQueryModelFromText as buildWritingQueryModel };
export type { QueryModel as WritingRetrievalQueryModel };
