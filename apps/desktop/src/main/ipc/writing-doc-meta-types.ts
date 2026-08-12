// 写作左栏「文稿列表」元信息 IPC 契约（writing:docMeta）。
// ⚠️ 与 packages/core/desktop/writing-doc-meta-types.ts 逐字镜像（双写契约，改一处必须改两处）。
//
// 左栏要展示「创建时间 / 概要」并支持按时间排序，需要文件树之外的 stat + 正文首段；
// 逐文件 IPC 会把一次展开放大成 N 次往返，故设计成一次请求一批路径的批量通道。

// 请求：一批文档绝对路径 + 是否需要正文摘要。
// withExcerpt=false（左栏未开「显示概要」）时只 stat 不读盘，省掉整批文件的读取开销。
export interface WritingDocMetaRequest {
  paths: string[];
  withExcerpt?: boolean;
}

// 单个文档元信息。取不到 stat 的路径（列举后被删 / 越权）不会出现在结果里，
// 渲染端按「缺失即降级」处理（不显示时间与概要，排序按 0 兜底）。
export interface WritingDocMetaItem {
  path: string;
  mtimeMs: number;
  // 创建时间；部分文件系统不提供 birthtime（回 0）时回落 mtimeMs，避免 UI 显示 1970。
  birthtimeMs: number;
  // 正文摘要：已剥 frontmatter / 标题 / markdown 记号，≤50 字符（超出带省略号）。
  // withExcerpt=false 或非 markdown 文件时为空串。
  excerpt: string;
}

export interface WritingDocMetaResult {
  items: WritingDocMetaItem[];
}
