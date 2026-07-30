// 结构化建议 chips（U7）：把 U6 引擎产出的建议以非侵入 chips 就地呈现，逐字段接受/忽略，
// 忽略零惩罚（不改任务）。迟到冲突（目标字段已被用户手填）由调用方在 accept 前判断，这里只渲染。
import type { StructureSuggestion } from "@cortex-work/core/personal/taskStructure";

export function SuggestionChips({
  suggestion,
  onAccept,
  onDismiss,
  onDismissAll,
  onAcceptAll,
}: {
  suggestion: StructureSuggestion;
  onAccept: (field: keyof StructureSuggestion) => void;
  onDismiss: (field: keyof StructureSuggestion) => void;
  onDismissAll: () => void;
  onAcceptAll: () => void;
}) {
  const chips: Array<{ field: keyof StructureSuggestion; label: string }> = [];
  if (suggestion.dueDate) chips.push({ field: "dueDate", label: `截止 ${suggestion.dueDate}` });
  if (suggestion.deferDate) chips.push({ field: "deferDate", label: `延后至 ${suggestion.deferDate}` });
  if (suggestion.tags?.length) chips.push({ field: "tags", label: suggestion.tags.join(" ") });
  if (suggestion.projectName) chips.push({ field: "projectName", label: `项目 ${suggestion.projectName}` });
  if (chips.length === 0) return null;

  return (
    <div className="pw-task-suggest" role="group" aria-label="结构化建议">
      <span className="pw-task-suggest-hint">建议：</span>
      {chips.map((c) => (
        <span key={c.field} className="pw-task-suggest-chip">
          <button className="pw-chip-accept" title="接受" onClick={() => onAccept(c.field)}>
            {c.label}
          </button>
          <button className="pw-chip-dismiss" title="忽略" onClick={() => onDismiss(c.field)}>
            ×
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <>
          <button className="pw-chip-all" onClick={onAcceptAll}>
            全部接受
          </button>
          <button className="pw-chip-all" onClick={onDismissAll}>
            全部忽略
          </button>
        </>
      )}
    </div>
  );
}
