// 资源管理（参照 IFocus 设置页）：团队成员库 + 常用岗位/角色标签。
// 成员 CRUD 走 useMembers/useAddMember/...（tasks.json 落盘，跨窗口经 resources-changed 同步）；
// 岗位标签整表替换（useSetJobTypes），undefined 时经 resolveJobTypes 显示默认表。
// 删除成员会级联从任务 memberIds 解绑（store 同锁），删除按钮做两步确认防误删。
import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAddMember,
  useDeleteMember,
  useJobTypes,
  useMembers,
  useSetJobTypes,
  useUpdateMember,
} from "@cortex-work/core/personal/tasks";
import { resolveJobTypes, validateMemberInput } from "@cortex-work/core/personal/members";
import type { Member } from "@cortex-work/core/desktop/types";
import { MemberAvatar } from "../shared/MemberAvatar";

// 成员添加/编辑内联表单：姓名输入 + 岗位 chips 单选（点选中的再点取消）。
function MemberForm({
  initial,
  jobTypes,
  onSubmit,
  onCancel,
}: {
  initial?: Member;
  jobTypes: string[];
  onSubmit: (input: { name: string; role?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [error, setError] = useState<string | null>(null);
  // 编辑既有成员时其 role 可能已不在标签库（标签被删）——仍要展示为可选项，避免保存时被静默清掉。
  const roleOptions = role && !jobTypes.includes(role) ? [...jobTypes, role] : jobTypes;

  const submit = () => {
    const err = validateMemberInput({ name });
    if (err) {
      setError(err);
      return;
    }
    onSubmit({ name: name.trim(), role: role || undefined });
  };

  return (
    <div className="pw-ps-form" role="form" aria-label={initial ? "编辑成员" : "添加成员"}>
      <input
        className="pw-ps-input"
        placeholder="成员姓名"
        value={name}
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="pw-ps-chip-row" aria-label="选择岗位">
        {roleOptions.map((jt) => (
          <button
            key={jt}
            type="button"
            className={`pw-ps-chip${role === jt ? " is-on" : ""}`}
            onClick={() => setRole((cur) => (cur === jt ? "" : jt))}
          >
            {jt}
          </button>
        ))}
      </div>
      {error ? <div className="pw-ps-error">{error}</div> : null}
      <div className="pw-ps-form-actions">
        <button className="pw-ps-btn pw-ps-btn--primary" onClick={submit}>
          {initial ? "保存" : "添加"}
        </button>
        <button className="pw-ps-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// 岗位标签管理区：chips 可删 + 末尾「快速新增」输入（Enter 提交；重名忽略）。
function JobTypeChips({ onToast }: { onToast: (text: string) => void }) {
  const stored = useJobTypes().data;
  const jobTypes = resolveJobTypes(stored);
  const setJobTypes = useSetJobTypes();
  const [draft, setDraft] = useState("");

  const commit = (next: string[]) => {
    setJobTypes.mutate(next, { onError: () => onToast("保存岗位标签失败，请重试") });
  };
  const addDraft = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    if (jobTypes.includes(v)) return; // 重名忽略（对齐 IFocus）
    commit([...jobTypes, v]);
  };

  return (
    <div className="pw-ps-jobtypes">
      <div className="pw-ps-jobtypes-title">
        <Icon.Tags size={14} />
        常用岗位 / 角色
      </div>
      <div className="pw-ps-chip-row">
        {jobTypes.map((jt) => (
          <span key={jt} className="pw-ps-chip is-static">
            {jt}
            <button
              type="button"
              className="pw-ps-chip-x"
              title={`删除「${jt}」`}
              aria-label={`删除岗位「${jt}」`}
              onClick={() => commit(jobTypes.filter((x) => x !== jt))}
            >
              <Icon.X size={11} />
            </button>
          </span>
        ))}
        <input
          className="pw-ps-chip-input"
          placeholder="快速新增…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addDraft();
          }}
          onBlur={addDraft}
        />
      </div>
    </div>
  );
}

// 单个成员卡片：头像 + 姓名 + 岗位 tag + ID 截断；hover 出编辑/删除（删除两步确认）。
function MemberCard({
  member,
  jobTypes,
  onToast,
}: {
  member: Member;
  jobTypes: string[];
  onToast: (text: string) => void;
}) {
  const updateMember = useUpdateMember();
  const deleteMember = useDeleteMember();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (editing) {
    return (
      <div className="pw-ps-card">
        <MemberForm
          initial={member}
          jobTypes={jobTypes}
          onCancel={() => setEditing(false)}
          onSubmit={(input) => {
            // role 传空串 = 清除岗位（store 侧约定），与 undefined「不改」区分。
            updateMember.mutate(
              { id: member.id, patch: { name: input.name, role: input.role ?? "" } },
              { onError: () => onToast("保存成员失败，请重试") },
            );
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="pw-ps-card pw-ps-member-card">
      <MemberAvatar name={member.name} size={36} />
      <div className="pw-ps-member-main">
        <div className="pw-ps-member-name">
          {member.name}
          {member.role ? <span className="pw-ps-role-tag">{member.role}</span> : null}
        </div>
        <div className="pw-ps-member-id">ID: {member.id.slice(0, 14)}…</div>
      </div>
      <div className="pw-ps-card-actions">
        {confirmingDelete ? (
          <>
            <button
              className="pw-ps-btn pw-ps-btn--danger"
              onClick={() =>
                deleteMember.mutate(member.id, {
                  onError: () => onToast("删除成员失败，请重试"),
                })
              }
            >
              确认删除
            </button>
            <button className="pw-ps-btn" onClick={() => setConfirmingDelete(false)}>
              取消
            </button>
          </>
        ) : (
          <>
            <button className="pw-ps-icon-btn" title="编辑成员" onClick={() => setEditing(true)}>
              <Icon.Edit size={14} />
            </button>
            <button
              className="pw-ps-icon-btn"
              title="删除成员（将从所有任务解绑）"
              onClick={() => setConfirmingDelete(true)}
            >
              <Icon.Trash size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// 资源管理主体：标题 +「添加成员」+ 岗位标签区 + 成员卡片网格。
export function MemberManager({ onToast }: { onToast: (text: string) => void }) {
  const members = useMembers().data ?? [];
  const jobTypes = resolveJobTypes(useJobTypes().data);
  const addMember = useAddMember();
  const [adding, setAdding] = useState(false);

  return (
    <div className="pw-ps-section">
      <div className="pw-ps-section-head">
        <div>
          <div className="pw-ps-section-title">团队成员</div>
          <div className="pw-ps-section-desc">管理所有的全局资源，以便于在任务和项目中分配</div>
        </div>
        <button className="pw-ps-btn pw-ps-btn--primary" onClick={() => setAdding(true)}>
          <Icon.Plus size={14} />
          添加成员
        </button>
      </div>

      <JobTypeChips onToast={onToast} />

      {adding ? (
        <div className="pw-ps-card">
          <MemberForm
            jobTypes={jobTypes}
            onCancel={() => setAdding(false)}
            onSubmit={(input) => {
              addMember.mutate(input, { onError: () => onToast("添加成员失败，请重试") });
              setAdding(false);
            }}
          />
        </div>
      ) : null}

      {members.length === 0 && !adding ? (
        <div className="pw-ps-empty">暂无成员，点击「添加成员」创建</div>
      ) : (
        <div className="pw-ps-grid">
          {members.map((m) => (
            <MemberCard key={m.id} member={m} jobTypes={jobTypes} onToast={onToast} />
          ))}
        </div>
      )}
    </div>
  );
}
