// 右栏的知识库文档预览面板：点会话正文里的 kb:// 引用后在此渲染文档正文。
//
// 正文经 bridge.knowledge.readDoc 从远端拉取（主进程自己的 MCP 通道），
// 用共享的 MarkdownView 渲染——与 tasks 详情、文件预览保持同一套排版。
//
// 非纯文本文档（PDF / Office）拿到的是索引时抽取的文本，排版会丢失，
// 服务端会在 note 里说明这一点，原样透出给用户，避免他们把抽取文本当成原件。
import { useEffect, useState } from "react";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { KnowledgeDocResult } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { MarkdownView } from "../markdown/MarkdownView";

export function KnowledgeDocPanel() {
  const bridge = useDesktopBridge();
  // 统一面板请求槽是单槽 last-wins:别的面板一发请求,这里的选择器就变回 undefined。
  // 把最近一次请求的坐标拷进本地 seed,渲染与空态判断只读本地——否则已打开的文档
  // 会被无关面板的后续请求打回空态(本次迁移唯一需要改消费端状态模型的面板)。
  const incoming = usePersonalStore((s) =>
    s.panelRequest?.panelId === "knowledge" ? s.panelRequest : undefined,
  );
  const [req, setReq] = useState<{ sourceId: string; relPath: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!incoming) return;
    const payload = incoming.payload as { sourceId: string; relPath: string } | undefined;
    if (!payload) return;
    setReq({ sourceId: payload.sourceId, relPath: payload.relPath, nonce: incoming.nonce });
  }, [incoming]);
  const [doc, setDoc] = useState<KnowledgeDocResult | null>(null);
  const [loading, setLoading] = useState(false);

  // 依赖 nonce 而非整个对象：同一篇文档再次点击时 sourceId/relPath 不变，
  // 只有 nonce 变——不依赖它就不会重新拉取（用户会觉得「点了没反应」）。
  useEffect(() => {
    if (!req) return;
    const readDoc = bridge?.knowledge?.readDoc;
    if (!readDoc) {
      setDoc({ ok: false, message: "当前版本不支持预览知识库文档" });
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDoc(null);
    void readDoc({ sourceId: req.sourceId, relPath: req.relPath })
      .then((r) => {
        // 请求期间用户又点了别的文档 → 丢弃这次的结果，避免后到的旧响应覆盖新文档。
        if (!cancelled) setDoc(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setDoc({ ok: false, message: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [req?.nonce, req?.sourceId, req?.relPath, bridge]);

  if (!req) {
    return (
      <div className="pw-kbdoc pw-kbdoc-empty">
        <Icon.Archive size={20} />
        <p>点击回答里的知识库引用即可在此查看文档。</p>
      </div>
    );
  }

  const title = doc?.fileName || req.relPath.split("/").pop() || req.relPath;

  return (
    <div className="pw-kbdoc">
      <div className="pw-kbdoc-head">
        <Icon.Archive size={14} />
        <span className="pw-kbdoc-title" title={`${req.sourceId}/${req.relPath}`}>
          {title}
        </span>
        {doc?.ok && doc.totalRunes ? (
          <span className="pw-kbdoc-meta">{doc.totalRunes} 字</span>
        ) : null}
      </div>

      {loading ? (
        <div className="pw-kbdoc-state">正在读取…</div>
      ) : !doc ? null : !doc.ok ? (
        <div className="pw-kbdoc-state is-error">{doc.message ?? "读取失败"}</div>
      ) : (
        <>
          {/* 服务端附注：非纯文本格式提示、截断提示等，原样透出。 */}
          {doc.note ? <div className="pw-kbdoc-note">{doc.note}</div> : null}
          <div className="pw-kbdoc-body pw-todo-md">
            <MarkdownView content={doc.text ?? ""} />
          </div>
          {doc.hasMore ? (
            <div className="pw-kbdoc-note">
              文档较长，此处仅显示前一部分。完整内容请在知识库中查看。
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
