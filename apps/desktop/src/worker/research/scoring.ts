// 证据块的词法打分（spec §12.4 的 lexical score 环节）。
//
// rerank 与 fetch_prepare 共用同一套打分：两者的分数必须可比，否则 main 无法把「本轮新抓的块」
// 与「上一轮已入库的块」放在一起排序。实现复用 core 的 retrieval/lexical（BM25 + 关键词加成），
// 那套算法本来就是从写作检索上移到 core 的，Worker 侧不再造第二套。
//
// 本文件跑在 utilityProcess Worker 里，禁止 import electron。
import {
  bm25Score,
  buildQueryModelFromText,
  keywordScore,
  normalizeLower,
  tokenizeRetrievalText,
  type LexicalChunk,
} from "@cortex-work/core/retrieval/lexical";

/// 待打分的块。title / headingPath 命中会有额外加权（见 core 的 keywordScore）。
export interface ScorableChunk {
  chunkId: string;
  text: string;
  title?: string;
  headingPath?: readonly string[];
}

/// 把一个块编译成 LexicalChunk（预先算好分词与词频，避免打分时重复计算）。
function compile(chunk: ScorableChunk): LexicalChunk {
  const tokens = tokenizeRetrievalText(chunk.text);
  const termFrequency = new Map<string, number>();
  for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  return {
    text: chunk.text,
    lowerText: normalizeLower(chunk.text),
    tokens,
    termFrequency,
    titleTokens: new Set(tokenizeRetrievalText(chunk.title ?? "")),
    pathTokens: new Set(tokenizeRetrievalText((chunk.headingPath ?? []).join(" "))),
  };
}

/// 对一批块按查询打分，返回 chunkId → 分数。
///
/// 语料统计（平均块长、文档频率）**只在本批内计算**：Worker 不持有全局索引，也不该持有——
/// 它不写数据库（KTD1）。这意味着分数只在同一批内可比；main 若要跨批比较，应重新调用 rerank
/// 把两批块一起传进来。
export function scoreChunks(query: string, chunks: readonly ScorableChunk[]): Map<string, number> {
  const compiled = chunks.map((chunk) => ({ id: chunk.chunkId, lexical: compile(chunk) }));
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const item of compiled) {
    totalLength += item.lexical.tokens.length;
    for (const term of new Set(item.lexical.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const stats = {
    chunks: compiled,
    averageLength: compiled.length > 0 ? totalLength / compiled.length : 1,
    documentFrequency,
  };
  const queryModel = buildQueryModelFromText(query);

  const scores = new Map<string, number>();
  for (const item of compiled) {
    const score = bm25Score(item.lexical, stats, queryModel) + keywordScore(item.lexical, queryModel).score;
    scores.set(item.id, score);
  }
  return scores;
}

/// 把目标与子问题拼成一条查询文本。子问题各自出现一次即可——重复出现会让它们的词权重
/// 压过总目标，导致「只回答了某个子问题」的块排到最前面。
export function buildQueryText(objective: string, subquestions: ReadonlyArray<{ text: string }>): string {
  return [objective, ...subquestions.map((item) => item.text)].join(" ");
}
