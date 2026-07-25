// 通用词法检索原语:中英混合分词 + BM25 + 关键词加成 + 命中片段开窗。
// 原本内嵌在 desktop 的写作检索(main/ipc/writing-retrieval-core.ts),CRE 的 rerank 也要用同一套打分,
// 而 core 不能依赖 apps,故整体上移到平台无关层;写作侧改为 re-export,算法逐字未变。
//
// 本模块只处理「已经切好块」的文本:分块策略(md 按标题、PDF 按页……)属于各业务语义,留在各自调用方。
// 纯函数、无任何平台依赖(不碰 fs / electron / process.env)。

// ── 规模/长度上限(与写作侧原实现同量级,改动会直接影响检索排序,勿随意调)────────
const MAX_QUERY_TERMS = 36;
const MAX_SNIPPET_CHARS = 520;

// 停用词:高频虚词不参与打分(降噪 + 减少无意义命中)。
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "about", "there",
  "their", "will", "would", "could", "should", "have", "has", "are", "was", "were",
  "been", "not", "but", "you", "your", "our", "can", "then", "when", "what", "how",
]);

/// 可参与词法打分的块:调用方(写作索引 / CRE 证据块)只需在自己的块类型上具备这几个字段。
/// 各打分函数用 Pick 精确声明所需子集,便于按需构造轻量对象。
export interface LexicalChunk {
  /// 块原文(用于片段开窗展示)。
  text: string;
  /// 块原文的 NFKC + 小写形式(用于短语精确匹配,避免每次打分重复归一)。
  lowerText: string;
  /// 块的分词结果;长度即 BM25 的文档长度。
  tokens: readonly string[];
  /// 块内词频表(BM25 的 tf)。
  termFrequency: ReadonlyMap<string, number>;
  /// 块标题的分词集合(命中额外加权)。
  titleTokens: ReadonlySet<string>;
  /// 块所在路径的分词集合(命中额外加权)。
  pathTokens: ReadonlySet<string>;
}

/// BM25 需要的语料级统计量。`chunks` 只用其长度(总文档数),故元素类型不作约束——
/// 这样调用方可以直接把自己的索引对象传进来,不必先做一次映射。
export interface LexicalCorpusStats {
  chunks: readonly unknown[];
  /// 平均块长(token 数),用于长度归一。
  averageLength: number;
  /// 各词项的文档频率(IDF 用)。
  documentFrequency: ReadonlyMap<string, number>;
}

/// 查询模型:归一化查询文本 + 排序好的词项 + 各词权重(供 BM25 加权)+ 长短语(精确命中加成)。
export interface LexicalQueryModel {
  text: string;
  terms: string[];
  weights: Map<string, number>;
  phrases: string[];
}

/// 压缩空白:CRLF 归一 + 连续空白折叠为单空格 + 去首尾,供签名去重与长度判定使用。
export function compactText(text = ""): string {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

/// NFKC 归一 + 小写:统一全半角/大小写,让分词与匹配稳定。
export function normalizeLower(text = ""): string {
  return String(text || "").normalize("NFKC").toLowerCase();
}

// 取尾部若干字符(不足则原样返回),用于短语只保留查询末段。
function clipTail(text = "", maxChars = 0): string {
  const source = String(text || "");
  if (!maxChars || source.length <= maxChars) return source;
  return source.slice(source.length - maxChars);
}

// 词项准入:停用词、纯数字、单字符拉丁词一律丢弃(降噪)。
function tokenAllowed(token: string): boolean {
  if (!token || STOP_WORDS.has(token)) return false;
  if (/^\d+$/.test(token)) return false; // 纯数字不作为独立词项(降噪)
  return token.length >= 2;
}

/// 中英混合分词:拉丁词直接切;汉字段做 2..4-gram 滑窗(覆盖多字词的不同切分)。
/// 不引第三方分词器——n-gram 在检索召回上足够,且体积/依赖为零。
export function tokenizeRetrievalText(text = ""): string[] {
  const source = normalizeLower(text);
  const tokens: string[] = [];

  const latinTerms = source.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  for (const term of latinTerms) {
    if (tokenAllowed(term)) tokens.push(term);
  }

  const hanSegments = source.match(/\p{Script=Han}+/gu) ?? [];
  for (const segment of hanSegments) {
    // 单段最多取 120 字:n-gram 数量随段长线性膨胀,超长段落会把词表撑爆。
    const chars = [...segment].slice(0, 120);
    if (chars.length === 1) {
      // 单字成词。此处 chars 必然只有一个元素,join 等价于 chars[0],
      // 但能规避 core 侧 noUncheckedIndexedAccess 的 undefined 断言噪音。
      tokens.push(chars.join(""));
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

/// 从查询正文构造查询模型:分词 + 取前 N 高权词项 + 记录首个长短语(供精确匹配加成)。
export function buildQueryModelFromText(text: string): LexicalQueryModel {
  const weights = new Map<string, number>();
  for (const token of tokenizeRetrievalText(text)) {
    weights.set(token, (weights.get(token) ?? 0) + 2);
  }
  const compact = compactText(text);
  // 排序键:权重优先,同权重取更长的词(更具体),再按字典序保证结果稳定可测。
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

/// BM25 打分(k1=1.2,b=0.72):词频饱和 + IDF + 块长归一,叠加查询词权重。
export function bm25Score(
  chunk: Pick<LexicalChunk, "tokens" | "termFrequency">,
  index: LexicalCorpusStats,
  query: LexicalQueryModel,
): number {
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

/// 关键词加成:命中标题/路径额外加权;命中词数量的平方根加成;长短语精确命中重奖。
/// 返回的 keywords 截断到 8 个(仅用于展示与片段开窗),但加成按全部命中数计算。
export function keywordScore(
  chunk: Pick<LexicalChunk, "termFrequency" | "titleTokens" | "pathTokens" | "lowerText">,
  query: LexicalQueryModel,
): { score: number; keywords: string[] } {
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

/// 从块内截取最能代表命中的片段:短则整块;长则以首个命中关键词为中心开窗截断。
export function bestSnippetText(chunk: Pick<LexicalChunk, "text">, keywords: readonly string[]): string {
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
