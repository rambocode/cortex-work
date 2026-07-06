// 写作检索(工作区级轻量 RAG)IPC 契约类型。
// ⚠️ 与 packages/core/desktop/writing-retrieval-types.ts 逐字镜像(双写契约,改动两处必须同步)。
// 主进程按空间根维护内存倒排索引(md/txt 全量读),渲染端发送助手回合时以用户正文查询 top-k 片段,
// 片段注入 prompt 的 [相关文献上下文] 哨兵段(见 packages/core/writing/prompt.ts)。
// 独立成文件(不并入 writing-types.ts)是为降低与并行单元在 writing-types.ts 上的编辑冲突。

// 片段来源定位:纯文本档给 1-based 行号区间;PDF(U5 接入检索分支)给页码区间。
export type WritingRetrievalSnippetLocation =
  | { kind: "text"; lineStart: number; lineEnd: number }
  | { kind: "pdf"; pageStart: number; pageEnd: number };

// 单条检索片段:相对空间根路径(展示/引用用)+ 标题 + 正文 + 打分 + 命中关键词 + 定位。
export interface WritingRetrievalSnippet {
  path: string;
  title: string;
  text: string;
  score: number;
  keywords: string[];
  location: WritingRetrievalSnippetLocation;
}

// 一次检索命中的上下文:片段列表 + 查询正文/关键词 + 索引规模(供 prompt 头部标注与调试)。
export interface WritingRetrievalContext {
  source: "bm25-keyword";
  query: string;
  keywords: string[];
  snippets: WritingRetrievalSnippet[];
  indexedFiles: number;
  indexedChunks: number;
}

// 检索请求:root(空间根,内存索引键)+ query(用户正文)+ k(期望片段数,默认 3,夹取 1..8)。
export interface WritingRetrievalRequest {
  root: string;
  query: string;
  k?: number;
}

// 检索结果:ok 时 context 可为 null(空查询/空索引/无命中 → 渲染端静默不注入);失败给可读 message。
// 渲染端对失败与 null 一视同仁(都不注入),仅在超时/异常时不阻断发送(见 WritingAssistantPanel)。
export type WritingRetrievalResult =
  | { ok: true; context: WritingRetrievalContext | null }
  | { ok: false; message: string };
