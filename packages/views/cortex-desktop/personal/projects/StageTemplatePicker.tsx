// 新建项目的阶段模板选择对话框（参照 IFocus 新建项目必选模板）：列出内置 + 自定义模板
// （mergeTemplates 合并），每项显示「N 个阶段」与链式预览；选中即回调创建。
// Esc / 遮罩点击 = 取消本次新建（不建项目）。骨架复用 pw-dlg-overlay / pw-search-* 类。
import { useStageTemplates } from "@cortex-work/core/personal/tasks";
import { mergeTemplates } from "@cortex-work/core/personal/stageTemplates";
import type { StageTemplate } from "@cortex-work/core/desktop/types";

export function StageTemplatePicker({
  projectName,
  onPick,
  onCancel,
}: {
  projectName: string;
  onPick: (template: StageTemplate) => void;
  onCancel: () => void;
}) {
  const templates = mergeTemplates(useStageTemplates().data ?? []);

  return (
    <div className="pw-dlg-overlay" onClick={onCancel}>
      <div
        className="pw-dlg pw-search-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="选择阶段模板"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <div className="pw-tplpick-head">
          为「{projectName}」选择阶段模板
          <span className="pw-tplpick-hint">Esc 取消新建</span>
        </div>
        <div className="pw-search-list">
          {templates.map((t) => (
            <button key={t.id} className="pw-search-row pw-tplpick-row" onClick={() => onPick(t)}>
              <span className="pw-tplpick-main">
                <span className="pw-tplpick-name">
                  {t.name}
                  {t.builtin ? <span className="pw-ps-builtin-badge">内置</span> : null}
                </span>
                <span className="pw-tplpick-stages">
                  {t.stages.length === 0 ? "无阶段" : t.stages.join(" › ")}
                </span>
              </span>
              <span className="pw-search-row-meta">{t.stages.length ? `${t.stages.length} 个阶段` : ""}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
