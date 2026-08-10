import type {
  AutomaticSubagentRoleId,
  AutomaticSubagentRoleOverride,
  SubagentSettings,
} from "@cortex-work/core";
import { SubagentAvatar } from "./SubagentAvatar";

const ROLES: Array<{
  id: AutomaticSubagentRoleId;
  name: string;
  description: string;
  configurable: boolean;
}> = [
  { id: "compaction", name: "上下文压缩", description: "长会话压缩 · Pi 会话运行时", configurable: false },
  { id: "codeReview", name: "代码审查", description: "隔离只读执行 · 复用代码审查角色", configurable: true },
  { id: "title", name: "标题生成", description: "首轮对话标题 · 异步轻量任务", configurable: true },
  { id: "summary", name: "会话摘要", description: "当前版本没有独立会话摘要任务", configurable: false },
];

function patchRole(
  settings: SubagentSettings,
  id: AutomaticSubagentRoleId,
  patch: Partial<AutomaticSubagentRoleOverride>,
): SubagentSettings {
  return {
    ...settings,
    automaticRoles: {
      ...settings.automaticRoles,
      [id]: { ...settings.automaticRoles[id], ...patch },
    },
  };
}

export function AutomaticRolesTab({
  settings,
  save,
}: {
  settings: SubagentSettings;
  save: (next: SubagentSettings) => void;
}) {
  return (
    <section className="pw-sa-settings-card pw-sa-automatic" role="tabpanel">
      <header><div><h2>自动模型角色</h2><p>为上下文压缩、代码审查、标题与摘要等内部任务选择模型。</p></div></header>
      <div>
        {ROLES.map((role) => {
          const configured = settings.automaticRoles[role.id] ?? {};
          return (
            <article key={role.id}>
              <span className="pw-sa-avatar-shell"><SubagentAvatar size={36} /></span>
              <div><strong>{role.name}</strong><p>{role.description}</p></div>
              {role.configurable ? <div className="pw-sa-automatic-controls">
                <select aria-label={`${role.name} Agent`} value={configured.agent ?? ""} onChange={(event) => save(patchRole(settings, role.id, { agent: (event.target.value || undefined) as AutomaticSubagentRoleOverride["agent"] }))}>
                  <option value="">跟随运行时</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="pi">Cortex</option>
                </select>
                <input aria-label={`${role.name}模型`} value={configured.model ?? ""} onChange={(event) => save(patchRole(settings, role.id, { model: event.target.value || undefined }))} placeholder="跟随默认模型" />
                {configured.agent === "pi" ? <input aria-label={`${role.name}供应商`} value={configured.providerId ?? ""} onChange={(event) => save(patchRole(settings, role.id, { providerId: event.target.value || undefined }))} placeholder="Provider ID" /> : null}
                <select aria-label={`${role.name}推理强度`} value={configured.effort ?? ""} onChange={(event) => save(patchRole(settings, role.id, { effort: (event.target.value || undefined) as AutomaticSubagentRoleOverride["effort"] }))}>
                  <option value="">自适应</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
                </select>
              </div> : <span className="pw-sa-automatic-runtime">{role.id === "compaction" ? "由 Pi 会话运行时管理" : "未启用"}</span>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
