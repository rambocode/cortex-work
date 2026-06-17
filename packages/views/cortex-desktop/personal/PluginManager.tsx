// 插件管理器（U7）:pi agent 的插件入口。顶部 MCP / Skill 分段切换;本轮 MCP 仅占位
// （敬请期待）,Skill 标签完整:搜索、范围过滤、按 scope 分组、逐项启用/禁用、工作区授信、
// 全局根增删、打开目录、四态（加载/空/错误/数据）。bridge 缺失（web/旧壳）→ 降级空态。
//
// 数据流:bridge.piSkillsList 扫描多根 → 叠加 store 的 disabledSkills/trustedWorkspaceSkillDirs
// 算 enabled/trusted/shadowedBy 渲染。toggle 写 store（乐观,即时翻转）;改动下一轮对话经
// extensionFingerprint 重开会话生效（见 U5）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { DEFAULT_PI_SKILLS, useDesktopBridge, usePersonalStore, type PluginSkill } from "@cortex-work/core";

type Tab = "mcp" | "skill";
type ScopeFilter = "all" | "global" | "workspace";
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; skills: PluginSkill[] };

const SCOPE_LABEL: Record<ScopeFilter, string> = { all: "全部", global: "全局", workspace: "工作区" };

export function PluginManager() {
  const bridge = useDesktopBridge();
  const [tab, setTab] = useState<Tab>("skill");

  return (
    <div className="pw-plugins">
      <div className="pw-plugins-tabs" role="tablist" aria-label="插件类型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "mcp"}
          className={`pw-seg ${tab === "mcp" ? "is-on" : ""}`}
          onClick={() => setTab("mcp")}
        >
          MCP
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "skill"}
          className={`pw-seg ${tab === "skill" ? "is-on" : ""}`}
          onClick={() => setTab("skill")}
        >
          Skill
        </button>
      </div>

      {tab === "mcp" ? <McpPlaceholder /> : <SkillPanel bridge={bridge} />}
    </div>
  );
}

// MCP 本轮全延后,仅占位避免误导（R11）。
function McpPlaceholder() {
  return (
    <div className="pw-plugins-empty" role="status">
      <Icon.Workflow size={28} />
      <div className="pw-plugins-empty-title">MCP 管理敬请期待</div>
      <div className="pw-plugins-empty-desc">把外部工具接入智能体的能力正在开发中。</div>
    </div>
  );
}

