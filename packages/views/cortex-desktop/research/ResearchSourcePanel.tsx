// Deep Research 右栏：来源列表与证据正文。
//
// **按需加载是硬约束（spec §16）**：evidence 级别的详情包含全部抓取正文，可能是几 MB 的文本。
// 挂载时**绝不**预取——那会让「打开工作区」这个动作把整个证据库读进渲染进程内存，
// 既慢又把正文暴露在一个用户根本没打算看的界面里。只有用户显式点「展开来源」才发起 get。
//
// 展开单条来源不再二次请求：一次 evidence 拉取已经把该会话的 documents + chunks 都带回来了，
// 逐条再请求纯属浪费（数据源是本机 SQLite + blob，一次读完最省）。
import { useEffect, useState, type ReactElement } from "react";
import type {
  EvidenceChunk,
  ResearchDocument,
} from "@cortex-work/core/research/evidence";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";

/// 来源面板的 props。
export interface ResearchSourcePanelProps {
  /// 为 null 表示没有桌面桥（Web 端）：展开按钮禁用，只显示说明。
  bridge: ResearchBridgeLike | null;
  session: ResearchSessionSummary | null;
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

interface LoadedEvidence {
  documents: ResearchDocument[];
  chunks: EvidenceChunk[];
}

/// 来源/证据面板。**懒加载是刻意的**：挂载时不发任何请求，只有用户点「展开来源」才拉
/// detail="evidence"；切换会话时收起并丢弃上一会话证据，且不自动重拉。
export function ResearchSourcePanel({ bridge, session }: ResearchSourcePanelProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<LoadedEvidence | null>(null);
  const [openDocId, setOpenDocId] = useState<string | null>(null);

  const sessionId = session?.sessionId ?? null;

  // 换会话时收起并丢弃上一会话的证据：留着既是内存浪费，也可能让用户以为看的是当前会话的来源。
  // 注意这里刻意**不**自动重新拉取——新会话同样要用户显式展开。
  useEffect(() => {
    setExpanded(false);
    setEvidence(null);
    setError(null);
    setOpenDocId(null);
  }, [sessionId]);

  const load = async (): Promise<void> => {
    if (!bridge || !sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const view = await bridge.get(sessionId, "evidence");
      setEvidence({ documents: view.documents ?? [], chunks: view.chunks ?? [] });
      setExpanded(true);
    } catch (e) {
      setError(`加载来源失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  if (!session) {
    return (
      <div className="pw-res-sources">
        <div className="pw-res-empty">未选中研究</div>
      </div>
    );
  }

  return (
    <div className="pw-res-sources">
      <div className="pw-res-sources-head">
        <span className="pw-res-sources-title">来源</span>
        {expanded ? (
          <button type="button" className="pw-res-btn is-ghost" onClick={() => setExpanded(false)}>
            收起
          </button>
        ) : (
          <button
            type="button"
            className="pw-res-btn"
            disabled={!bridge || loading}
            onClick={() => (evidence ? setExpanded(true) : void load())}
          >
            {`展开来源（${session.documentCount}）`}
          </button>
        )}
      </div>

      {!expanded && !error ? (
        <div className="pw-res-hint">证据正文按需加载，展开后才会读取抓取内容</div>
      ) : null}
      {loading ? <div className="pw-res-hint">加载中…</div> : null}
      {error ? (
        <div className="pw-res-error">
          <span>{error}</span>
          <button type="button" className="pw-res-btn" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {expanded && evidence ? (
        <div className="pw-res-doclist">
          {evidence.documents.length === 0 ? (
            <div className="pw-res-empty">这次研究还没有采信任何来源</div>
          ) : null}
          {evidence.documents.map((doc) => {
            const open = openDocId === doc.documentId;
            const chunks = open
              ? evidence.chunks.filter((c) => c.documentId === doc.documentId)
              : [];
            return (
              <div key={doc.documentId} className={`pw-res-doc${open ? " is-open" : ""}`}>
                <div
                  className="pw-res-doc-head"
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenDocId(open ? null : doc.documentId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setOpenDocId(open ? null : doc.documentId);
                  }}
                >
                  <span className="pw-res-doc-title">{doc.title}</span>
                  <span className="pw-res-doc-meta">
                    <span className="pw-res-doc-domain">{doc.source.domain ?? doc.source.locator}</span>
                    <span className="pw-res-doc-method">
                      {FETCH_METHOD_LABELS[doc.fetchMethod] ?? doc.fetchMethod}
                    </span>
                    <span className="pw-res-doc-time">{shortTime(doc.fetchedAt)}</span>
                  </span>
                </div>
                {open ? (
                  <div className="pw-res-doc-chunks">
                    {chunks.length === 0 ? (
                      <div className="pw-res-hint">该来源没有可展示的证据片段</div>
                    ) : null}
                    {chunks.map((c) => (
                      <div key={c.chunkId} className="pw-res-chunk">
                        {c.headingPath && c.headingPath.length > 0 ? (
                          <div className="pw-res-chunk-path">{c.headingPath.join(" › ")}</div>
                        ) : null}
                        <div className="pw-res-chunk-text">{c.text}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
