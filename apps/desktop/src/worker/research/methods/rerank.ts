// rerank：对 main 给定的块做词法重排（spec §12.1）。
//
// **无网络、无模型**：它只是把 core 的 BM25 打分放到 Worker 里跑，避免 main 主进程为几百个块
// 做同步分词而卡住 UI 线程。
// 本文件跑在 utilityProcess Worker 里，禁止 import electron。
import { buildQueryText, scoreChunks } from "../scoring";
import type { RerankParams, RerankResult } from "../rpc-server";

/// 执行重排。分数并列时按 chunk_id 字典序，保证同一输入永远得到同一输出
/// （结果要写进 main 的排序缓存，抖动会让「同一批证据每次顺序都不同」）。
export function runRerank(params: RerankParams): RerankResult {
  const scores = scoreChunks(
    buildQueryText(params.query, params.subquestions),
    params.chunks.map((chunk) => ({ chunkId: chunk.chunk_id, text: chunk.text })),
  );

  const ranked = params.chunks
    .map((chunk) => ({ chunk_id: chunk.chunk_id, score: scores.get(chunk.chunk_id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, params.top_k);

  return { operation_id: params.operation_id, ranked };
}
