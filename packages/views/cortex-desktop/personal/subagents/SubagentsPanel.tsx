// 子代理管理面板：复刻 Kun 的“基础代理 + 扩展代理”目录模型，并把配置直接写入
// generalSettings.subagents。发送边界会把这里启用的目录项解析为 ask_<role> 工具，故本页不是
// 仅展示清单；Agent、模型、推理强度和提示词的覆盖都会影响下一轮真实委派。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  BUILTIN_AGENT_CATALOG,
  normalizeSubagentSettings,
  SUBAGENT_MAX_CHILD_RUNS_RANGE,
  SUBAGENT_MAX_PARALLEL_RANGE,
  usePersonalStore,
  type BuiltinAgentCategory,
  type SubagentProfileOverride,
  type SubagentSettings,
} from "@cortex-work/core";

const CATEGORY_LABEL: Record<BuiltinAgentCategory, string> = {
  development: "开发",
  review: "审查",
  quality: "质量",
  planning: "规划",
  operations: "运维",
  research: "研究",
};

const EFFORTS = [
  { id: "", label: "自适应" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
] as const;

// Zustand selector 的缺省值必须保持引用稳定；内联 `?? []` 会让 React 19 的
// useSyncExternalStore 每次取到新快照，在尚未加载派生 Agent 的设置页形成更新死循环。
const EMPTY_DERIVED_AGENTS: readonly { id: string; label?: string }[] = [];

type CategoryFilter = "all" | "base" | BuiltinAgentCategory;

function Toggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`pw-sa-toggle ${checked ? "is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function BoundedNumberInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.floor(parsed)))
      : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      className="pw-sa-number"
      type="number"
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      step={1}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function patchProfile(
  settings: SubagentSettings,
  id: string,
  patch: Partial<SubagentProfileOverride>,
): SubagentSettings {
  const current = settings.profiles[id] ?? {};
  return {
    ...settings,
    profiles: { ...settings.profiles, [id]: { ...current, ...patch } },
  };
}

export function SubagentsPanel({ variant = "panel" }: { variant?: "panel" | "settings" }) {
  const storedSettings = usePersonalStore((s) => s.generalSettings.subagents);
  const setGeneralSettings = usePersonalStore((s) => s.setGeneralSettings);
  const derivedAgents = usePersonalStore((s) => s.derivedAgents ?? EMPTY_DERIVED_AGENTS);
  const settings = normalizeSubagentSettings(storedSettings);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const save = (next: SubagentSettings) => setGeneralSettings({ subagents: next });
  const baseCount = BUILTIN_AGENT_CATALOG.filter((entry) => entry.family === "base").length;
  const extensionCount = BUILTIN_AGENT_CATALOG.length - baseCount;
  const availableCount = baseCount + (settings.extensionAgentsEnabled
    ? BUILTIN_AGENT_CATALOG.filter(
        (entry) => entry.family !== "base" && settings.profiles[entry.id]?.enabled === true,
      ).length
    : 0);
  const categories = useMemo(
    () => [...new Set(BUILTIN_AGENT_CATALOG.map((entry) => entry.category))],
    [],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return BUILTIN_AGENT_CATALOG.filter((entry) => {
      if (filter === "base" && entry.family !== "base") return false;
      if (filter !== "all" && filter !== "base" && entry.category !== filter) return false;
      if (!needle) return true;
      return [entry.name, entry.description, entry.id, ...entry.routingTerms]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [filter, query]);

  return (
    <div className={variant === "settings" ? "pw-sa-settings" : "pw-sa-panel"}>
      <section className="pw-sa-intro">
        <Icon.Sparkle size={16} />
        <div>
          <strong>由主模型自主委派</strong>
          <p>是否调用、选择哪些角色以及调用多少次由主模型按任务自行决定；这里仅设置运行护栏与可用角色。</p>
        </div>
      </section>

      <div className="pw-sa-section-title">
        <strong>运行策略</strong>
        <span>设置并行委派与单个会话运行上限</span>
      </div>
      <section className="pw-sa-callout is-compact">
        <div>
          <strong>使用现有代理</strong>
          <p>关闭后，主 Agent 会为每个任务定义一次性匿名角色。</p>
        </div>
        <Toggle
          checked={settings.useExistingAgents}
          label="使用现有代理"
          onChange={(next) => save({ ...settings, useExistingAgents: next })}
        />
      </section>

      <section className="pw-sa-limits">
        <label>
          <span>
            <strong>最大并行子代理数</strong>
            <small>达到上限后，新任务会等待空闲槽位。</small>
          </span>
          <BoundedNumberInput
            label="最大并行子代理数"
            value={settings.maxParallel}
            min={SUBAGENT_MAX_PARALLEL_RANGE.min}
            max={SUBAGENT_MAX_PARALLEL_RANGE.max}
            onCommit={(next) => save({ ...settings, maxParallel: next })}
          />
        </label>
        <label>
          <span>
            <strong>单个会话的子任务上限</strong>
            <small>限制一轮主会话最多创建多少个子代理任务。</small>
          </span>
          <BoundedNumberInput
            label="单个会话的子任务上限"
            value={settings.maxChildRuns}
            min={SUBAGENT_MAX_CHILD_RUNS_RANGE.min}
            max={SUBAGENT_MAX_CHILD_RUNS_RANGE.max}
            onCommit={(next) => save({ ...settings, maxChildRuns: next })}
          />
        </label>
      </section>

      <div className="pw-sa-section-title">
        <strong>子代理配置</strong>
        <span>配置可委派角色、模型、推理强度与提示词</span>
      </div>

      <section className="pw-sa-extension">
        <div className="pw-sa-extension-head">
          <div>
            <strong>扩展代理</strong>
            <span>基础代理以外的角色 · {extensionCount}</span>
          </div>
          <Toggle
            checked={settings.extensionAgentsEnabled}
            label="启用扩展代理"
            onChange={(next) => save({ ...settings, extensionAgentsEnabled: next })}
          />
        </div>
        <p>基础代理始终可用；打开后可逐项启用写作、设计、规划与专项工程角色。</p>
      </section>

      <div className="pw-sa-summary">
        <strong>{BUILTIN_AGENT_CATALOG.length} 个可委派角色</strong>
        <span>基础 {baseCount}</span>
        <span className="spacer" />
        <span>当前可用 {availableCount}</span>
      </div>

      <label className="pw-sa-search">
        <Icon.Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、能力或场景" />
        {query ? (
          <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}>
            <Icon.X size={13} />
          </button>
        ) : null}
      </label>

      <div className="pw-sa-filters" role="tablist" aria-label="子代理分类">
        <button type="button" className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>全部</button>
        <button type="button" className={filter === "base" ? "is-active" : ""} onClick={() => setFilter("base")}>基础代理 {baseCount}</button>
        {categories.map((category) => (
          <button
            type="button"
            key={category}
            className={filter === category ? "is-active" : ""}
            onClick={() => setFilter(category)}
          >
            {CATEGORY_LABEL[category]}
          </button>
        ))}
      </div>

      <div className="pw-sa-list">
        {visible.map((entry) => {
          const base = entry.family === "base";
          const profile = settings.profiles[entry.id] ?? {};
          const enabled = base || (settings.extensionAgentsEnabled && profile.enabled === true);
          const expanded = expandedId === entry.id;
          return (
            <article key={entry.id} className={`pw-sa-card ${enabled ? "is-enabled" : ""}`}>
              <div className="pw-sa-card-head">
                <span className="pw-sa-avatar" style={{ color: entry.color, borderColor: `${entry.color}55` }}>
                  <Icon.Bot size={19} />
                </span>
                <button type="button" className="pw-sa-card-main" onClick={() => setExpandedId(expanded ? null : entry.id)}>
                  <span className="pw-sa-card-title">
                    <strong>{entry.name}</strong>
                    {base ? <em>基础</em> : <em>{CATEGORY_LABEL[entry.category]}</em>}
                    {entry.toolPolicy === "readOnly" ? <em className="is-readonly">只读</em> : null}
                  </span>
                  <span className="pw-sa-card-desc">{entry.description}</span>
                </button>
                {base ? (
                  <span className="pw-sa-always">始终可用</span>
                ) : (
                  <Toggle
                    checked={enabled}
                    disabled={!settings.extensionAgentsEnabled}
                    label={`启用 ${entry.name}`}
                    onChange={(next) => save(patchProfile(settings, entry.id, { enabled: next }))}
                  />
                )}
                <button
                  type="button"
                  className="pw-icon-btn"
                  aria-label={`配置 ${entry.name}`}
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                >
                  <Icon.Chevron size={14} />
                </button>
              </div>
              {expanded ? (
                <div className="pw-sa-editor">
                  <label>
                    <span>运行 Agent</span>
                    <select
                      value={profile.agent ?? ""}
                      onChange={(event) => save(patchProfile(settings, entry.id, { agent: event.target.value || undefined }))}
                    >
                      <option value="">跟随主会话</option>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="pi">Cortex</option>
                      {derivedAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label ?? agent.id}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>模型</span>
                    <input
                      value={profile.model ?? ""}
                      onChange={(event) => save(patchProfile(settings, entry.id, { model: event.target.value || undefined }))}
                      placeholder="跟随默认模型"
                    />
                  </label>
                  <div className="pw-sa-effort">
                    <span>推理强度</span>
                    <div>
                      {EFFORTS.map((effort) => (
                        <button
                          type="button"
                          key={effort.id || "auto"}
                          className={(profile.effort ?? "") === effort.id ? "is-active" : ""}
                          onClick={() => save(patchProfile(settings, entry.id, { effort: effort.id || undefined }))}
                        >
                          {effort.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="is-wide">
                    <span>附加提示词</span>
                    <textarea
                      value={profile.systemPrompt ?? ""}
                      onChange={(event) => save(patchProfile(settings, entry.id, { systemPrompt: event.target.value || undefined }))}
                      placeholder="在内置角色说明之后追加，可留空"
                      rows={3}
                    />
                  </label>
                </div>
              ) : null}
            </article>
          );
        })}
        {visible.length === 0 ? <div className="pw-sa-empty">没有匹配的子代理</div> : null}
      </div>
    </div>
  );
}
