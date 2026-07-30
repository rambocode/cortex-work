// 表格批注侧栏:显示当前选区、录入批注文字、批注列表增删、一键发送到会话 composer。
// 批注是 UI 层临时态(不写入表格文件),数据模型与 prompt 合成见 core/personal/sheet-annotation。
import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { SheetAnnotation } from "@cortex-work/core/personal/sheet-annotation";
import type { SheetSelectionInfo } from "./useSheetSync";

export function SheetAnnotationPanel({
  annotations,
  selection,
  onAdd,
  onRemove,
  onSend,
  onClose,
}: {
  annotations: SheetAnnotation[];
  selection: SheetSelectionInfo | null;
  // 以当前选区新增一条批注(note 为用户输入,面板不关心选区细节,由容器组装完整对象)。
  onAdd: (note: string) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("files");
  const [note, setNote] = useState("");

  const submit = () => {
    const text = note.trim();
    if (!text || !selection) return;
    onAdd(text);
    setNote("");
  };

  return (
    <div className="pw-sheet-side">
      <div className="pw-sheet-side-h">
        <span>{t("sheet.annotationTitle")}</span>
        <div className="spacer" />
        <button className="pw-icon-btn" title={t("sheet.closePanel")} onClick={onClose}>
          <Icon.X size={12} />
        </button>
      </div>
      <div className="pw-sheet-side-sel">
        {selection ? (
          <>
            <span className="pw-sheet-sel-range">
              {selection.sheetName} · {selection.rangeA1}
            </span>
            {selection.valueSnapshot ? <span className="pw-sheet-sel-val">{selection.valueSnapshot}</span> : null}
          </>
        ) : (
          <span className="pw-sheet-sel-empty">{t("sheet.noSelection")}</span>
        )}
      </div>
      <div className="pw-sheet-side-input">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("sheet.notePlaceholder")}
          rows={3}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter 快速添加(textarea 里普通 Enter 保留换行)。
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="pw-ftb-btn" onClick={submit} disabled={!note.trim() || !selection}>
          <Icon.Check size={12} />
          {t("sheet.addNote")}
        </button>
      </div>
      <div className="pw-sheet-side-list">
        {annotations.length === 0 ? (
          <div className="pw-empty-hint">{t("sheet.annotationEmpty")}</div>
        ) : (
          annotations.map((a) => (
            <div key={a.id} className="pw-sheet-note">
              <div className="pw-sheet-note-head">
                <span className="pw-sheet-note-range">
                  {a.sheetName} · {a.rangeA1}
                </span>
                <div className="spacer" />
                <button className="pw-icon-btn" title={t("sheet.removeNote")} onClick={() => onRemove(a.id)}>
                  <Icon.X size={11} />
                </button>
              </div>
              {a.valueSnapshot ? <div className="pw-sheet-note-val">{a.valueSnapshot}</div> : null}
              <div className="pw-sheet-note-text">{a.note}</div>
            </div>
          ))
        )}
      </div>
      <div className="pw-sheet-side-f">
        <button className="pw-ftb-btn is-primary" onClick={onSend} disabled={annotations.length === 0}>
          <Icon.Send size={12} />
          {t("sheet.sendAnnotations", { count: annotations.length })}
        </button>
      </div>
    </div>
  );
}
