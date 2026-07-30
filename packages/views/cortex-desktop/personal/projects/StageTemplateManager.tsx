// 阶段模板管理（参照 IFocus 设置页）：内置模板（带「内置」徽标、锁定不可改）+ 自定义模板 CRUD。
// 内置模板是 core 常量（mergeTemplates 渲染时合并、不落盘）；自定义模板经 useStageTemplates CRUD
// 落 tasks.json。删模板不影响已实例化项目（stages 是复制品）。删除做两步确认。
import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAddStageTemplate,
  useDeleteStageTemplate,
  useStageTemplates,
  useUpdateStageTemplate,
} from "@cortex-work/core/personal/tasks";
import { BUILTIN_STAGE_TEMPLATES, validateStageTemplateInput } from "@cortex-work/core/personal/stageTemplates";
import type { StageTemplate } from "@cortex-work/core/desktop/types";

// 模板编辑表单（新建/编辑共用）：名称 + 描述 + 阶段 chips（输入回车追加、点 × 删除；重名忽略）。
function TemplateForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: StageTemplate;
  onSubmit: (input: { name: string; description?: string; stages: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [stages, setStages] = useState<string[]>(initial?.stages ?? []);
  const [stageDraft, setStageDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addStage = () => {
    const v = stageDraft.trim();
    if (!v) return;
    setStageDraft("");
    if (stages.includes(v)) return; // 重名忽略（对齐 IFocus）
    setStages((s) => [...s, v]);
  };
  const submit = () => {
    const err = validateStageTemplateInput({ name, stages });
    if (err) {
      setError(err);
      return;
    }
    onSubmit({ name: name.trim(), description: description.trim() || undefined, stages });
  };

  return (
    <div className="pw-ps-form" role="form" aria-label={initial ? "编辑模板" : "新建模板"}>
      <input
        className="pw-ps-input"
        placeholder="模板名称"
        value={name}
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      />
      <input
        className="pw-ps-input"
        placeholder="模板描述（可选）"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="pw-ps-chip-row" aria-label="阶段列表">
        {stages.map((s) => (
          <span key={s} className="pw-ps-chip is-static">
            {s}
            <button
              type="button"
              className="pw-ps-chip-x"
              title={`移除阶段「${s}」`}
              aria-label={`移除阶段「${s}」`}
              onClick={() => setStages((list) => list.filter((x) => x !== s))}
            >
              <Icon.X size={11} />
            </button>
          </span>
        ))}
        <input
          className="pw-ps-chip-input"
          placeholder="输入阶段名，回车添加…"
          value={stageDraft}
          onChange={(e) => setStageDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addStage();
          }}
          onBlur={addStage}
        />
      </div>
      {error ? <div className="pw-ps-error">{error}</div> : null}
      <div className="pw-ps-form-actions">
        <button className="pw-ps-btn pw-ps-btn--primary" onClick={submit}>
          {initial ? "保存" : "创建"}
        </button>
        <button className="pw-ps-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// 单个模板卡片：名称 +（内置徽标）+ 描述 + 阶段链式预览「a › b › c」。
// 内置卡片无编辑/删除入口（锁定语义）；自定义卡片 hover 出操作、删除两步确认。
function TemplateCard({ template, onToast }: { template: StageTemplate; onToast: (text: string) => void }) {
  const updateTemplate = useUpdateStageTemplate();
  const deleteTemplate = useDeleteStageTemplate();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const builtin = !!template.builtin;

  if (editing) {
    return (
      <div className="pw-ps-card">
        <TemplateForm
          initial={template}
          onCancel={() => setEditing(false)}
          onSubmit={(input) => {
            updateTemplate.mutate(
              { id: template.id, patch: input },
              { onError: () => onToast("保存模板失败，请重试") },
            );
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="pw-ps-card pw-ps-tpl-card">
      <div className="pw-ps-tpl-main">
        <div className="pw-ps-tpl-name">
          {template.name}
          {builtin ? <span className="pw-ps-builtin-badge">内置</span> : null}
        </div>
        {template.description ? <div className="pw-ps-tpl-desc">{template.description}</div> : null}
        <div className="pw-ps-tpl-stages">
          {template.stages.length === 0 ? (
            <span className="pw-ps-tpl-stage-empty">无阶段</span>
          ) : (
            template.stages.map((s, i) => (
              <span key={`${s}-${i}`} className="pw-ps-tpl-stage">
                {i > 0 ? <span className="pw-ps-tpl-arrow">›</span> : null}
                <span className="pw-ps-tpl-stage-name">{s}</span>
              </span>
            ))
          )}
        </div>
      </div>
      {builtin ? null : (
        <div className="pw-ps-card-actions">
          {confirmingDelete ? (
            <>
              <button
                className="pw-ps-btn pw-ps-btn--danger"
                onClick={() =>
                  deleteTemplate.mutate(template.id, { onError: () => onToast("删除模板失败，请重试") })
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
              <button className="pw-ps-icon-btn" title="编辑模板" onClick={() => setEditing(true)}>
                <Icon.Edit size={14} />
              </button>
              <button
                className="pw-ps-icon-btn"
                title="删除模板（不影响已创建的项目）"
                onClick={() => setConfirmingDelete(true)}
              >
                <Icon.Trash size={14} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// 阶段模板管理主体：说明 +「新建模板」+ 内置组 + 自定义组。
export function StageTemplateManager({ onToast }: { onToast: (text: string) => void }) {
  const custom = useStageTemplates().data ?? [];
  const addTemplate = useAddStageTemplate();
  const [creating, setCreating] = useState(false);

  return (
    <div className="pw-ps-section">
      <div className="pw-ps-section-head">
        <div>
          <div className="pw-ps-section-title">阶段模板</div>
          <div className="pw-ps-section-desc">创建项目时可选择的阶段模板</div>
        </div>
        <button className="pw-ps-btn pw-ps-btn--primary" onClick={() => setCreating(true)}>
          <Icon.Plus size={14} />
          新建模板
        </button>
      </div>

      {creating ? (
        <div className="pw-ps-card">
          <TemplateForm
            onCancel={() => setCreating(false)}
            onSubmit={(input) => {
              addTemplate.mutate(input, { onError: () => onToast("创建模板失败，请重试") });
              setCreating(false);
            }}
          />
        </div>
      ) : null}

      <div className="pw-ps-group-label">内置模板</div>
      <div className="pw-ps-list">
        {BUILTIN_STAGE_TEMPLATES.map((t) => (
          <TemplateCard key={t.id} template={t} onToast={onToast} />
        ))}
      </div>

      <div className="pw-ps-group-label">自定义模板</div>
      {custom.length === 0 ? (
        <div className="pw-ps-empty">暂无自定义模板，点击「新建模板」创建</div>
      ) : (
        <div className="pw-ps-list">
          {custom.map((t) => (
            <TemplateCard key={t.id} template={t} onToast={onToast} />
          ))}
        </div>
      )}
    </div>
  );
}
