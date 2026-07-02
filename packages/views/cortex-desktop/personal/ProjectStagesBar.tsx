// 项目阶段栏（参照 IFocus 项目详情「阶段」区）：「全部」+ 各阶段 tab（状态色圆点）+「添加」内联
// 输入 + 列表/timeline 视图切换按钮组。阶段编辑（重命名/状态/起止日期/删除）走每 tab 的编辑浮层，
// 全部经 useUpdateTaskProject 整表替换 stages 落库（store 同锁清孤儿 stageId）。
import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useUpdateTaskProject } from "@cortex-work/core/personal/tasks";
import { sortStages, STAGE_STATUS_META } from "@cortex-work/core/personal/projectStages";
import type { ProjectStage, TaskProject } from "@cortex-work/core/desktop/types";
import { useDismissableMenu } from "./useDismissableMenu";
import { useMenuViewportClamp } from "./useMenuViewportClamp";

export type StageViewMode = "list" | "timeline";

// 渲染端阶段 id 生成（main 侧 newTaskId 同形；阶段实例是项目内自持小数组，渲染端生成即可）。
function newStageId(): string {
  return `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 单阶段编辑浮层：重命名 / 状态 / 起止日期 / 删除（两步确认）。
// 编辑动作全部回调 onReplace（父组件组装整表 stages 提交）。
function StageEditMenu({
  stage,
  onPatch,
  onDelete,
  onClose,
}: {
  stage: ProjectStage;
  onPatch: (patch: Partial<ProjectStage>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(stage.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const commitName = () => {
    const v = name.trim();
    if (v && v !== stage.name) onPatch({ name: v });
  };

  return (
    <div className="pw-stage-edit" role="dialog" aria-label={`编辑阶段「${stage.name}」`}>
      <div className="pw-ps-field-label">阶段名称</div>
      <input
        className="pw-ps-input"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitName();
        }}
      />
      <div className="pw-ps-field-label">状态</div>
      <div className="pw-ps-chip-row">
        {STAGE_STATUS_META.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`pw-ps-chip${stage.status === m.value ? " is-on" : ""}`}
            onClick={() => onPatch({ status: m.value })}
          >
            <span className={`pw-stage-dot pw-stage-dot--${m.value}`} aria-hidden />
            {m.label}
          </button>
        ))}
      </div>
      {/* 起止日期（YYYY-MM-DD 本地日历日，与任务日期同语义）：timeline 据此画条，清空即不上时间线。 */}
      <div className="pw-ps-field-label">开始日期</div>
      <input
        type="date"
        className="pw-ps-input"
        value={stage.startDate ?? ""}
        onChange={(e) => onPatch({ startDate: e.target.value || undefined })}
      />
      <div className="pw-ps-field-label">结束日期</div>
      <input
        type="date"
        className="pw-ps-input"
        value={stage.dueDate ?? ""}
        onChange={(e) => onPatch({ dueDate: e.target.value || undefined })}
      />
      <div className="pw-ps-form-actions">
        {confirmingDelete ? (
          <>
            <button className="pw-ps-btn pw-ps-btn--danger" onClick={onDelete}>
              确认删除
            </button>
            <button className="pw-ps-btn" onClick={() => setConfirmingDelete(false)}>
              取消
            </button>
          </>
        ) : (
          <>
            <button className="pw-ps-btn pw-ps-btn--danger" onClick={() => setConfirmingDelete(true)}>
              删除阶段
            </button>
            <button className="pw-ps-btn" onClick={onClose}>
              关闭
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ProjectStagesBar({
  project,
  activeStageId,
  onStageChange,
  view,
  onViewChange,
  onToast,
}: {
  project: TaskProject;
  // 当前阶段过滤：null = 全部。
  activeStageId: string | null;
  onStageChange: (id: string | null) => void;
  view: StageViewMode;
  onViewChange: (v: StageViewMode) => void;
  onToast: (text: string) => void;
}) {
  const updateProject = useUpdateTaskProject();
  const stages = sortStages(project.stages ?? []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // 单开的阶段编辑浮层（editingStageId 定位到某 tab 下方）。
  // 表单型浮层（含原生 date input）：不挂 hover 自动收起、不随 window blur 关闭——
  // 原生日期日历是系统弹层（DOM 外且抢窗口焦点），否则鼠标一进日历浮层就消失（bug 报告）。
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const { open, setOpen, wrapRef } = useDismissableMenu({ closeOnWindowBlur: false });
  const { menuRef, clampStyle } = useMenuViewportClamp(open && editingStageId != null);
  // 浮层被外点/Esc 关闭后同步清 editingStageId（open 是 useDismissableMenu 内部态）。
  useEffect(() => {
    if (!open) setEditingStageId(null);
  }, [open]);

  // 整表替换提交（阶段是项目自持小数组；被删阶段的任务 stageId 由 store 同锁清理）。
  const replaceStages = (next: ProjectStage[]) =>
    updateProject.mutate(
      { id: project.id, patch: { stages: next } },
      { onError: () => onToast("保存阶段失败，请重试") },
    );

  const addStage = () => {
    const v = draft.trim();
    setDraft("");
    setAdding(false);
    if (!v) return;
    const order = stages.length ? Math.max(...stages.map((s) => s.order)) + 1 : 0;
    replaceStages([...stages, { id: newStageId(), name: v, status: "not-started", order }]);
  };
  const patchStage = (id: string, patch: Partial<ProjectStage>) =>
    replaceStages(stages.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const deleteStage = (id: string) => {
    setOpen(false);
    if (activeStageId === id) onStageChange(null); // 过滤指向被删阶段 → 回「全部」
    replaceStages(stages.filter((s) => s.id !== id));
  };

  const editingStage = editingStageId ? stages.find((s) => s.id === editingStageId) : undefined;

  return (
    <div className="pw-stages-bar">
      <div className="pw-stages-label">阶段</div>
      <div className="pw-stages-tabs" ref={wrapRef}>
        <button
          className={`pw-stage-tab${activeStageId === null ? " is-on" : ""}`}
          onClick={() => onStageChange(null)}
        >
          全部
        </button>
        {stages.map((s) => (
          <span key={s.id} className="pw-stage-tab-wrap">
            <button
              className={`pw-stage-tab${activeStageId === s.id ? " is-on" : ""}`}
              onClick={() => onStageChange(s.id)}
              // 右键直接开编辑浮层（悬停铅笔同门）。
              onContextMenu={(e) => {
                e.preventDefault();
                setEditingStageId(s.id);
                setOpen(true);
              }}
            >
              <span className={`pw-stage-dot pw-stage-dot--${s.status}`} aria-hidden />
              {s.name}
            </button>
            <button
              className="pw-stage-tab-edit"
              title={`编辑阶段「${s.name}」`}
              aria-label={`编辑阶段「${s.name}」`}
              onClick={() => {
                setEditingStageId(s.id);
                setOpen(true);
              }}
            >
              <Icon.Edit size={11} />
            </button>
            {/* 编辑浮层锚在当前 tab 下方。 */}
            {open && editingStage && editingStage.id === s.id ? (
              <div className="pw-view-options pw-stage-edit-pop" ref={menuRef} style={clampStyle}>
                <StageEditMenu
                  stage={editingStage}
                  onPatch={(p) => patchStage(s.id, p)}
                  onDelete={() => deleteStage(s.id)}
                  onClose={() => setOpen(false)}
                />
              </div>
            ) : null}
          </span>
        ))}
        {adding ? (
          <input
            className="pw-ps-chip-input"
            placeholder="阶段名，回车添加"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={addStage}
            onKeyDown={(e) => {
              if (e.key === "Enter") addStage();
              if (e.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
          />
        ) : (
          <button className="pw-stage-add" onClick={() => setAdding(true)}>
            <Icon.Plus size={12} />
            添加
          </button>
        )}
      </div>
      {/* 列表 / timeline 视图切换。 */}
      <div className="pw-stages-viewswitch" role="group" aria-label="视图切换">
        <button
          className={`pw-ps-icon-btn${view === "list" ? " is-on" : ""}`}
          title="列表视图"
          aria-pressed={view === "list"}
          onClick={() => onViewChange("list")}
        >
          <Icon.Sort size={14} />
        </button>
        <button
          className={`pw-ps-icon-btn${view === "timeline" ? " is-on" : ""}`}
          title="Timeline 视图"
          aria-pressed={view === "timeline"}
          onClick={() => onViewChange("timeline")}
        >
          <Icon.Chart size={14} />
        </button>
      </div>
    </div>
  );
}
