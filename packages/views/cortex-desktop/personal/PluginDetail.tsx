// 插件详情页（三层 IA 第三层，对齐 Codex 设计稿）。结构：
//   头部:图标 + 名称/短描述 + 右侧「···」菜单(本地路径/升级/删除/启停) + 黑色「在对话中试用」
//   渐变 banner:可点击试用卡片([图标] 名称 + defaultPrompt + →,hover 变亮 + 箭头右移)
//   长描述段 → 技能 N(真实 skill 名 chips) → 信息(功能/开发者/类别 + 网站/隐私/条款 图标外链)
// 升级/删除本期占位禁用。技能名经 bridge.piSkillsList 传 skillsDir 拿到(复用现成扫描)。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";
import { pluginIconNode } from "./PluginRow";
import type { DecoratedPlugin, PluginCatalog } from "./usePluginCatalog";

export function PluginDetail({
  plugin,
  catalog,
  onTryInChat,
}: {
  plugin: DecoratedPlugin | null;
  catalog: PluginCatalog;
  onTryInChat?: (plugin: DecoratedPlugin) => void;
}) {
  const bridge = useDesktopBridge();
  const [skills, setSkills] = useState<{ name: string; dir: string }[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const skillsDir = plugin?.skillsDir;

  // 拉该插件捆绑的 skill 名:复用 pi-skills:list,只把本插件 skillsDir 作为扫描根传入。
  useEffect(() => {
    let alive = true;
    if (!skillsDir || !bridge?.piSkillsList) {
      setSkills([]);
      return;
    }
    void bridge
      .piSkillsList({ globalRoots: [], userGlobalRoots: [], workspaceEnabled: false, pluginSkillDirs: [skillsDir] })
      .then((list) => {
        if (alive) setSkills(list.map((s) => ({ name: s.name, dir: s.dir })));
      })
      .catch(() => {
        if (alive) setSkills([]);
      });
    return () => {
      alive = false;
    };
  }, [skillsDir, bridge]);

  if (!plugin) {
    return <div className="pw-plugins-empty" role="status">插件不存在或已被移除。</div>;
  }
  const m = plugin.manifest;
  const name = m.displayName ?? m.name;
  const openExt = (url?: string) => {
    if (url) void bridge?.openExternal?.(url);
  };
  const try_ = () => onTryInChat?.(plugin);

  return (
    <div className="pw-plg-detail">
      {/* 头部 */}
      <div className="pw-plg-detail-head">
        <span className="pw-plg-ico pw-plg-ico-lg">{pluginIconNode(plugin)}</span>
        <div className="pw-plg-detail-headmain">
          <div className="pw-plg-detail-name">{name}</div>
          {m.description ? <div className="pw-plg-detail-desc">{m.description}</div> : null}
        </div>
        <div className="pw-plg-detail-actions">
          <DetailMenu
            open={menuOpen}
            onToggle={() => setMenuOpen((v) => !v)}
            onClose={() => setMenuOpen(false)}
            plugin={plugin}
            catalog={catalog}
            onReveal={() => void bridge?.revealInFolder?.(plugin.installPath)}
          />
          <button type="button" className="pw-plg-try-btn" disabled={!onTryInChat} title={onTryInChat ? "在对话中试用" : "即将支持"} onClick={try_}>
            <Icon.Comment size={14} /> 在对话中试用
          </button>
        </div>
      </div>

      {/* 渐变 banner:可点击试用卡片（hover 变亮 + 箭头右移） */}
      {onTryInChat ? (
        <button type="button" className="pw-plg-try-banner" onClick={try_} aria-label={`在对话中试用 ${name}`}>
          <span className="pw-plg-try-card">
            <span className="pw-plg-try-card-ico">{pluginIconNode(plugin)}</span>
            <span className="pw-plg-try-card-name">{name}</span>
            <span className="pw-plg-try-card-sample">
              {m.defaultPrompt ?? `用 ${name} 帮我完成一个任务`}
            </span>
            <span className="pw-plg-try-card-arrow">
              <Icon.ChevronRight size={16} />
            </span>
          </span>
        </button>
      ) : null}

      {/* 长描述 */}
      {m.longDescription ? <p className="pw-plg-detail-long">{m.longDescription}</p> : null}

      {/* 技能 N（真实 skill 名 chips） */}
      {skills.length > 0 ? (
        <div className="pw-plg-detail-sec">
          <div className="pw-plg-detail-h">
            技能 <span className="pw-plg-detail-count">{skills.length}</span>
          </div>
          <div className="pw-plg-skill-chips">
            {skills.map((s) => (
              <span key={s.dir} className="pw-plg-skill-chip">
                <span className="pw-plg-skill-chip-ico">{pluginIconNode(plugin)}</span>
                {skillTitle(s.name)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* 能力 chips */}
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

      {/* 信息（精简:功能/开发者/类别 + 网站/隐私/条款 图标外链） */}
      <div className="pw-plg-detail-sec">
        <div className="pw-plg-detail-h">信息</div>
        {m.capabilities && m.capabilities.length > 0 ? <InfoRow label="功能" value={m.capabilities.join("、")} /> : null}
        {m.developer ? <InfoRow label="开发者" value={m.developer} /> : null}
        {m.category ? <InfoRow label="类别" value={m.category} /> : null}
        {m.website ? <InfoLinkRow label="网站" url={m.website} onOpen={openExt} /> : null}
        {m.privacyUrl ? <InfoLinkRow label="隐私政策" url={m.privacyUrl} onOpen={openExt} /> : null}
        {m.termsUrl ? <InfoLinkRow label="服务条款" url={m.termsUrl} onOpen={openExt} /> : null}
      </div>
    </div>
  );
}

// 「···」菜单:启停 / 本地路径(在访达显示) / 升级 / 删除。升级/删除本期占位禁用。
function DetailMenu({
  open,
  onToggle,
  onClose,
  plugin,
  catalog,
  onReveal,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  plugin: DecoratedPlugin;
  catalog: PluginCatalog;
  onReveal: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = plugin.manifest.id;
  return (
    <div className="pw-plg-menu-wrap" ref={ref}>
      <button type="button" className="pw-plg-menu-btn" aria-label="更多" aria-expanded={open} onClick={onToggle}>
        <Icon.More size={18} />
      </button>
      {open ? (
        <>
          {/* 点击空白关闭 */}
          <div className="pw-plg-menu-overlay" onClick={onClose} />
          <div className="pw-plg-menu" role="menu">
            <button
              type="button"
              className="pw-plg-menu-item"
              role="menuitem"
              onClick={() => {
                catalog.togglePlugin(id, !plugin.enabled);
                onClose();
              }}
            >
              {plugin.enabled ? "禁用" : "启用"}
            </button>
            <button type="button" className="pw-plg-menu-item" role="menuitem" onClick={() => { onReveal(); onClose(); }}>
              在访达中显示
            </button>
            <button type="button" className="pw-plg-menu-item is-disabled" role="menuitem" disabled title="即将支持">
              升级
            </button>
            <button type="button" className="pw-plg-menu-item is-danger" role="menuitem" disabled title="即将支持">
              删除
            </button>
            <div className="pw-plg-menu-path" title={plugin.installPath}>
              {plugin.installPath}
            </div>
          </div>
        </>
      ) : null}
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

// 外链行:仅显示图标(对齐设计稿),点击经 bridge.openExternal 用系统浏览器打开。
function InfoLinkRow({ label, url, onOpen }: { label: string; url: string; onOpen: (url: string) => void }) {
  return (
    <div className="pw-plg-info-row">
      <div className="pw-plg-info-label">{label}</div>
      <button type="button" className="pw-plg-info-link-icon" onClick={() => onOpen(url)} title={url} aria-label={`${label}（外部链接）`}>
        <Icon.Share size={15} />
      </button>
    </div>
  );
}

// skill 目录名(kebab) → 展示标题(如 frontend-app-builder → Frontend app builder)。
function skillTitle(name: string): string {
  const s = name.replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name;
}