function SkillPanel({ bridge }: { bridge: ReturnType<typeof useDesktopBridge> }) {
  const piSkills = usePersonalStore((s) => s.generalSettings.piSkills) ?? DEFAULT_PI_SKILLS;
  const togglePiSkill = usePersonalStore((s) => s.togglePiSkill);
  const trustWorkspaceSkill = usePersonalStore((s) => s.trustWorkspaceSkill);
  const addGlobalSkillRoot = usePersonalStore((s) => s.addGlobalSkillRoot);
  const removeGlobalSkillRoot = usePersonalStore((s) => s.removeGlobalSkillRoot);
  const workspaceDir = usePersonalStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.path);

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [newRoot, setNewRoot] = useState("");

  const { globalRoots, userGlobalRoots, workspaceEnabled, disabledSkills, trustedWorkspaceSkillDirs } = piSkills;
  // open-dir 白名单 = 全部已配置根（含工作区根,若启用）。
  const allowedRoots = useMemo(() => {
    const roots = [...globalRoots, ...userGlobalRoots];
    if (workspaceEnabled && workspaceDir) roots.push(`${workspaceDir}/.cortex-desktop/skills`);
    return roots;
  }, [globalRoots, userGlobalRoots, workspaceEnabled, workspaceDir]);

  const refresh = useCallback(async () => {
    if (!bridge?.piSkillsList) {
      setState({ kind: "ready", skills: [] });
      return;
    }
    setState({ kind: "loading" });
    try {
      const skills = await bridge.piSkillsList({ globalRoots, userGlobalRoots, workspaceEnabled, workspaceDir });
      setState({ kind: "ready", skills });
    } catch (e) {
      setState({ kind: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, [bridge, globalRoots, userGlobalRoots, workspaceEnabled, workspaceDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 扫描结果叠加配置 → enabled/trusted/shadowedBy。
  const decorated = useMemo(() => {
    const skills = state.kind === "ready" ? state.skills : [];
    const disabled = new Set(disabledSkills);
    const trusted = new Set(trustedWorkspaceSkillDirs);
    const globalNames = new Set(skills.filter((s) => s.scope === "global").map((s) => s.name));
    return skills.map((s) => ({
      ...s,
      enabled: !disabled.has(`${s.scope}:${s.name}`),
      trusted: s.scope === "global" ? true : trusted.has(s.dir),
      // 工作区被同名全局覆盖 → 标注（注入时全局胜出,见 KTD-6）。
      shadowedBy: s.scope === "workspace" && globalNames.has(s.name) ? "global" : undefined,
    }));
  }, [state, disabledSkills, trustedWorkspaceSkillDirs]);

  // 实际「生效」数 = 启用 + 授信 + 未被同名覆盖（与 resolveEnabledSkillPaths 注入口径一致）。
  const injectableCount = decorated.filter((s) => s.enabled && s.trusted && !s.shadowedBy).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decorated.filter((s) => {
      if (scope !== "all" && s.scope !== scope) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [decorated, query, scope]);

  const groups = useMemo(
    () => ({
      global: filtered.filter((s) => s.scope === "global"),
      workspace: filtered.filter((s) => s.scope === "workspace"),
    }),
    [filtered],
  );

  const openDir = useCallback(
    (dir: string) => {
      void bridge?.openSkillDir?.({ dir, allowedRoots });
    },
    [bridge, allowedRoots],
  );

  const noBridge = !bridge?.piSkillsList;

  return (
    <div className="pw-plugins-skill">
      <div className="pw-plugins-toolbar">
        <input
          className="pw-input"
          placeholder="搜索 Skill"
          aria-label="搜索 Skill"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <select
          className="pw-select"
          aria-label="范围筛选"
          value={scope}
          onChange={(e) => setScope(e.target.value as ScopeFilter)}
        >
          {(Object.keys(SCOPE_LABEL) as ScopeFilter[]).map((s) => (
            <option key={s} value={s}>
              {SCOPE_LABEL[s]}
            </option>
          ))}
        </select>
        <button type="button" className="pw-btn" onClick={() => void refresh()} disabled={noBridge}>
          <Icon.Retry size={14} /> 刷新
        </button>
        <span className="pw-plugins-stat">
          已扫描 {decorated.length} 个，{injectableCount} 个启用
        </span>
      </div>

      {/* 全局根管理（R3 增删 + R7 打开目录）。内置默认根不可删。 */}
      <div className="pw-plugins-roots">
        <div className="pw-plugins-roots-title">全局目录</div>
        {[...globalRoots.map((r) => ({ r, builtin: true })), ...userGlobalRoots.map((r) => ({ r, builtin: false }))].map(
          ({ r, builtin }) => (
            <div key={r} className="pw-plugins-root-row">
              <span className="pw-plugins-root-path">{r}</span>
              <button type="button" className="pw-btn-sm" onClick={() => openDir(r)} disabled={noBridge}>
                打开目录
              </button>
              {!builtin ? (
                <button type="button" className="pw-btn-sm" onClick={() => removeGlobalSkillRoot(r)}>
                  删除
                </button>
              ) : null}
            </div>
          ),
        )}
        <div className="pw-plugins-root-add">
          <input
            className="pw-input"
            placeholder="新增全局目录，如 ~/my/skills"
            aria-label="新增全局目录"
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            spellCheck={false}
          />
          <button
            type="button"
            className="pw-btn-sm"
            onClick={() => {
              if (!newRoot.trim()) return;
              addGlobalSkillRoot(newRoot);
              setNewRoot("");
            }}
          >
            添加目录
          </button>
        </div>
      </div>

      <div className="pw-plugins-hint">启用/禁用将在下一轮对话重新加载（会重开 pi 会话）。</div>

      {noBridge ? (
        <div className="pw-plugins-empty" role="status">
          当前环境不支持 Skill 扫描（仅桌面端可用）。
        </div>
      ) : state.kind === "loading" ? (
        <div className="pw-plugins-empty" role="status">
          扫描中…
        </div>
      ) : state.kind === "error" ? (
        <div className="pw-plugins-empty" role="alert">
          <div className="pw-plugins-empty-title">扫描失败</div>
          <div className="pw-plugins-empty-desc">{state.error}</div>
          <button type="button" className="pw-btn" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : decorated.length === 0 ? (
        <div className="pw-plugins-empty" role="status">
          <div className="pw-plugins-empty-title">未发现 Skill</div>
          <div className="pw-plugins-empty-desc">
            把含 SKILL.md 的目录放入 ~/.agent/skills，或点上方「打开目录」后放入并刷新。
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="pw-plugins-empty" role="status">
          没有匹配的 Skill。
        </div>
      ) : (
        <div className="pw-plugins-list">
          {groups.global.length > 0 ? (
            <SkillGroup title="全局" skills={groups.global} onToggle={togglePiSkill} onTrust={trustWorkspaceSkill} />
          ) : null}
          {groups.workspace.length > 0 ? (
            <SkillGroup title="工作区" skills={groups.workspace} onToggle={togglePiSkill} onTrust={trustWorkspaceSkill} />
          ) : null}
        </div>
      )}
    </div>
  );
}

type DecoratedSkill = PluginSkill & { shadowedBy?: string };

function SkillGroup({
  title,
  skills,
  onToggle,
  onTrust,
}: {
  title: string;
  skills: DecoratedSkill[];
  onToggle: (scope: string, name: string, enabled: boolean) => void;
  onTrust: (dir: string, trusted: boolean) => void;
}) {
  return (
    <div className="pw-plugins-group">
      <div className="pw-plugins-group-title">{title}</div>
      {skills.map((s) => (
        <SkillCard key={`${s.scope}:${s.dir}`} skill={s} onToggle={onToggle} onTrust={onTrust} />
      ))}
    </div>
  );
}

function SkillCard({
  skill,
  onToggle,
  onTrust,
}: {
  skill: DecoratedSkill;
  onToggle: (scope: string, name: string, enabled: boolean) => void;
  onTrust: (dir: string, trusted: boolean) => void;
}) {
  const untrustedWorkspace = skill.scope === "workspace" && !skill.trusted;
  return (
    <div className={`pw-plugins-card ${skill.shadowedBy ? "is-shadowed" : ""}`}>
      <div className="pw-plugins-card-main">
        <div className="pw-plugins-card-title">
          {skill.name}
          {skill.scope === "workspace" ? <span className="pw-tag">工作区</span> : null}
          {skill.shadowedBy ? <span className="pw-tag">已被全局同名覆盖</span> : null}
          {untrustedWorkspace ? <span className="pw-tag">未信任</span> : null}
        </div>
        <div className="pw-plugins-card-desc">{skill.description}</div>
      </div>
      {untrustedWorkspace ? (
        <button type="button" className="pw-btn-sm" onClick={() => onTrust(skill.dir, true)}>
          信任并启用
        </button>
      ) : (
        <button
          type="button"
          className="pw-toggle-btn"
          role="switch"
          aria-checked={skill.enabled}
          aria-label={`${skill.name} ${skill.enabled ? "已启用" : "已禁用"}`}
          onClick={() => onToggle(skill.scope, skill.name, !skill.enabled)}
        >
          {skill.enabled ? "禁用" : "启用"}
        </button>
      )}
    </div>
  );
}
