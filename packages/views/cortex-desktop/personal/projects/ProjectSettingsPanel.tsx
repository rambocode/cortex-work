// 项目设置面板（参照 IFocus 项目详情齿轮弹出）：编辑名称 / 状态 / 备注 / 应用阶段模板，删除项目
// 需输入项目名精确匹配才可执行（防误删；删除语义沿用 store deleteProject——子节点上提、任务回收件箱）。
// 应用模板 = 复制实例化替换现有 stages（与模板解耦；被删阶段的任务 stageId 由 store 同锁清理），
// 已有阶段时两步确认防误替换。定位挂在齿轮按钮下方（useDismissableMenu + viewport clamp）。
import { useState } from "react";
import { useDeleteTaskProject, useStageTemplates, useUpdateTaskProject } from "@cortex-work/core/personal/tasks";
import { instantiateStages, mergeTemplates } from "@cortex-work/core/personal/stageTemplates";
import type { TaskProject, TaskProjectStatus } from "@cortex-work/core/desktop/types";

// 渲染端阶段实例 id 生成（与 ProjectStagesBar/ProjectTree 同形）。
function newStageId(): string {
  return `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 项目状态四态元数据（与 TaskProjectStatus 对齐；缺省视为 active）。
const PROJECT_STATUS_META: readonly { value: TaskProjectStatus; label: string }[] = [
  { value: "active", label: "进行中" },
  { value: "on-hold", label: "暂停" },
  { value: "done", label: "已完成" },
  { value: "dropped", label: "已丢弃" },
];

export function ProjectSettingsPanel({
  project,
  onClose,
  onToast,
}: {
  project: TaskProject;
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const updateProject = useUpdateTaskProject();
  const deleteProject = useDeleteTaskProject();
  const templates = mergeTemplates(useStageTemplates().data ?? []);
  const [name, setName] = useState(project.name);
  const [note, setNote] = useState(project.note ?? "");
  const [deleteDraft, setDeleteDraft] = useState("");
  // 应用阶段模板：选中的模板 id + 已有阶段时的两步确认态。
  const [templateId, setTemplateId] = useState("");
  const [confirmingApply, setConfirmingApply] = useState(false);
  const status = project.status ?? "active";
  const hasStages = (project.stages?.length ?? 0) > 0;
  // 删除按钮解锁条件：输入与项目名**精确**一致（不 trim 两侧空格差异之外的内容）。
  const deleteUnlocked = deleteDraft.trim() === project.name;

  const patch = (p: Parameters<typeof updateProject.mutate>[0]["patch"]) =>
    updateProject.mutate({ id: project.id, patch: p }, { onError: () => onToast("保存项目设置失败，请重试") });

  // 名称失焦/回车保存（空名忽略回退原名）。
  const commitName = () => {
    const v = name.trim();
    if (!v) {
      setName(project.name);
      return;
    }
    if (v !== project.name) patch({ name: v });
  };
  const commitNote = () => {
    if (note !== (project.note ?? "")) patch({ note });
  };

  return (
    <div className="pw-proj-settings" role="dialog" aria-label="项目设置">
      <div className="pw-ps-field-label">项目名称</div>
      <input
        className="pw-ps-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitName();
        }}
      />

      <div className="pw-ps-field-label">状态</div>
      <div className="pw-ps-chip-row">
        {PROJECT_STATUS_META.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`pw-ps-chip${status === m.value ? " is-on" : ""}`}
            onClick={() => patch({ status: m.value })}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="pw-ps-field-label">描述 / 备注</div>
      <textarea
        className="pw-ps-input pw-proj-settings-note"
        rows={3}
        placeholder="项目描述…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={commitNote}
      />

      {/* 应用阶段模板：复制实例化替换现有 stages（与模板解耦）。已有阶段时两步确认——
          替换会清掉任务上指向被删阶段的 stageId（store 同锁级联）。 */}
      <div className="pw-ps-field-label">阶段模板</div>
      <div className="pw-proj-settings-danger-row">
        <select
          className="pw-ps-input pw-proj-settings-tpl"
          aria-label="选择阶段模板"
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            setConfirmingApply(false);
          }}
        >
          <option value="">选择模板…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.stages.length ? `（${t.stages.length} 个阶段）` : "（无阶段）"}
            </option>
          ))}
        </select>
        <button
          className={`pw-ps-btn${confirmingApply ? " pw-ps-btn--danger" : " pw-ps-btn--primary"}`}
          disabled={!templateId}
          onClick={() => {
            const tpl = templates.find((t) => t.id === templateId);
            if (!tpl) return;
            // 已有阶段：首击进入确认态（替换会移除现有阶段并清任务归属），再击才执行。
            if (hasStages && !confirmingApply) {
              setConfirmingApply(true);
              return;
            }
            setConfirmingApply(false);
            setTemplateId("");
            patch({ stages: instantiateStages(tpl.stages, newStageId) });
            onToast(`已按「${tpl.name}」应用阶段模板`);
          }}
        >
          {confirmingApply ? "确认替换" : "应用"}
        </button>
      </div>
      {confirmingApply ? (
        <div className="pw-proj-settings-danger-hint">将替换现有 {project.stages!.length} 个阶段，任务的阶段归属会被清空。</div>
      ) : null}

      {/* 危险区：输入项目名精确匹配才解锁删除（删除后子节点上提、任务回收件箱）。 */}
      <div className="pw-proj-settings-danger">
        <div className="pw-ps-field-label">删除项目</div>
        <div className="pw-proj-settings-danger-hint">
          删除后其子节点将上提一层、任务移回收件箱。输入项目名「{project.name}」确认：
        </div>
        <div className="pw-proj-settings-danger-row">
          <input
            className="pw-ps-input"
            placeholder={project.name}
            value={deleteDraft}
            onChange={(e) => setDeleteDraft(e.target.value)}
          />
          <button
            className="pw-ps-btn pw-ps-btn--danger"
            disabled={!deleteUnlocked}
            onClick={() => {
              deleteProject.mutate(project.id, { onError: () => onToast("删除项目失败，请重试") });
              onClose();
            }}
          >
            删除
          </button>
        </div>
      </div>

      <div className="pw-ps-form-actions">
        <button className="pw-ps-btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
