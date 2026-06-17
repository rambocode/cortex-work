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
import { ExtensionPanel } from "./ExtensionPanel";

type Tab = "mcp" | "skill" | "extension";
type StatusFilter = "all" | "enabled" | "disabled";
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; skills: PluginSkill[] };

const STATUS_LABEL: Record<StatusFilter, string> = { all: "全部", enabled: "已启用", disabled: "已禁用" };

// activeDir（可含 ~，未展开）与扫描结果 rootPath（已展开绝对路径）的匹配:精确或尾段匹配。
function rootMatches(rootPath: string, optionPath: string): boolean {
  if (rootPath === optionPath) return true;
  if (optionPath.startsWith("~/")) return rootPath.endsWith(optionPath.slice(1)); // ~/.agents/skills → /.agents/skills
  return false;
}

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
        <button
          type="button"
          role="tab"
          aria-selected={tab === "extension"}
          className={`pw-seg ${tab === "extension" ? "is-on" : ""}`}
          onClick={() => setTab("extension")}
        >
          扩展
        </button>
      </div>

      {tab === "mcp" ? (
        <McpPlaceholder />
      ) : tab === "extension" ? (
        <ExtensionPanel bridge={bridge} />
      ) : (
        <SkillPanel bridge={bridge} />
      )}
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
  const [status, setStatus] = useState<StatusFilter>("all");
  const [activeDir, setActiveDir] = useState<string>("all"); // 当前活动目录（创建/打开/统计焦点）
  const [newRoot, setNewRoot] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", body: "" });
  const [createMsg, setCreateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { globalRoots, userGlobalRoots, workspaceEnabled, disabledSkills, trustedWorkspaceSkillDirs } = piSkills;
  // open-dir/create 白名单 = 全部已配置根（含工作区根,若启用）。
  const allowedRoots = useMemo(() => {
    const roots = [...globalRoots, ...userGlobalRoots];
    if (workspaceEnabled && workspaceDir) roots.push(`${workspaceDir}/.cortex-desktop/skills`);
    return roots;
  }, [globalRoots, userGlobalRoots, workspaceEnabled, workspaceDir]);

  // 目录下拉选项:全部 + 各配置根（带 全局/工作区 scope 标签）。
  const dirOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: "all", label: "全部目录" }];
    for (const r of [...globalRoots, ...userGlobalRoots]) opts.push({ value: r, label: `全局 · ${r}` });
    if (workspaceEnabled && workspaceDir) {
      const wp = `${workspaceDir}/.cortex-desktop/skills`;
      opts.push({ value: wp, label: `工作区 · ${wp}` });
    }
    return opts;
  }, [globalRoots, userGlobalRoots, workspaceEnabled, workspaceDir]);

  // 创建/打开的目标根:选定具体目录则用之,否则回退首个全局根。
  const targetDir = activeDir !== "all" ? activeDir : globalRoots[0];

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

  // 活动目录筛选(统计 + 列表均基于它);activeDir==="all" 则全量。
  const inDir = useMemo(
    () => (activeDir === "all" ? decorated : decorated.filter((s) => rootMatches(s.rootPath, activeDir))),
    [decorated, activeDir],
  );
  const scannedCount = inDir.length;
  // 实际「生效」数 = 启用 + 授信 + 未被同名覆盖（与 resolveEnabledSkillPaths 注入口径一致）。
  const injectableCount = inDir.filter((s) => s.enabled && s.trusted && !s.shadowedBy).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inDir.filter((s) => {
      if (status === "enabled" && !s.enabled) return false;
      if (status === "disabled" && s.enabled) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [inDir, query, status]);

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

  const submitCreate = useCallback(async () => {
    if (!bridge?.createSkill || !targetDir) return;
    const res = await bridge.createSkill({
      dir: targetDir,
      name: form.name,
      description: form.description,
      body: form.body,
      allowedRoots,
    });
    if (res.ok) {
      setCreateMsg({ ok: true, text: `已创建 ${form.name.trim()}` });
      setForm({ name: "", description: "", body: "" });
      void refresh();
    } else {
      setCreateMsg({ ok: false, text: res.error ?? "创建失败" });
    }
  }, [bridge, targetDir, form, allowedRoots, refresh]);

  const noBridge = !bridge?.piSkillsList;

  return (
    <div className="pw-plugins-skill">
      {/* 顶部操作:管理目录 + 创建。 */}
      <div className="pw-plugins-actions">
        <button
          type="button"
          className={`pw-btn ${showManage ? "is-on" : ""}`}
          onClick={() => setShowManage((v) => !v)}
        >
          <Icon.Settings size={14} /> 管理
        </button>
        <button
          type="button"
          className={`pw-btn pw-btn-primary ${showCreate ? "is-on" : ""}`}
          onClick={() => {
            setShowCreate((v) => !v);
            setCreateMsg(null);
          }}
        >
          <Icon.Plus size={14} /> 创建
        </button>
      </div>

      {/* 搜索 + 状态筛选。 */}
      <div className="pw-plugins-toolbar pw-plugins-toolbar-search">
        <div className="pw-search">
          <Icon.Search size={16} />
          <input
            className="pw-input pw-search-input"
            placeholder="搜索 Skill"
            aria-label="搜索 Skill"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        <select
          className="pw-select pw-select-lg"
          aria-label="状态筛选"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      {/* 目录选择器(活动目录) + 打开目录 + 刷新 + 统计。 */}
      <div className="pw-plugins-toolbar">
        <select
          className="pw-select pw-dir-select"
          aria-label="选择 Skill 目录"
          value={activeDir}
          onChange={(e) => setActiveDir(e.target.value)}
        >
          {dirOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="pw-btn"
          onClick={() => targetDir && openDir(targetDir)}
          disabled={noBridge || !targetDir}
        >
          <Icon.Folder size={14} /> 打开目录
        </button>
        <button type="button" className="pw-btn" onClick={() => void refresh()} disabled={noBridge}>
          <Icon.Retry size={14} /> 刷新
        </button>
        <span className="pw-plugins-stat">
          已扫描 {scannedCount} 个，{injectableCount} 个启用
        </span>
      </div>

      {/* 创建表单（创建按钮展开）:名称 + 基础描述 + 指令正文 → 写 SKILL.md 到活动目录。 */}
      {showCreate ? (
        <div className="pw-plugins-create">
          <div className="pw-plugins-create-row">
            <input
              className="pw-input"
              placeholder="名称，例如 my-plugin"
              aria-label="Skill 名称"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              spellCheck={false}
            />
            <input
              className="pw-input"
              placeholder="基础描述"
              aria-label="基础描述"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <textarea
            className="pw-ta pw-plugins-create-body"
            rows={8}
            placeholder="写给智能体的 Skill 指令"
            aria-label="Skill 指令"
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            spellCheck={false}
          />
          <div className="pw-plugins-create-foot">
            {createMsg ? (
              <span className={createMsg.ok ? "pw-plugins-ok" : "pw-plugins-err"}>{createMsg.text}</span>
            ) : (
              <span className="pw-plugins-stat">将创建到：{targetDir ?? "（无可用目录）"}</span>
            )}
            <button
              type="button"
              className="pw-pill"
              onClick={() => void submitCreate()}
              disabled={!bridge?.createSkill || !targetDir}
            >
              <Icon.Plus size={14} /> 添加自定义
            </button>
          </div>
        </div>
      ) : null}

      {/* 管理目录（管理按钮展开,R3 增删全局根）。内置默认根不可删。 */}
      {showManage ? (
        <div className="pw-plugins-roots">
          <div className="pw-plugins-roots-title">全局目录</div>
          {[
            ...globalRoots.map((r) => ({ r, builtin: true })),
            ...userGlobalRoots.map((r) => ({ r, builtin: false })),
          ].map(({ r, builtin }) => (
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
          ))}
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
      ) : null}

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
      ) : inDir.length === 0 ? (
        <div className="pw-plugins-empty" role="status">
          <div className="pw-plugins-empty-title">未发现 Skill</div>
          <div className="pw-plugins-empty-desc">
            把含 SKILL.md 的目录放入 ~/.agents/skills，或点上方「打开目录」后放入并刷新。
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
      <div className="pw-plugins-grid">
        {skills.map((s) => (
          <SkillCard key={`${s.scope}:${s.dir}`} skill={s} onToggle={onToggle} onTrust={onTrust} />
        ))}
      </div>
    </div>
  );
}

// frontmatter name（kebab/小写）→ 展示用标题大小写（如 agent-browser → Agent Browser）。
function titleCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
          <span className="pw-plugins-card-name">{titleCase(skill.name)}</span>
          <span className="pw-tag">{skill.scope === "workspace" ? "工作区" : "全局"}</span>
          {skill.shadowedBy ? <span className="pw-tag">已被全局同名覆盖</span> : null}
          {untrustedWorkspace ? <span className="pw-tag">未信任</span> : null}
        </div>
        <div className="pw-plugins-card-desc">{skill.description}</div>
      </div>
      {untrustedWorkspace ? (
        <button type="button" className="pw-pill" onClick={() => onTrust(skill.dir, true)}>
          信任并启用
        </button>
      ) : (
        <button
          type="button"
          className="pw-pill"
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
