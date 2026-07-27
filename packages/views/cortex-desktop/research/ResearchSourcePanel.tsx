// Deep Research 右栏：单条引用的详情面板（来源信息 + 证据正文）。
//
// **本组件是纯展示的受控组件**：fetch、缓存、「按需加载」时序全部在 useResearchSessionDetail——
// 面板关闭即卸载，fetch 逻辑若留在这里，缓存会随卸载丢失、每次打开都重拉几 MB 正文。
// 宿主只在用户点击报告里的引用后才拉 evidence（spec §16），再把结果注入这里。
//
// 曾是「完整来源列表 + 展开来源」面板，后因日常使用价值低、常驻挤占中栏宽度而砍掉：
// 右栏默认隐藏，只在点击引用时出现，且只显示被点的那一条。
import type { ReactElement } from "react";
import type {
  EvidenceChunk,
  ResearchDocument,
} from "@cortex-work/core/research/evidence";

/// 当前聚焦的引用。chunkId 用于在 evidence 里定位证据；index/title/url 是兜底展示信息
/// （chunk 缺失时只有这些可显示）。
export interface FocusedCitation {
  index: number;
  chunkId: string;
  title?: string;
  url?: string;
}

/// 引用详情面板的 props。evidence 为 null 表示还没拉回来（配合 loading/error 展示进度）。
export interface ResearchSourcePanelProps {
  citation: FocusedCitation;
  evidence: { documents: ResearchDocument[]; chunks: EvidenceChunk[] } | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}

/// 抓取方式的中文标签。browser 单独标出来是因为它是成本最高的降级路径，
/// 用户看到「浏览器抓取」就知道这条来源为什么慢/为什么占了额度。
const FETCH_METHOD_LABELS: Record<string, string> = {
  http: "直接抓取",
  browser: "浏览器抓取",
  pdf: "PDF 解析",
  local_file: "本地文件",
};

/// ISO → 「MM-DD HH:mm」；非法值原样返回（脏数据不应打崩面板）。
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/// 单条引用的详情面板：头部是「[n] 标题 + 关闭」，正文是该引用的来源元信息与证据片段。
export function ResearchSourcePanel({
  citation,
  evidence,
  loading,
  error,
  onRetry,
  onClose,
}: ResearchSourcePanelProps): ReactElement {
  const chunk = evidence?.chunks.find((c) => c.chunkId === citation.chunkId) ?? null;
  const doc = chunk
    ? evidence?.documents.find((d) => d.documentId === chunk.documentId) ?? null
    : null;

  return (
    <div className="pw-res-sources">
      <div className="pw-res-sources-head">
        <span className="pw-res-sources-title">
          {`[${citation.index}] ${citation.title ?? citation.chunkId}`}
        </span>
        <button
          type="button"
          className="pw-res-btn is-ghost"
          aria-label="关闭引用详情"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      {loading ? <div className="pw-res-hint">加载中…</div> : null}
      {error ? (
        <div className="pw-res-error">
          <span>{error}</span>
          <button type="button" className="pw-res-btn" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !error && evidence ? (
        chunk ? (
          <div className="pw-res-doc">
            {/* 标题不重复：面板头部已是「[n] 标题」，这里只给来源元信息 + 证据正文。 */}
            {doc ? (
              <div className="pw-res-doc-meta">
                <span className="pw-res-doc-domain">{doc.source.domain ?? doc.source.locator}</span>
                <span className="pw-res-doc-method">
                  {FETCH_METHOD_LABELS[doc.fetchMethod] ?? doc.fetchMethod}
                </span>
                <span className="pw-res-doc-time">{shortTime(doc.fetchedAt)}</span>
              </div>
            ) : null}
            <div className="pw-res-chunk">
              {chunk.headingPath && chunk.headingPath.length > 0 ? (
                <div className="pw-res-chunk-path">{chunk.headingPath.join(" › ")}</div>
              ) : null}
              <div className="pw-res-chunk-text">{chunk.text}</div>
            </div>
          </div>
        ) : (
          // 报告重生成后旧聚焦可能指向已被移除的证据：降级展示兜底信息，不崩不空白。
          <div className="pw-res-hint">
            未找到对应证据片段（报告可能已重新生成）。
            {citation.url ? <div className="pw-res-chunk-text">{citation.url}</div> : null}
          </div>
        )
      ) : null}
    </div>
  );
}
