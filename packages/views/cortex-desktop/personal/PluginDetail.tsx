// 插件详情页（三层 IA 第三层）。富元数据 + 能力 chips + 启停/信任 + 本地路径 + 在对话中试用。
// 本期：「在对话中试用」「升级」「删除」为占位（onTryInChat 缺省时禁用），从 UI 守住「本期不写盘」。
// 捆绑 skill 名清单需扫描 skillsDir（读层只给 skillsRef 路径），第一期以能力/技能存在性呈现，不臆造名单。

import { Icon } from "@cortex-work/ui/icons";
import { pluginInitial } from "./PluginRow";
import type { DecoratedPlugin, PluginCatalog } from "./usePluginCatalog";

const KIND_LABEL: Record<DecoratedPlugin["manifestKind"], string> = {
  codex: "Codex 插件（.codex-plugin）",
  claude: "Claude 插件（.claude-plugin）",
  "skill-fallback": "Skill（SKILL.md）",
};

export function PluginDetail({
  plugin,
  catalog,
  onTryInChat,
}: {
  plugin: DecoratedPlugin | null;
  catalog: PluginCatalog;
  onTryInChat?: (plugin: DecoratedPlugin) => void;
}) {
  if (!plugin) {
    return <div className="pw-plugins-empty" role="status">插件不存在或已被移除。</div>;
  }
  const m = plugin.manifest;
  const name = m.displayName ?? m.name;

  return (
    <div className="pw-plg-detail">
      {/* 头部：图标 + 名称/描述 + 启停 + 在对话中试用 */}
      <div className="pw-plg-detail-head">
        <span className="pw-plg-ico pw-plg-ico-lg">{pluginInitial(m)}</span>
        <div className="pw-plg-detail-headmain">
          <div className="pw-plg-detail-name">{name}</div>
          {m.description ? <div className="pw-plg-detail-desc">{m.description}</div> : null}
        </div>
        <div className="pw-plg-detail-actions">
          <button
            type="button"
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${name} ${plugin.enabled ? "已启用" : "已禁用"}`}
            className={`pw-plg-switch ${plugin.enabled ? "is-on" : ""}`}
            onClick={() => catalog.togglePlugin(m.id, !plugin.enabled)}
          >
            <span className="pw-plg-switch-knob" />
          </button>
          <button
            type="button"
            className="pw-btn pw-btn-primary"
            disabled={!onTryInChat}
            title={onTryInChat ? "在对话中试用" : "即将支持"}
            onClick={() => onTryInChat?.(plugin)}
          >
            <Icon.Comment size={14} /> 在对话中试用
          </button>
        </div>
      </div>

      {/* 信任提示：撤信的插件即便启用也不注入。 */}
      {!plugin.trusted ? (
        <div className="pw-plugins-hint pw-plugins-scope-note" role="note">
          该插件已撤销信任，启用也不会注入其技能。
          <button type="button" className="pw-plg-link" onClick={() => catalog.setPluginTrusted(m.id, true)}>
            恢复信任
          </button>
        </div>
      ) : (
        <div className="pw-plugins-hint" role="note">
          启用后，该插件的技能将随对话注入（codex/pi 走 --skill，claude/codex 经系统提示）。下一轮对话生效。
        </div>
      )}

      {/* 能力 chips（manifest.capabilities）。 */}
      {m.capabilities && m.capabilities.length > 0 ? (
        <div className="pw-plg-detail-sec">
          <div className="pw-plg-detail-h">能力</div>
          <div className="pw-plg-chips">
            {m.capabilities.map((c) => (
              <span key={c} className="pw-plg-chip">{c}</span>
            ))}
          </div>
        </div>
      ) : null}

      {/* 信息表。 */}
      <div className="pw-plg-detail-sec">
        <div className="pw-plg-detail-h">信息</div>
        <InfoRow label="来源" value={KIND_LABEL[plugin.manifestKind]} />
        {m.category ? <InfoRow label="类别" value={m.category} /> : null}
        {m.version ? <InfoRow label="版本" value={m.version} /> : null}
        <InfoRow label="技能" value={plugin.skillsDir ? "包含（启用后注入）" : "无"} />
      </div>

      {/* 本地路径 + 升级/删除（占位禁用）。 */}
      <div className="pw-plg-detail-path">
        <div className="pw-plg-detail-path-label">本地路径</div>
        <div className="pw-plg-detail-path-val">{plugin.installPath}</div>
        <div className="pw-plg-detail-path-acts">
          <button type="button" className="pw-btn" disabled title="即将支持">升级</button>
          <button type="button" className="pw-btn pw-btn-danger" disabled title="即将支持">删除</button>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="pw-plg-info-row">
      <div className="pw-plg-info-label">{label}</div>
      <div className="pw-plg-info-value">{value}</div>
    </div>
  );
}
