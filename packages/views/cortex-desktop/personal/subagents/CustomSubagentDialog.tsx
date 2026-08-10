import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { CustomSubagentProfile, SubagentSurface } from "@cortex-work/core";

const SURFACE_OPTIONS: Array<{ id: SubagentSurface; label: string }> = [
  { id: "shared", label: "基础" },
  { id: "code", label: "Code" },
  { id: "write", label: "写作" },
  { id: "design", label: "设计" },
];

function newId(): string {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `custom-${id}`;
}

export function createCustomSubagent(surface: SubagentSurface): CustomSubagentProfile {
  return {
    id: newId(),
    enabled: true,
    name: "",
    toolPolicy: "readOnly",
    surfaces: [surface],
  };
}

export function CustomSubagentDialog({
  initial,
  derivedAgents,
  onCancel,
  onSave,
  onDelete,
}: {
  initial: CustomSubagentProfile;
  derivedAgents: readonly { id: string; label?: string }[];
  onCancel: () => void;
  onSave: (profile: CustomSubagentProfile) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState<"basic" | "permissions">("basic");
  useEffect(() => setDraft(initial), [initial]);

  const patch = (next: Partial<CustomSubagentProfile>) => setDraft((current) => ({ ...current, ...next }));
  const toggleSurface = (surface: SubagentSurface) => {
    if (surface === "shared") {
      patch({ surfaces: draft.surfaces.includes("shared") ? [] : ["shared"] });
      return;
    }
    const current = draft.surfaces.filter((entry) => entry !== "shared");
    patch({
      surfaces: current.includes(surface)
        ? current.filter((entry) => entry !== surface)
        : [...current, surface],
    });
  };

  return (
    <div className="pw-sa-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="pw-sa-dialog" role="dialog" aria-modal="true" aria-label={onDelete ? "编辑自定义子代理" : "新建自定义子代理"}>
        <header>
          <div>
            <h2>{onDelete ? "编辑子代理" : "新建子代理"}</h2>
            <p>创建一个可被主 Agent 真实委派的独立角色。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}><Icon.X size={16} /></button>
        </header>

        <nav aria-label="自定义子代理配置">
          <button type="button" className={tab === "basic" ? "is-active" : ""} onClick={() => setTab("basic")}>基础</button>
          <button type="button" className={tab === "permissions" ? "is-active" : ""} onClick={() => setTab("permissions")}>权限</button>
        </nav>

        {tab === "basic" ? (
          <div className="pw-sa-dialog-fields">
            <label><span>名称 <em>*</em></span><input autoFocus value={draft.name} maxLength={80} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：发布风险审查员" /></label>
            <label><span>描述</span><textarea value={draft.description ?? ""} maxLength={400} rows={2} onChange={(event) => patch({ description: event.target.value })} placeholder="说明这个角色何时应该被调用" /></label>
            <div className="pw-sa-dialog-row">
              <label><span>颜色</span><input type="color" value={draft.color ?? "#3b82d8"} onChange={(event) => patch({ color: event.target.value })} /></label>
              <label><span>运行 Agent</span><select value={draft.agent ?? ""} onChange={(event) => patch({ agent: event.target.value || undefined })}><option value="">跟随主会话</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="pi">Cortex</option>{derivedAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label ?? agent.id}</option>)}</select></label>
              <label><span>模型</span><input value={draft.model ?? ""} onChange={(event) => patch({ model: event.target.value || undefined })} placeholder="跟随默认" /></label>
            </div>
            <fieldset>
              <legend>可用场景</legend>
              <div className="pw-sa-dialog-surfaces">
                {SURFACE_OPTIONS.map((surface) => (
                  <button key={surface.id} type="button" className={draft.surfaces.includes(surface.id) ? "is-active" : ""} onClick={() => toggleSurface(surface.id)}>{surface.label}</button>
                ))}
              </div>
              <small>“基础”表示所有场景可用；未选择场景时不会进入委派目录。</small>
            </fieldset>
            <label><span>系统提示词</span><textarea value={draft.systemPrompt ?? ""} rows={6} onChange={(event) => patch({ systemPrompt: event.target.value })} placeholder="定义角色职责、工作方式、输出要求和边界" /></label>
          </div>
        ) : (
          <div className="pw-sa-dialog-permissions">
            <strong>工具权限</strong>
            <label><input type="radio" name="toolPolicy" checked={draft.toolPolicy === "readOnly"} onChange={() => patch({ toolPolicy: "readOnly" })} /><span><b>只读</b><small>允许检索、分析和审查，不允许修改工作区。</small></span></label>
            <label><input type="radio" name="toolPolicy" checked={draft.toolPolicy === "inherit"} onChange={() => patch({ toolPolicy: "inherit" })} /><span><b>继承主会话</b><small>沿用主会话的执行权限和审批策略。</small></span></label>
          </div>
        )}

        <footer>
          {onDelete ? <button type="button" className="is-danger" onClick={onDelete}>删除</button> : <span />}
          <div><button type="button" onClick={onCancel}>取消</button><button type="button" className="is-primary" disabled={!draft.name.trim()} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>保存</button></div>
        </footer>
      </section>
    </div>
  );
}
