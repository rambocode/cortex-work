// 项目设置面板（参照 IFocus 项目详情齿轮弹出）：编辑名称 / 状态 / 备注，删除项目需输入项目名精确
// 匹配才可执行（防误删；删除语义沿用 store deleteProject——子节点上提、任务回收件箱）。
// 定位挂在齿轮按钮下方（useDismissableMenu 外点/Esc 关闭 + useMenuViewportClamp 收敛回视口）。
import { useState } from "react";
import { useDeleteTaskProject, useUpdateTaskProject } from "@cortex-work/core/personal/tasks";
import type { TaskProject, TaskProjectStatus } from "@cortex-work/core/desktop/types";

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
  const [name, setName] = useState(project.name);
  const [note, setNote] = useState(project.note ?? "");
  const [deleteDraft, setDeleteDraft] = useState("");
  const status = project.status ?? "active";
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
