// 子代理管理面板：设置页复刻 Kun 的页签、角色目录与详情检查器；会话右栏继续使用紧凑
// 清单。两种形态共享 generalSettings.subagents，任何开关、模型、推理强度或提示词变更都会
// 影响下一轮真实委派，不维护第二份仅供展示的状态。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  BUILTIN_AGENT_CATALOG,
  normalizeSubagentSettings,
  normalizeSubagentSurfaces,
  subagentAvailableOnSurface,
  SUBAGENT_MAX_CHILD_RUNS_RANGE,
  SUBAGENT_MAX_PARALLEL_RANGE,
  usePersonalStore,
  type BuiltinAgentCatalogEntry,
  type BuiltinAgentCategory,
  type CustomSubagentProfile,
  type SubagentProfileOverride,
  type SubagentSettings,
  type SubagentSurface,
} from "@cortex-work/core";
import { SubagentAvatar } from "./SubagentAvatar";
import { createCustomSubagent, CustomSubagentDialog } from "./CustomSubagentDialog";
import { AutomaticRolesTab } from "./AutomaticRolesTab";
import { getSubagentCopy } from "./subagent-copy";

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
  { id: "off", label: "关闭" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "max", label: "超高" },
] as const;

const SETTINGS_TABS = [
  { id: "policy", label: "运行策略", icon: Icon.Settings },
  { id: "profiles", label: "子代理配置", icon: Icon.Bot },
  { id: "automatic", label: "自动模型角色", icon: Icon.Sparkle },
] as const;

const SURFACES = [
  { id: "shared", label: "基础" },
  { id: "code", label: "Code" },
  { id: "write", label: "写作" },
  { id: "design", label: "设计" },
] as const;

// Kun 的研究分类把引用检索放在源码研究之前；稳定顺序可以降低同一分类在两端来回切换时的认知成本。
const CATALOG_ORDER = new Map<string, number>([
  ["explore", 0],
  ["documentation-and-adrs", 1],
  ["write-citation-researcher", 2],
  ["source-driven-development", 3],
  ["design-ux-researcher", 4],
]);

// Zustand selector 的缺省值必须保持引用稳定；内联 `?? []` 会让 React 19 的
// useSyncExternalStore 每次取到新快照，在尚未加载派生 Agent 时形成更新死循环。
const EMPTY_DERIVED_AGENTS: readonly { id: string; label?: string }[] = [];

type CategoryFilter = "all" | "base" | "custom" | BuiltinAgentCategory;
type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
type Surface = SubagentSurface;

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

function isEntryEnabled(settings: SubagentSettings, entry: BuiltinAgentCatalogEntry): boolean {
  if (entry.family === "base") return true;
  return settings.extensionAgentsEnabled && settings.profiles[entry.id]?.enabled === true;
}

function entrySurfaces(settings: SubagentSettings, entry: BuiltinAgentCatalogEntry): SubagentSurface[] {
  const fallback = entry.surfaces.length ? entry.surfaces : entry.recommendedSurfaces;
  return normalizeSubagentSurfaces(settings.profiles[entry.id]?.surfaces, fallback);
}

