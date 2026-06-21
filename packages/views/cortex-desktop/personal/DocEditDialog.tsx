// tasks 文档「二次编辑」弹框:写调整意见 → 拼「意见 + 文档上下文」→ 复用 personal store 的
// insertToComposer / sendToTerminal 发到当前会话聊天框或终端。聊天框额外支持「插入并运行」
// （insertToComposer 带 submit 标志,由 ComposerShell 插入后自动提交;运行中/无会话则降级为仅插入）。
// 遮罩与面板**只局限在右栏文档区**（pw-doc-edit-overlay 为 position:absolute,
// 盖住作为定位祖先的 .pw-todo-detail）,不弹整个 App 的全屏遮罩。沿用 pw-confirm-dlg
// 的紧凑纵向布局（标题 / 意见输入 + 上下文 / 动作）+ stopPropagation + ESC 关闭。

import { useEffect, useMemo, useState } from "react";
import { usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { buildContextSnippet, buildPathRef, wrapBracketedPaste } from "./sendContext";

export function DocEditDialog({
  path,
  selection,
  onClose,
  onToast,
}: {
  /** 目标文档的仓库相对路径。 */
  path: string;
  /** 打开弹框瞬间抓取的选中段落（渲染文本;无选区为空串）。 */
  selection: string;
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("files");
  const [comment, setComment] = useState("");

  // ESC 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 上下文块:有选区套代码围栏,无选区只引用路径（避免空围栏,见 sendContext.buildPathRef）。
  const hasSel = selection.trim().length > 0;
  const context = useMemo(
    () => (hasSel ? buildContextSnippet(path, selection) : buildPathRef(path)),
    [hasSel, path, selection],
  );

  // 最终文本:意见在前、上下文在后（R4）。
  const buildText = () => `${comment.trim()}\n\n${context}`;
  const canSend = comment.trim().length > 0;

  const insertToChat = (submit: boolean) => {
    usePersonalStore.getState().insertToComposer(buildText(), { submit });
    onToast(t("insertedToComposer"));
    onClose();
  };

  const sendToTerminal = () => {
    usePersonalStore.getState().sendToTerminal(wrapBracketedPaste(buildText()));
    onToast(t("sentToTerminal"));
    onClose();
  };

  return (
    <div className="pw-doc-edit-overlay" onClick={onClose}>
      <div
        className="pw-confirm-dlg pw-doc-edit-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={t("docEdit.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pw-confirm-head">{t("docEdit.title")}</div>
        <div className="pw-confirm-body">
          <textarea
            className="pw-set-input"
            autoFocus
            rows={4}
            placeholder={t("docEdit.placeholder")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="pw-doc-edit-ctx" title={path}>
            <span className="pw-doc-edit-ctx-lbl">{t("docEdit.contextLabel")}</span>
            <code>{path}</code>
            {hasSel ? null : <span className="pw-doc-edit-ctx-empty">{t("docEdit.noSelection")}</span>}
          </div>
        </div>
        <div className="pw-confirm-foot">
          <button className="btn" onClick={onClose}>
            {t("docEdit.cancel")}
          </button>
          <button className="btn" disabled={!canSend} onClick={sendToTerminal}>
            {t("sendToTerminalBtn")}
          </button>
          <button className="btn" disabled={!canSend} onClick={() => insertToChat(false)}>
            {t("docEdit.insertToChat")}
          </button>
          <button className="btn primary" disabled={!canSend} onClick={() => insertToChat(true)}>
            {t("docEdit.insertAndRun")}
          </button>
        </div>
      </div>
    </div>
  );
}
