// 插件标准列表行 + 图标首字母 helper（三层 IA 共享）。插件首页与管理页「插件」sub-tab 复用，
// 避免两处重复行布局。行：图标 + 名称/描述 + 来源·未信任标签 + 启停开关 + 点击进详情。

import type { PluginManifest } from "@cortex-work/core";
import type { DecoratedPlugin } from "./usePluginCatalog";

// 插件图标首字母（displayName/name 首个非空字符，大写）。
export function pluginInitial(m: PluginManifest): string {
  const s = (m.displayName ?? m.name ?? "?").trim();
  return (s.charAt(0) || "?").toUpperCase();
}

const KIND_LABEL: Record<DecoratedPlugin["manifestKind"], string> = {
  codex: "Codex 插件",
  claude: "Claude 插件",
  "skill-fallback": "Skill",
};

export function PluginRow({
  plugin,
  onOpen,
  onToggle,
}: {
  plugin: DecoratedPlugin;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const m = plugin.manifest;
  const name = m.displayName ?? m.name;
  return (
    <div className="pw-plg-row" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
    >
      <span className="pw-plg-ico">{pluginInitial(m)}</span>
      <div className="pw-plg-row-main">
        <div className="pw-plg-row-title">
          <span className="pw-plg-row-name">{name}</span>
          <span className="pw-tag">{KIND_LABEL[plugin.manifestKind]}</span>
          {!plugin.trusted ? <span className="pw-tag">未信任</span> : null}
        </div>
        {m.description ? <div className="pw-plg-row-desc">{m.description}</div> : null}
      </div>
      {/* 开关：阻止冒泡，避免触发整行的进详情。 */}
      <button
        type="button"
        role="switch"
        aria-checked={plugin.enabled}
        aria-label={`${name} ${plugin.enabled ? "已启用" : "已禁用"}`}
        className={`pw-plg-switch ${plugin.enabled ? "is-on" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(!plugin.enabled);
        }}
      >
        <span className="pw-plg-switch-knob" />
      </button>
    </div>
  );
}