function catalogFor(
  query: string,
  filter: CategoryFilter,
): BuiltinAgentCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  return BUILTIN_AGENT_CATALOG.filter((entry) => {
    if (filter === "custom") return false;
    if (filter === "base" && entry.family !== "base") return false;
    if (filter !== "all" && filter !== "base" && entry.category !== filter) return false;
    if (!needle) return true;
    const copy = getSubagentCopy(entry);
    return [copy.name, copy.description, entry.name, entry.description, entry.id, ...entry.routingTerms]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

function SettingsTabs({ value, onChange }: { value: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  return (
    <div className="pw-sa-tabs" role="tablist" aria-label="子代理设置">
      {SETTINGS_TABS.map((tab) => {
        const TabIcon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={value === tab.id}
            className={value === tab.id ? "is-active" : ""}
            onClick={() => onChange(tab.id)}
          >
            <TabIcon size={15} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function PolicySetting({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="pw-sa-policy-setting">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}

function PolicyTab({ settings, save }: { settings: SubagentSettings; save: (next: SubagentSettings) => void }) {
  return (
    <section className="pw-sa-settings-card pw-sa-policy-card" role="tabpanel">
      <header>
        <div>
          <h2>运行策略</h2>
          <p>设置并行委派与单个会话运行上限。</p>
        </div>
        <span>队列与会话限制</span>
      </header>
      <div className="pw-sa-policy-grid">
        <PolicySetting title="使用现有代理" description="关闭后，主 Agent 会为每个任务定义一次性匿名角色。">
          <Toggle
            checked={settings.useExistingAgents}
            label="使用现有代理"
            onChange={(next) => save({ ...settings, useExistingAgents: next })}
          />
        </PolicySetting>
        <PolicySetting title="最大并行子代理数" description="达到上限后，新任务会等待空闲槽位。">
          <BoundedNumberInput
            label="最大并行子代理数"
            value={settings.maxParallel}
            min={SUBAGENT_MAX_PARALLEL_RANGE.min}
            max={SUBAGENT_MAX_PARALLEL_RANGE.max}
            onCommit={(next) => save({ ...settings, maxParallel: next })}
          />
        </PolicySetting>
        <PolicySetting title="单个会话的子任务上限" description="限制一轮主会话最多创建多少个子代理任务。">
          <BoundedNumberInput
            label="单个会话的子任务上限"
            value={settings.maxChildRuns}
            min={SUBAGENT_MAX_CHILD_RUNS_RANGE.min}
            max={SUBAGENT_MAX_CHILD_RUNS_RANGE.max}
            onCommit={(next) => save({ ...settings, maxChildRuns: next })}
          />
        </PolicySetting>
      </div>
    </section>
  );
}

function SurfaceTabs({ value, onChange }: { value: Surface; onChange: (surface: Surface) => void }) {
  return (
    <div className="pw-sa-surfaces" role="tablist" aria-label="子代理使用场景">
      {SURFACES.map((surface) => (
        <button
          key={surface.id}
          type="button"
          role="tab"
          aria-selected={value === surface.id}
          className={value === surface.id ? "is-active" : ""}
          onClick={() => onChange(surface.id)}
        >
          {surface.label}
        </button>
      ))}
    </div>
  );
}

function CatalogToolbar({
  query,
  filter,
  categories,
  baseCount,
  customCount = 0,
  onQuery,
  onFilter,
}: {
  query: string;
  filter: CategoryFilter;
  categories: readonly BuiltinAgentCategory[];
  baseCount: number;
  customCount?: number;
  onQuery: (query: string) => void;
  onFilter: (filter: CategoryFilter) => void;
}) {
  return (
    <>
      <label className="pw-sa-search">
        <Icon.Search size={15} />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索名称、能力或场景" />
        {query ? (
          <button type="button" aria-label="清空搜索" onClick={() => onQuery("")}>
            <Icon.X size={13} />
          </button>
        ) : null}
      </label>
      <div className="pw-sa-filters" role="tablist" aria-label="子代理分类">
        <button type="button" className={filter === "all" ? "is-active" : ""} onClick={() => onFilter("all")}>
          全部 <span>{BUILTIN_AGENT_CATALOG.length + customCount}</span>
        </button>
        <button type="button" className={filter === "base" ? "is-active" : ""} onClick={() => onFilter("base")}>
          基础代理 <span>{baseCount}</span>
        </button>
        {customCount > 0 ? (
          <button type="button" className={filter === "custom" ? "is-active" : ""} onClick={() => onFilter("custom")}>
            自定义 <span>{customCount}</span>
          </button>
        ) : null}
        {categories.map((category) => (
          <button
            type="button"
            key={category}
            className={filter === category ? "is-active" : ""}
            onClick={() => onFilter(category)}
          >
            {CATEGORY_LABEL[category]} <span>{BUILTIN_AGENT_CATALOG.filter((entry) => entry.category === category).length}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function EffortPicker({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (effort: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={`pw-sa-effort ${compact ? "is-compact" : ""}`}>
      {EFFORTS.map((effort) => (
        <button
          type="button"
          key={effort.id || "auto"}
          className={value === effort.id ? "is-active" : ""}
          onClick={() => onChange(effort.id)}
        >
          {effort.label}
        </button>
      ))}
    </div>
  );
}

function CatalogAgentRow({
  entry,
  enabled,
  selected,
  profile,
  onSelect,
}: {
  entry: BuiltinAgentCatalogEntry;
  enabled: boolean;
  selected: boolean;
  profile: SubagentProfileOverride;
  onSelect: () => void;
}) {
  const copy = getSubagentCopy(entry);
  return (
    <button
      type="button"
      className={`pw-sa-catalog-agent ${selected ? "is-selected" : ""} ${enabled ? "" : "is-disabled"}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="pw-sa-avatar-shell">
        <SubagentAvatar disabled={!enabled} size={34} />
      </span>
      <span className="pw-sa-catalog-copy">
        <span className="pw-sa-catalog-title">
          <strong>{copy.name}</strong>
          <em>内置</em>
          {entry.family === "base" ? <em className="is-base">基础</em> : null}
        </span>
        <span className="pw-sa-catalog-desc">{copy.description}</span>
        <small>{profile.model || "跟随默认"}</small>
      </span>
      <Icon.ChevronRight size={13} />
    </button>
  );
}

function patchCategoryProfiles(
  settings: SubagentSettings,
  entries: readonly BuiltinAgentCatalogEntry[],
  patch: Partial<Pick<SubagentProfileOverride, "model" | "effort">>,
): SubagentSettings {
  const profiles = { ...settings.profiles };
  for (const entry of entries) profiles[entry.id] = { ...profiles[entry.id], ...patch };
  return { ...settings, profiles };
}

function sharedCategoryValue(
  entries: readonly BuiltinAgentCatalogEntry[],
  settings: SubagentSettings,
  key: "model" | "effort",
): string {
  const values = entries.map((entry) => settings.profiles[entry.id]?.[key] ?? "");
  return values.every((value) => value === values[0]) ? (values[0] ?? "") : "";
}

function CategoryDefaults({
  entries,
  settings,
  save,
}: {
  entries: readonly BuiltinAgentCatalogEntry[];
  settings: SubagentSettings;
  save: (next: SubagentSettings) => void;
}) {
  const model = sharedCategoryValue(entries, settings, "model");
  const effort = sharedCategoryValue(entries, settings, "effort");
  const patch = (next: Partial<Pick<SubagentProfileOverride, "model" | "effort">>) =>
    save(patchCategoryProfiles(settings, entries, next));

  return (
    <div className="pw-sa-category-defaults">
      <header>
        <div>
          <strong>分类默认配置</strong>
          <p>为该分类下的全部代理应用相同默认值</p>
        </div>
        <button type="button" onClick={() => patch({ model: undefined, effort: undefined })}>恢复默认</button>
      </header>
      <div>
        <label>
          <span>模型</span>
          <input
            value={model}
            placeholder="跟随默认"
            onChange={(event) => patch({ model: event.target.value || undefined })}
          />
        </label>
        <div>
          <span>推理强度</span>
          <EffortPicker
            value={effort}
            onChange={(next) => patch({ effort: next || undefined })}
            compact
          />
        </div>
      </div>
    </div>
  );
}

function CategorySection({
  category,
  entries,
  settings,
  surface,
  selectedId,
  collapsed,
  showDefaults,
  onToggle,
  onSelect,
  save,
}: {
  category: BuiltinAgentCategory;
  entries: BuiltinAgentCatalogEntry[];
  settings: SubagentSettings;
  surface: Surface;
  selectedId: string;
  collapsed: boolean;
  showDefaults: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  save: (next: SubagentSettings) => void;
}) {
  return (
    <section className={`pw-sa-category ${collapsed ? "is-collapsed" : ""}`}>
      <button type="button" className="pw-sa-category-head" aria-expanded={!collapsed} onClick={onToggle}>
        <Icon.ChevronRight size={13} />
        <strong>{CATEGORY_LABEL[category]}</strong>
        <span>{entries.length}</span>
      </button>
      {collapsed ? null : (
        <>
          {showDefaults ? <CategoryDefaults entries={entries} settings={settings} save={save} /> : null}
          <div className="pw-sa-category-grid">
            {entries.map((entry) => (
              <CatalogAgentRow
                key={entry.id}
                entry={entry}
                enabled={isEntryEnabled(settings, entry) && (
                  surface === "shared"
                    ? entrySurfaces(settings, entry).includes("shared")
                    : subagentAvailableOnSurface(
                        entrySurfaces(settings, entry),
                        surface,
                      )
                )}
                selected={selectedId === entry.id}
                profile={settings.profiles[entry.id] ?? {}}
                onSelect={() => onSelect(entry.id)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function AgentDetails({
  entry,
  settings,
  surface,
  derivedAgents,
  save,
}: {
  entry: BuiltinAgentCatalogEntry;
  settings: SubagentSettings;
  surface: Surface;
  derivedAgents: readonly { id: string; label?: string }[];
  save: (next: SubagentSettings) => void;
}) {
  const [editing, setEditing] = useState(false);
  const profile = settings.profiles[entry.id] ?? {};
  const enabled = isEntryEnabled(settings, entry);
  const copy = getSubagentCopy(entry);
  const surfaceLabel = SURFACES.find((candidate) => candidate.id === surface)?.label ?? "基础";
  const patch = (next: Partial<SubagentProfileOverride>) => save(patchProfile(settings, entry.id, next));
  const surfaces = entrySurfaces(settings, entry);
  const available = surface === "shared"
    ? surfaces.includes("shared")
    : subagentAvailableOnSurface(surfaces, surface);
  const toggleSurface = (next: boolean) => {
    if (surface === "shared") {
      patch({ surfaces: next ? ["shared"] : [] });
      return;
    }
    const explicit = surfaces.filter((candidate) => candidate !== "shared");
    patch({
      surfaces: next
        ? [...new Set([...explicit, surface])]
        : explicit.filter((candidate) => candidate !== surface),
    });
  };

  return (
    <aside className="pw-sa-details" aria-label={`${entry.name} 详情`}>
      <header>
        <span className="pw-sa-avatar-shell is-large">
          <SubagentAvatar disabled={!enabled} size={42} />
        </span>
        <div>
          <span>
            <strong>{copy.name}</strong>
            <em>内置</em>
          </span>
          <p>{copy.description}</p>
        </div>
      </header>

      <section className="pw-sa-detail-availability">
        <div>
          <strong>{surfaceLabel}</strong>
          <small>{available && enabled ? "当前模式已启用" : "当前模式未启用"}</small>
        </div>
        <Toggle
          checked={available}
          disabled={(entry.id === "general" && surface === "shared") || (enabled && surface !== "shared" && surfaces.includes("shared"))}
          label={enabled ? `${surfaceLabel}场景启用 ${copy.name}` : `启用 ${copy.name}`}
          onChange={(next) => {
            if (!enabled && next) {
              const patched = patchProfile(settings, entry.id, {
                enabled: true,
                surfaces: surfaces.length ? surfaces : [...entry.recommendedSurfaces],
              });
              save({ ...patched, extensionAgentsEnabled: true });
              return;
            }
            toggleSurface(next);
          }}
        />
      </section>

      <label className="pw-sa-detail-field">
        <span>模型</span>
        <input
          value={profile.model ?? ""}
          onChange={(event) => patch({ model: event.target.value || undefined })}
          placeholder="跟随默认模型"
        />
      </label>

      <div className="pw-sa-detail-field">
        <span>推理强度</span>
        <EffortPicker value={profile.effort ?? ""} onChange={(effort) => patch({ effort: effort || undefined })} compact />
      </div>

      <div className="pw-sa-detail-field">
        <span>能力标签</span>
        <div className="pw-sa-capabilities">
          <em>{CATEGORY_LABEL[entry.category]}</em>
          <em>{entry.toolPolicy === "readOnly" ? "只读" : "可编辑"}</em>
          <em>委派</em>
        </div>
      </div>

      <div className="pw-sa-detail-status"><i />{enabled && available ? "启用" : "停用"}</div>

      {editing ? (
        <div className="pw-sa-detail-advanced">
          <label className="pw-sa-detail-field">
            <span>运行 Agent</span>
            <select value={profile.agent ?? ""} onChange={(event) => patch({ agent: event.target.value || undefined })}>
              <option value="">跟随主会话</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="pi">Cortex</option>
              {derivedAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label ?? agent.id}</option>)}
            </select>
          </label>
          <label className="pw-sa-detail-field pw-sa-detail-prompt">
            <span>附加提示词</span>
            <textarea
              value={profile.systemPrompt ?? ""}
              onChange={(event) => patch({ systemPrompt: event.target.value || undefined })}
              placeholder="在内置角色说明之后追加，可留空"
              rows={4}
            />
          </label>
        </div>
      ) : null}

      <button type="button" className="pw-sa-edit-button" onClick={() => setEditing((open) => !open)}>
        <Icon.Edit size={14} />
        {editing ? "收起编辑" : "编辑"}
      </button>
    </aside>
  );
}

function ProfilesTab({
  settings,
  derivedAgents,
  save,
}: {
  settings: SubagentSettings;
  derivedAgents: readonly { id: string; label?: string }[];
  save: (next: SubagentSettings) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [surface, setSurface] = useState<Surface>("shared");
  const [selectedId, setSelectedId] = useState(BUILTIN_AGENT_CATALOG[0]?.id ?? "general");
  const [dialogProfile, setDialogProfile] = useState<CustomSubagentProfile | null>(null);
  const [collapsed, setCollapsed] = useState<Set<BuiltinAgentCategory>>(
    () => new Set(["review", "quality", "planning", "operations", "research"]),
  );
  const baseCount = BUILTIN_AGENT_CATALOG.filter((entry) => entry.family === "base").length;
  const categories = useMemo(
    () => [...new Set(BUILTIN_AGENT_CATALOG.map((entry) => entry.category))],
    [],
  );
  const visible = useMemo(() => catalogFor(query, filter), [filter, query]);
  const visibleCustom = useMemo(() => {
    if (filter !== "all" && filter !== "custom") return [];
    const needle = query.trim().toLowerCase();
    return settings.customProfiles.filter((profile) => !needle || [profile.name, profile.description, profile.id]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle));
  }, [filter, query, settings.customProfiles]);
  const grouped = useMemo(
    () => categories
      .map((category) => ({
        category,
        entries: visible
          .filter((entry) => entry.category === category)
          .sort((left, right) => {
            if (category !== "research") return 0;
            const leftRank = CATALOG_ORDER.get(left.id);
            const rightRank = CATALOG_ORDER.get(right.id);
            return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
          }),
      }))
      .filter((group) => group.entries.length > 0),
    [categories, visible],
  );
  const selectedCustom = settings.customProfiles.find((entry) => entry.id === selectedId);
  const selected = selectedCustom
    ? undefined
    : visible.find((entry) => entry.id === selectedId) ?? visible[0] ?? (filter === "custom" ? undefined : BUILTIN_AGENT_CATALOG[0]);

  const saveCustom = (profile: CustomSubagentProfile) => {
    const exists = settings.customProfiles.some((candidate) => candidate.id === profile.id);
    save({
      ...settings,
      customProfiles: exists
        ? settings.customProfiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
        : [...settings.customProfiles, profile],
    });
    setSelectedId(profile.id);
    setDialogProfile(null);
  };

  useEffect(() => {
    if (filter === "all" || filter === "base" || filter === "custom") return;
    setCollapsed((current) => {
      if (!current.has(filter)) return current;
      const next = new Set(current);
      next.delete(filter);
      return next;
    });
  }, [filter]);

  return (
    <section className="pw-sa-settings-card pw-sa-profiles-card" role="tabpanel">
      <header className="pw-sa-profiles-head">
        <div>
          <span>
            <h2>子代理配置</h2>
            <em>{BUILTIN_AGENT_CATALOG.length + settings.customProfiles.length} 个可委派角色</em>
          </span>
          <p>配置内置委派角色，或创建用于任务委派和主代理人格的自定义配置。</p>
        </div>
        <button type="button" className="pw-sa-new" onClick={() => setDialogProfile(createCustomSubagent(surface))}>
          <Icon.Plus size={14} />
          新建子代理
        </button>
      </header>

      <div className="pw-sa-catalog-toolbar">
        <SurfaceTabs value={surface} onChange={setSurface} />
        <CatalogToolbar
          query={query}
          filter={filter}
          categories={categories}
          baseCount={baseCount}
          customCount={settings.customProfiles.length}
          onQuery={setQuery}
          onFilter={setFilter}
        />
      </div>

      <div className="pw-sa-catalog-layout">
        <div className="pw-sa-catalog-list">
          {visibleCustom.length > 0 ? (
            <section className="pw-sa-category">
              <div className="pw-sa-category-head is-static"><Icon.ChevronRight size={13} /><strong>自定义</strong><span>{visibleCustom.length}</span></div>
              <div className="pw-sa-category-grid">
                {visibleCustom.map((profile) => {
                  const available = surface === "shared"
                    ? profile.surfaces.includes("shared")
                    : subagentAvailableOnSurface(profile.surfaces, surface);
                  return (
                    <button key={profile.id} type="button" className={`pw-sa-catalog-agent ${selectedId === profile.id ? "is-selected" : ""} ${profile.enabled && available ? "" : "is-disabled"}`} onClick={() => setSelectedId(profile.id)}>
                      <span className="pw-sa-avatar-shell"><SubagentAvatar disabled={!profile.enabled || !available} size={34} /></span>
                      <span className="pw-sa-catalog-copy"><span className="pw-sa-catalog-title"><strong>{profile.name}</strong><em>自定义</em></span><span className="pw-sa-catalog-desc">{profile.description || "自定义委派角色"}</span><small>{profile.model || "跟随默认"}</small></span>
                      <Icon.ChevronRight size={13} />
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
          {grouped.map(({ category, entries }) => (
            <CategorySection
              key={category}
              category={category}
              entries={entries}
              settings={settings}
              surface={surface}
              selectedId={selected?.id ?? selectedId}
              collapsed={query.trim().length === 0 && filter === "all" && collapsed.has(category)}
              showDefaults={filter === category}
              onToggle={() => setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(category)) next.delete(category);
                else next.add(category);
                return next;
              })}
              onSelect={setSelectedId}
              save={save}
            />
          ))}
          {visible.length + visibleCustom.length === 0 ? <div className="pw-sa-empty">没有匹配的子代理</div> : null}
          {visible.length + visibleCustom.length > 0 ? (
            <footer className="pw-sa-pagination">
              <span>第 1 / 1 页 · 共 {visible.length + visibleCustom.length} 个 Agent</span>
              <div>
                <button type="button" disabled aria-label="上一页"><Icon.ChevronLeft size={13} /></button>
                <strong>1/1</strong>
                <button type="button" disabled aria-label="下一页"><Icon.ChevronRight size={13} /></button>
              </div>
            </footer>
          ) : null}
        </div>
        <div className="pw-sa-catalog-inspector">
          {selected ? (
            <AgentDetails
              key={selected.id}
              entry={selected}
              settings={settings}
              surface={surface}
              derivedAgents={derivedAgents}
              save={save}
            />
          ) : selectedCustom ? (
            <aside className="pw-sa-details" aria-label={`${selectedCustom.name} 详情`}>
              <header><span className="pw-sa-avatar-shell is-large"><SubagentAvatar disabled={!selectedCustom.enabled} size={42} /></span><div><span><strong>{selectedCustom.name}</strong><em>自定义</em></span><p>{selectedCustom.description || "自定义委派角色"}</p></div></header>
              <section className="pw-sa-detail-availability"><div><strong>{SURFACES.find((candidate) => candidate.id === surface)?.label}</strong><small>{selectedCustom.enabled && (surface === "shared" ? selectedCustom.surfaces.includes("shared") : subagentAvailableOnSurface(selectedCustom.surfaces, surface)) ? "当前模式已启用" : "当前模式未启用"}</small></div><Toggle checked={selectedCustom.enabled} label={`启用 ${selectedCustom.name}`} onChange={(enabled) => saveCustom({ ...selectedCustom, enabled })} /></section>
              <div className="pw-sa-detail-field"><span>模型</span><p>{selectedCustom.model || "跟随默认模型"}</p></div>
              <div className="pw-sa-detail-field"><span>能力标签</span><div className="pw-sa-capabilities"><em>自定义</em><em>{selectedCustom.toolPolicy === "readOnly" ? "只读" : "继承权限"}</em><em>委派</em></div></div>
              <div className="pw-sa-detail-status"><i />{selectedCustom.enabled ? "启用" : "停用"}</div>
              <button type="button" className="pw-sa-edit-button" onClick={() => setDialogProfile(selectedCustom)}><Icon.Edit size={14} />编辑</button>
            </aside>
          ) : null}
        </div>
      </div>
      {dialogProfile ? (
        <CustomSubagentDialog
          initial={dialogProfile}
          derivedAgents={derivedAgents}
          onCancel={() => setDialogProfile(null)}
          onSave={saveCustom}
          onDelete={settings.customProfiles.some((candidate) => candidate.id === dialogProfile.id) ? () => {
            if (!window.confirm(`确定删除“${dialogProfile.name}”吗？`)) return;
            save({ ...settings, customProfiles: settings.customProfiles.filter((candidate) => candidate.id !== dialogProfile.id) });
            setSelectedId(BUILTIN_AGENT_CATALOG[0]?.id ?? "general");
            setDialogProfile(null);
          } : undefined}
        />
      ) : null}
    </section>
  );
}

function SettingsEditor({
  settings,
  derivedAgents,
  save,
}: {
  settings: SubagentSettings;
  derivedAgents: readonly { id: string; label?: string }[];
  save: (next: SubagentSettings) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("policy");
  return (
    <div className="pw-sa-settings" data-testid="subagent-settings-editor">
      {/* 设置页头与 Kun 保持同一信息层级：先解释本页作用，再进入具体策略和角色配置。 */}
      <header className="pw-sa-settings-page-header">
        <div>
          <h1>子代理</h1>
          <p>集中管理可委派子代理的运行策略、模型、推理强度、提示词与能力范围。这些设置与工作台侧边栏保持一致。</p>
        </div>
        <span>修改会自动生效</span>
      </header>
      <SettingsTabs value={tab} onChange={setTab} />
      {tab === "policy" ? (
        <PolicyTab settings={settings} save={save} />
      ) : tab === "profiles" ? (
        <ProfilesTab settings={settings} derivedAgents={derivedAgents} save={save} />
      ) : (
        <AutomaticRolesTab settings={settings} save={save} />
      )}
    </div>
  );
}

function PanelEditor({
  settings,
  derivedAgents,
  save,
}: {
  settings: SubagentSettings;
  derivedAgents: readonly { id: string; label?: string }[];
  save: (next: SubagentSettings) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
  const visible = useMemo(() => catalogFor(query, filter), [filter, query]);

  return (
    <div className="pw-sa-panel">
      <section className="pw-sa-intro">
        <Icon.Sparkle size={16} />
        <div>
          <strong>由主模型自主委派</strong>
          <p>是否调用、选择哪些角色以及调用多少次由主模型按任务自行决定；这里仅设置运行护栏与可用角色。</p>
        </div>
      </section>

      <div className="pw-sa-section-title"><strong>运行策略</strong><span>设置并行委派与单个会话运行上限</span></div>
      <section className="pw-sa-callout is-compact">
        <div><strong>使用现有代理</strong><p>关闭后，主 Agent 会为每个任务定义一次性匿名角色。</p></div>
        <Toggle checked={settings.useExistingAgents} label="使用现有代理" onChange={(next) => save({ ...settings, useExistingAgents: next })} />
      </section>
      <section className="pw-sa-limits">
        <PolicySetting title="最大并行子代理数" description="达到上限后，新任务会等待空闲槽位。">
          <BoundedNumberInput label="最大并行子代理数" value={settings.maxParallel} min={1} max={256} onCommit={(next) => save({ ...settings, maxParallel: next })} />
        </PolicySetting>
        <PolicySetting title="单个会话的子任务上限" description="限制一轮主会话最多创建多少个子代理任务。">
          <BoundedNumberInput label="单个会话的子任务上限" value={settings.maxChildRuns} min={1} max={10_000} onCommit={(next) => save({ ...settings, maxChildRuns: next })} />
        </PolicySetting>
      </section>

      <div className="pw-sa-section-title"><strong>子代理配置</strong><span>配置可委派角色、模型、推理强度与提示词</span></div>
      <section className="pw-sa-extension">
        <div className="pw-sa-extension-head">
          <div><strong>扩展代理</strong><span>基础代理以外的角色 · {extensionCount}</span></div>
          <Toggle checked={settings.extensionAgentsEnabled} label="启用扩展代理" onChange={(next) => save({ ...settings, extensionAgentsEnabled: next })} />
        </div>
        <p>基础代理始终可用；打开后可逐项启用写作、设计、规划与专项工程角色。</p>
      </section>

      <div className="pw-sa-summary">
        <strong>{BUILTIN_AGENT_CATALOG.length} 个可委派角色</strong>
        <span>基础 {baseCount}</span><span className="spacer" /><span>当前可用 {availableCount}</span>
      </div>
      <CatalogToolbar query={query} filter={filter} categories={categories} baseCount={baseCount} onQuery={setQuery} onFilter={setFilter} />

      <div className="pw-sa-list">
        {visible.map((entry) => {
          const base = entry.family === "base";
          const profile = settings.profiles[entry.id] ?? {};
          const enabled = isEntryEnabled(settings, entry);
          const expanded = expandedId === entry.id;
          return (
            <article key={entry.id} className={`pw-sa-card ${enabled ? "is-enabled" : ""}`}>
              <div className="pw-sa-card-head">
                <span className="pw-sa-avatar" style={{ color: entry.color, borderColor: `${entry.color}55` }}><Icon.Bot size={19} /></span>
                <button type="button" className="pw-sa-card-main" onClick={() => setExpandedId(expanded ? null : entry.id)}>
                  <span className="pw-sa-card-title"><strong>{entry.name}</strong><em>{base ? "基础" : CATEGORY_LABEL[entry.category]}</em>{entry.toolPolicy === "readOnly" ? <em className="is-readonly">只读</em> : null}</span>
                  <span className="pw-sa-card-desc">{entry.description}</span>
                </button>
                {base ? <span className="pw-sa-always">始终可用</span> : <Toggle checked={enabled} disabled={!settings.extensionAgentsEnabled} label={`启用 ${entry.name}`} onChange={(next) => save(patchProfile(settings, entry.id, { enabled: next }))} />}
                <button type="button" className="pw-icon-btn" aria-label={`配置 ${entry.name}`} aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : entry.id)}><Icon.Chevron size={14} /></button>
              </div>
              {expanded ? (
                <div className="pw-sa-editor">
                  <label><span>运行 Agent</span><select value={profile.agent ?? ""} onChange={(event) => save(patchProfile(settings, entry.id, { agent: event.target.value || undefined }))}><option value="">跟随主会话</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="pi">Cortex</option>{derivedAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label ?? agent.id}</option>)}</select></label>
                  <label><span>模型</span><input value={profile.model ?? ""} onChange={(event) => save(patchProfile(settings, entry.id, { model: event.target.value || undefined }))} placeholder="跟随默认模型" /></label>
                  <div className="pw-sa-effort-field"><span>推理强度</span><EffortPicker value={profile.effort ?? ""} onChange={(effort) => save(patchProfile(settings, entry.id, { effort: effort || undefined }))} /></div>
                  <label className="is-wide"><span>附加提示词</span><textarea value={profile.systemPrompt ?? ""} onChange={(event) => save(patchProfile(settings, entry.id, { systemPrompt: event.target.value || undefined }))} placeholder="在内置角色说明之后追加，可留空" rows={3} /></label>
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

export function SubagentsPanel({ variant = "panel" }: { variant?: "panel" | "settings" }) {
  const storedSettings = usePersonalStore((state) => state.generalSettings.subagents);
  const setGeneralSettings = usePersonalStore((state) => state.setGeneralSettings);
  const derivedAgents = usePersonalStore((state) => state.derivedAgents ?? EMPTY_DERIVED_AGENTS);
  const settings = normalizeSubagentSettings(storedSettings);
  const save = (next: SubagentSettings) => setGeneralSettings({ subagents: next });

  return variant === "settings" ? (
    <SettingsEditor settings={settings} derivedAgents={derivedAgents} save={save} />
  ) : (
    <PanelEditor settings={settings} derivedAgents={derivedAgents} save={save} />
  );
}
