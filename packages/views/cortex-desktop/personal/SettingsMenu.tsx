// 个人工作区左栏底部「设置」入口 + 弹出层设置对话框。
// 对话框:左侧 Tab 菜单(宠物 / 外观),右侧详细内容;ESC / 遮罩 / ✕ 关闭。
//   宠物  → 4 个造型卡片(实时预览,点击切换)
//   外观  → 原右下角 Tweaks 迁移:布局密度 / 品牌色调 / 侧栏样式

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { Toggle } from "@cortex-work/ui/controls/Toggle";
import { PaletteChips, type PaletteOption } from "@cortex-work/ui/controls/PaletteChips";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  DEFAULT_PUSH_TEMPLATE,
  PROVIDER_PRESETS,
  providerFromPreset,
  speakText,
  stopSpeaking,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalProfile,
  usePersonalStore,
  usePetStore,
  type PetKind,
  type PetMode,
} from "@cortex-work/core";
import type {
  AgentKind,
  DingtalkPushConfig,
  EmailPushConfig,
  EndpointFormat,
  ProviderModelOption,
  ProviderProfile,
  PromptNode,
  SummaryModelConfig,
  TtsEngineConfig,
  TtsVoiceOption,
  WecomPushConfig,
} from "@cortex-work/core";
import type { Density, FontScale, Palette, SidebarMode, ThemeMode } from "@cortex-work/core/types";
import {
  PET_COLOR_KEY,
  PET_DESIGNS,
  PET_KIND_KEY,
  PET_SIZE_KEY,
  PET_SIZE_MAX,
  PET_SIZE_MIN,
  petColorVars,
} from "../pet/designs";
import { savePetEnabled, savePetMode, savePetWalk } from "../pet/behavior";
import { BUILTIN_AVATARS } from "./avatars";

const PALETTES: PaletteOption[] = [
  { id: "clay", name: "Clay", colors: ["#c96442", "#f3e7df", "#1a1916"] },
  { id: "twilight", name: "Twilight", colors: ["#7c3aed", "#ede5fd", "#1a1916"] },
  { id: "forest", name: "Forest", colors: ["#0d9488", "#d4ebe8", "#1a1916"] },
  { id: "ink", name: "Ink", colors: ["#1a1916", "#e6e4dd", "#5e5c56"] },
];

const PET_KINDS = Object.keys(PET_DESIGNS) as PetKind[];

type SettingsTab = "profile" | "general" | "providers" | "agent" | "pet" | "timeline" | "push" | "voice";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "profile", label: "个人资料", icon: <Icon.Users size={14} /> },
  { id: "general", label: "通用", icon: <Icon.Settings size={14} /> },
  { id: "providers", label: "供应商", icon: <Icon.Globe size={14} /> },
  { id: "agent", label: "Agent", icon: <Icon.Terminal size={14} /> },
  { id: "pet", label: "宠物", icon: <Icon.Sparkle size={14} /> },
  { id: "timeline", label: "时间线", icon: <Icon.Clock size={14} /> },
  { id: "push", label: "推送", icon: <Icon.Send size={14} /> },
  { id: "voice", label: "语音", icon: <Icon.Mic size={14} /> },
];

// 颜色预设(主色;深/浅两档由 petColorVars 自动派生)。
const PET_COLOR_PRESETS = ["#ecb98a", "#e8a3b2", "#a3c4e8", "#9fc7a8", "#c9b6e8", "#9a958a"];

// 行为模式 ↔ 设置页展示文案(SegmentedRadio 以展示值为选项)。
const PET_MODE_LABEL: Record<PetMode, string> = { free: "自由放置", perch: "趴在输入框" };
const PET_MODE_OPTIONS = (Object.keys(PET_MODE_LABEL) as PetMode[]).map((m) => PET_MODE_LABEL[m]);

// 个人资料:昵称 + 内置头像（写入 personal store 的 profile 切片,随工作区落盘;
// 会话中 who="me" 的气泡据此渲染,见 ChatArea MessageAvatar/MessageHeader）。
function ProfileSection() {
  const profile = usePersonalProfile();
  const setProfile = usePersonalStore((s) => s.setProfile);
  const nickname = profile.nickname ?? "";
  return (
    <>
      <div className="pw-dlg-title">个人资料</div>
      <div className="pw-dlg-desc">设置你的昵称和头像,会话中你发出的消息会用它们显示。</div>

      <div className="twk-sect">昵称 · Nickname</div>
      <Field
        label="昵称"
        value={nickname}
        placeholder="我"
        onChange={(v) => setProfile({ nickname: v })}
      />

      <div className="twk-sect">头像 · Avatar</div>
      <div className="pw-pet-grid">
        {BUILTIN_AVATARS.map((a) => {
          const Svg = a.Svg;
          return (
            <button
              key={a.id}
              className={`pw-pet-card ${a.id === profile.avatarId ? "is-active" : ""}`}
              onClick={() => setProfile({ avatarId: a.id })}
              title={a.name}
            >
              <span className="pw-avatar-preview">
                <Svg />
              </span>
              <span className="pw-pet-name">{a.name}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function PetSection() {
  const petKind = usePetStore((s) => s.kind);
  const setPetKind = usePetStore((s) => s.setKind);
  const petMode = usePetStore((s) => s.mode);
  const setPetMode = usePetStore((s) => s.setMode);
  const petWalk = usePetStore((s) => s.walk);
  const setPetWalk = usePetStore((s) => s.setWalk);
  const petEnabled = usePetStore((s) => s.enabled);
  const setPetEnabled = usePetStore((s) => s.setEnabled);
  const petSize = usePetStore((s) => s.size);
  const setPetSize = usePetStore((s) => s.setSize);
  const petColor = usePetStore((s) => s.color);
  const setPetColor = usePetStore((s) => s.setColor);
  const pickMode = (label: string) => {
    const m = (Object.keys(PET_MODE_LABEL) as PetMode[]).find((k) => PET_MODE_LABEL[k] === label);
    if (!m) return;
    setPetMode(m);
    savePetMode(m);
  };
  const pickEnabled = (v: boolean) => {
    setPetEnabled(v);
    savePetEnabled(v);
  };
  const pickWalk = (v: boolean) => {
    setPetWalk(v);
    savePetWalk(v);
  };
  const pick = (k: PetKind) => {
    setPetKind(k);
    try {
      localStorage.setItem(PET_KIND_KEY, k);
    } catch {
      /* 忽略 */
    }
  };
  const pickSize = (v: number) => {
    setPetSize(v);
    try {
      localStorage.setItem(PET_SIZE_KEY, String(v));
    } catch {
      /* 忽略 */
    }
  };
  const pickColor = (c: string | null) => {
    setPetColor(c);
    try {
      if (c) localStorage.setItem(PET_COLOR_KEY, c);
      else localStorage.removeItem(PET_COLOR_KEY);
    } catch {
      /* 忽略 */
    }
  };
  const colorVars = petColor ? petColorVars(petColor) : null;
  return (
    <>
      <div className="pw-dlg-title">桌面宠物</div>
      <div className="pw-dlg-desc">选择陪伴你工作的小伙伴,它会随输入、思考、执行工具等状态切换动画。</div>

      <Toggle label="显示宠物" value={petEnabled} onChange={pickEnabled} />

      <div className="twk-sect">行为 · Behavior</div>
      <div className="pw-set-hint">
        「自由放置」可随意拖动;「趴在输入框」只露头和前爪搭在聊天框上。悬停宠物时点 ✕ 也可快速隐藏。
      </div>
      <SegmentedRadio value={PET_MODE_LABEL[petMode]} options={PET_MODE_OPTIONS} onChange={pickMode} />
      {petMode === "free" ? (
        <>
          <Toggle label="闲时底部走动" value={petWalk} onChange={pickWalk} />
          <div className="pw-set-hint">开启后:10 分钟没有任何操作,宠物沿应用底边来回散步;一有动静就平滑回到最右侧待命。</div>
        </>
      ) : null}

      <div className="twk-sect">造型 · Pet</div>
      <div className="pw-pet-grid" style={colorVars as React.CSSProperties | undefined}>
        {PET_KINDS.map((k) => {
          const d = PET_DESIGNS[k];
          const Parts = d.Parts;
          return (
            <button key={k} className={`pw-pet-card ${k === petKind ? "is-active" : ""}`} onClick={() => pick(k)}>
              <span className="pet-preview">
                <svg viewBox="0 0 140 120" width="84" height="72" aria-hidden="true">
                  <Parts />
                </svg>
              </span>
              <span className="pw-pet-name">{d.name}</span>
              <span className="pw-pet-desc">{d.desc}</span>
            </button>
          );
        })}
      </div>

      <div className="twk-sect">尺寸 · Size</div>
      <div className="pw-pet-size">
        <input
          type="range"
          min={PET_SIZE_MIN}
          max={PET_SIZE_MAX}
          step={0.05}
          value={petSize}
          onChange={(e) => pickSize(Number(e.target.value))}
          aria-label="宠物尺寸"
        />
        <span className="pw-pet-size-val">{Math.round(petSize * 100)}%</span>
        {petSize !== 1 ? (
          <button className="pw-pet-reset" onClick={() => pickSize(1)}>
            重置
          </button>
        ) : null}
      </div>

      <div className="twk-sect">颜色 · Color</div>
      <div className="pw-set-hint">选择主色后,毛色深浅会自动派生;「默认」恢复各造型的原始配色。</div>
      <div className="pw-pet-colors">
        <button
          className={`pw-pet-color-chip is-default ${petColor ? "" : "is-active"}`}
          title="默认配色"
          onClick={() => pickColor(null)}
        >
          默认
        </button>
        {PET_COLOR_PRESETS.map((c) => (
          <button
            key={c}
            className={`pw-pet-color-chip ${petColor?.toLowerCase() === c ? "is-active" : ""}`}
            style={{ background: c }}
            title={c}
            onClick={() => pickColor(c)}
          />
        ))}
        <label className="pw-pet-color-chip is-custom" title="自定义颜色">
          <input type="color" value={petColor ?? "#ecb98a"} onChange={(e) => pickColor(e.target.value)} />
          <Icon.Plus size={12} />
        </label>
      </div>
    </>
  );
}

const THEME_LABEL: Record<ThemeMode, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
const FONT_SCALE_LABEL: Record<FontScale, string> = { small: "小", medium: "中", large: "大" };

// 通用设置：外观（密度/色调/侧栏）+ 主题与字号。
// 桌面行为 / 默认工作目录 / 日志由后续单元追加分节（U9-U11）。
function GeneralSection() {
  const tweaks = useCortexUIStore((s) => s.tweaks);
  const setTweak = useCortexUIStore((s) => s.setTweak);
  const pickTheme = (label: string) => {
    const t = (Object.keys(THEME_LABEL) as ThemeMode[]).find((k) => THEME_LABEL[k] === label);
    if (t) setTweak("theme", t);
  };
  const pickFontScale = (label: string) => {
    const f = (Object.keys(FONT_SCALE_LABEL) as FontScale[]).find((k) => FONT_SCALE_LABEL[k] === label);
    if (f) setTweak("fontScale", f);
  };
  return (
    <>
      <div className="pw-dlg-title">通用</div>

      <div className="twk-sect">主题 · Theme</div>
      <div className="pw-set-hint">「跟随系统」随 macOS 明暗自动切换。</div>
      <SegmentedRadio
        value={THEME_LABEL[tweaks.theme]}
        options={(Object.keys(THEME_LABEL) as ThemeMode[]).map((t) => THEME_LABEL[t])}
        onChange={pickTheme}
      />

      <div className="twk-sect">字号 · Font Size</div>
      <SegmentedRadio
        value={FONT_SCALE_LABEL[tweaks.fontScale]}
        options={(Object.keys(FONT_SCALE_LABEL) as FontScale[]).map((f) => FONT_SCALE_LABEL[f])}
        onChange={pickFontScale}
      />

      <div className="twk-sect">布局密度 · Density</div>
      <SegmentedRadio
        value={tweaks.density}
        options={["compact", "regular", "cozy"]}
        onChange={(v) => setTweak("density", v as Density)}
      />
      <div className="twk-sect">品牌色调 · Palette</div>
      <PaletteChips value={tweaks.palette} options={PALETTES} onChange={(v) => setTweak("palette", v as Palette)} />
      <div className="twk-sect">侧栏样式 · Sidebar</div>
      <SegmentedRadio
        value={tweaks.sidebar}
        options={["rich", "minimal", "activity"]}
        onChange={(v) => setTweak("sidebar", v as SidebarMode)}
      />
    </>
  );
}

// ── 时间线日报设置 ─────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "password";
}) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <input
        className="pw-set-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

// 集成 Agent 列表（与会话创建可选的 agent 一致,来自 AGENT_MODELS 注册表;
// 新增 agent 接入后此处自动出现）。
const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
const INTEGRATED_AGENTS = Object.keys(AGENT_MODELS) as AgentKind[];

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <select className="pw-set-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TimelineSection() {
  const settings = usePersonalStore((s) => s.timelineSettings);
  const setSettings = usePersonalStore((s) => s.setTimelineSettings);
  const model = settings.summaryModel;
  const setModel = (m: SummaryModelConfig) => setSettings({ summaryModel: m });

  return (
    <>
      <div className="pw-dlg-title">时间线</div>
      <div className="pw-dlg-desc">配置 AI 日报的生成模型。推送渠道在「推送」设置中统一管理。</div>

      <div className="twk-sect">日报生成模型</div>
      <SegmentedRadio
        value={model.kind === "agent" ? "集成 Agent" : "自定义模型"}
        options={["集成 Agent", "自定义模型"]}
        onChange={(v) =>
          setModel(
            v === "集成 Agent"
              ? { kind: "agent", agent: "claude", model: "haiku" }
              : { kind: "openai", baseUrl: "http://localhost:11434", apiKey: "", model: "" },
          )
        }
      />
      {model.kind === "agent" ? (
        <div className="pw-set-group">
          <div className="pw-set-hint">从已集成的 Agent 中选择,按所选 Agent 提供对应的模型列表。</div>
          <div className="pw-set-row2">
            <Select
              label="Agent"
              value={model.agent}
              options={INTEGRATED_AGENTS.map((a) => ({ label: AGENT_LABEL[a], value: a }))}
              onChange={(v) => {
                const agent = v as AgentKind;
                // 切换 agent 时模型重置为该 agent 的默认值。
                setModel({ kind: "agent", agent, model: DEFAULT_MODEL[agent] });
              }}
            />
            <Select
              label="模型"
              value={model.model ?? DEFAULT_MODEL[model.agent]}
              options={AGENT_MODELS[model.agent]}
              onChange={(v) => setModel({ kind: "agent", agent: model.agent, model: v })}
            />
          </div>
        </div>
      ) : (
        <div className="pw-set-group">
          <div className="pw-set-hint">OpenAI 兼容接口（Ollama / LM Studio / vLLM 等本地模型均可）。</div>
          <Field
            label="Base URL"
            value={model.baseUrl}
            placeholder="http://localhost:11434"
            onChange={(v) => setModel({ ...model, baseUrl: v })}
          />
          <Field
            label="模型名"
            value={model.model}
            placeholder="qwen3:14b"
            onChange={(v) => setModel({ ...model, model: v })}
          />
          <Field
            label="API Key（可选）"
            value={model.apiKey ?? ""}
            type="password"
            onChange={(v) => setModel({ ...model, apiKey: v })}
          />
        </div>
      )}
    </>
  );
}

// ── 供应商（Provider）设置 ──────────────────────────────────────────────────

// provider id slug 化:作为 pi provider 名,仅允许字母数字与 - _。
function slugify(s: string): string {
  const out = s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "provider";
}

// 模型多行文本 ↔ ProviderModelOption[]:每行 "id" 或 "id|显示名"。
function parseModels(text: string): ProviderModelOption[] {
  const out: ProviderModelOption[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("|");
    const id = (parts[0] ?? "").trim();
    const label = (parts[1] ?? "").trim();
    if (!id) continue;
    out.push(label ? { id, label } : { id });
  }
  return out;
}
function modelsToText(models: ProviderModelOption[]): string {
  return models.map((m) => (m.label ? `${m.id}|${m.label}` : m.id)).join("\n");
}

const ENDPOINT_FORMAT_OPTIONS: { label: string; value: EndpointFormat }[] = [
  { label: "OpenAI 兼容 (chat/completions)", value: "chat_completions" },
  { label: "OpenAI Responses", value: "responses" },
  { label: "Anthropic Messages", value: "messages" },
  { label: "自定义端点（不可探测）", value: "custom" },
];

// 带显隐切换的密钥输入（本仓原无 SecretInput,此处新增）。
function SecretField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <span className="pw-secret-wrap">
        <input
          className="pw-set-input"
          type={show ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="pw-secret-toggle" onClick={() => setShow((s) => !s)}>
          {show ? "隐藏" : "显示"}
        </button>
      </span>
    </label>
  );
}

// 两段式删除确认（仿 ProjectMenu:首次点击进入确认态,再次点击执行,失焦撤销）。
function ConfirmDelete({ onConfirm, title }: { onConfirm: () => void; title?: string }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      className={`pw-pi-channel-del ${confirming ? "is-confirming" : ""}`}
      title={title}
      onClick={() => (confirming ? onConfirm() : setConfirming(true))}
      onBlur={() => setConfirming(false)}
    >
      {confirming ? "确认删除？" : <Icon.Trash size={14} />}
    </button>
  );
}

// 供应商详情表单（右栏），含连接测试四态（idle / 测试中 / 成功+回填 / 失败）。
type ProbeState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; models: string[] }
  | { kind: "err"; error: string };

function ProviderDetail({
  provider,
  onPatch,
  onRemove,
}: {
  provider: ProviderProfile;
  onPatch: (patch: Partial<ProviderProfile>) => void;
  onRemove: () => void;
}) {
  const bridge = useDesktopBridge();
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const canProbe =
    !!bridge?.probeProvider && provider.endpointFormat !== "custom" && !!provider.baseUrl.trim();

  const runProbe = async () => {
    if (!bridge?.probeProvider || probe.kind === "testing") return;
    setProbe({ kind: "testing" });
    try {
      const res = await bridge.probeProvider({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        endpointFormat: provider.endpointFormat,
      });
      setProbe(res.ok ? { kind: "ok", models: res.models ?? [] } : { kind: "err", error: res.error ?? "连接失败" });
    } catch (e) {
      setProbe({ kind: "err", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const applyModels = (ids: string[]) => {
    onPatch({ models: ids.map((id) => ({ id })) });
    setProbe({ kind: "idle" });
  };

  return (
    <div className="pw-prov-detail">
      <div className="pw-pi-channel-head">
        <input
          className="pw-set-input"
          value={provider.name}
          placeholder="供应商名称"
          spellCheck={false}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <Toggle label="启用" value={provider.enabled} onChange={(v) => onPatch({ enabled: v })} />
        <ConfirmDelete onConfirm={onRemove} title="删除供应商" />
      </div>
      <Select
        label="协议类型"
        value={provider.endpointFormat}
        options={ENDPOINT_FORMAT_OPTIONS}
        onChange={(v) => onPatch({ endpointFormat: v as EndpointFormat })}
      />
      <Field
        label="Base URL"
        value={provider.baseUrl}
        placeholder="https://api.deepseek.com/v1"
        onChange={(v) => onPatch({ baseUrl: v })}
      />
      <SecretField
        label="API Key"
        value={provider.apiKey ?? ""}
        placeholder="该供应商的 API Key"
        onChange={(v) => onPatch({ apiKey: v || undefined })}
      />
      <label className="pw-set-field">
        <span className="pw-set-lbl">模型（每行一个,可写 id|显示名）</span>
        <textarea
          className="pw-set-input"
          rows={4}
          value={modelsToText(provider.models)}
          placeholder="deepseek-chat|DeepSeek Chat"
          spellCheck={false}
          onChange={(e) => onPatch({ models: parseModels(e.target.value) })}
        />
      </label>

      <div className="pw-prov-probe">
        <button
          className="pw-tl-gen"
          disabled={!canProbe || probe.kind === "testing"}
          onClick={() => void runProbe()}
          title={provider.endpointFormat === "custom" ? "自定义端点不支持探测" : undefined}
        >
          <Icon.Globe size={12} />
          {probe.kind === "testing" ? "测试中…" : "测试连接 / 拉取模型"}
        </button>
        {probe.kind === "ok" ? (
          <span className="pw-prov-probe-ok">
            连接成功,{probe.models.length} 个模型
            {probe.models.length > 0 ? (
              <button className="pw-prov-probe-apply" onClick={() => applyModels(probe.models)}>
                填入模型
              </button>
            ) : null}
          </span>
        ) : null}
        {probe.kind === "err" ? <span className="pw-prov-probe-err">{probe.error}</span> : null}
      </div>
    </div>
  );
}

function ProvidersSection() {
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const addProvider = usePersonalStore((s) => s.addProvider);
  const updateProvider = usePersonalStore((s) => s.updateProvider);
  const removeProvider = usePersonalStore((s) => s.removeProvider);
  const providers = providerSettings.providers;
  const [selectedId, setSelectedId] = useState<string | undefined>(providers[0]?.id);
  const [tmplKey, setTmplKey] = useState(PROVIDER_PRESETS[0]?.templateKey ?? "deepseek");

  const selected = providers.find((p) => p.id === selectedId) ?? providers[0];

  const addFromTemplate = () => {
    const t = PROVIDER_PRESETS.find((x) => x.templateKey === tmplKey);
    if (!t) return;
    const base = slugify(t.templateKey === "custom" ? "custom-provider" : t.templateKey);
    const existing = new Set(providers.map((p) => p.id));
    let id = base;
    let n = 1;
    while (existing.has(id)) id = `${base}-${++n}`;
    addProvider(providerFromPreset(t, id));
    setSelectedId(id);
  };

  return (
    <>
      <div className="pw-dlg-title">供应商</div>
      <div className="pw-dlg-desc">
        配置 LLM 供应商（OpenAI 兼容 / Anthropic 兼容端点）。Pi 兜底 Agent 在「Agent」设置中选用这里的供应商;API
        Key 仅本机保存。
      </div>

      <div className="pw-pi-add">
        <Select
          label="从模板添加"
          value={tmplKey}
          options={PROVIDER_PRESETS.map((t) => ({ label: t.name, value: t.templateKey }))}
          onChange={setTmplKey}
        />
        <button className="btn pw-pi-add-btn" onClick={addFromTemplate}>
          添加供应商
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="pw-set-hint">
          还没有供应商。选择模板（或「自定义」）后点「添加供应商」,填好 API Key 即可在会话中选用。
        </div>
      ) : (
        <div className="pw-prov-split">
          <div className="pw-prov-list">
            {providers.map((p) => (
              <button
                key={p.id}
                className={`pw-prov-item ${p.id === selected?.id ? "is-active" : ""}`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="pw-prov-item-name">{p.name || p.id}</span>
                <span className="pw-prov-item-meta">
                  {providerSettings.defaultProviderId === p.id ? (
                    <span className="pw-prov-badge is-default">默认</span>
                  ) : null}
                  {p.enabled ? null : <span className="pw-prov-badge">已停用</span>}
                  <span className="pw-prov-badge">{p.models.length} 模型</span>
                </span>
              </button>
            ))}
          </div>
          {selected ? (
            <ProviderDetail
              key={selected.id}
              provider={selected}
              onPatch={(patch) => updateProvider(selected.id, patch)}
              onRemove={() => {
                removeProvider(selected.id);
                setSelectedId(undefined);
              }}
            />
          ) : null}
        </div>
      )}
    </>
  );
}

// ── Agent 设置（引用供应商）─────────────────────────────────────────────────

function AgentSection() {
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const setProviderDefaults = usePersonalStore((s) => s.setProviderDefaults);
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const enabledProviders = providerSettings.providers.filter((p) => p.enabled);
  // defaultProviderId 可能指向已删除/已停用的 provider → 下拉回退「（未设置）」。
  const defaultProvider = enabledProviders.find((p) => p.id === providerSettings.defaultProviderId);
  const defaultValue = defaultProvider ? defaultProvider.id : "";

  return (
    <>
      <div className="pw-dlg-title">Agent</div>
      <div className="pw-dlg-desc">
        Cortex 支持 Claude Code、Codex、内置 Pi 三种 Agent。Claude / Codex 用各自 CLI 自带鉴权;Pi 在未装 CLI
        时兜底,使用「供应商」中配置的 LLM 端点。
      </div>

      <div className="twk-sect">可用性</div>
      <div className="pw-set-group">
        {INTEGRATED_AGENTS.map((a) => {
          const on = a === "pi" || !!agentsAvailable?.[a];
          return (
            <div key={a} className="pw-agent-avail">
              <span>{AGENT_LABEL[a]}</span>
              <span className={`pw-agent-dot ${on ? "is-on" : "is-off"}`}>
                {a === "pi" ? "内置" : agentsAvailable?.[a] ? "已安装" : "未检测到 CLI"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="twk-sect">Pi 默认供应商</div>
      <div className="pw-set-group">
        {enabledProviders.length === 0 ? (
          <div className="pw-set-hint">还没有启用的供应商。先在「供应商」设置中添加并启用,再回此处选默认。</div>
        ) : (
          <div className="pw-set-row2">
            <Select
              label="默认供应商"
              value={defaultValue}
              options={[
                { label: "（未设置）", value: "" },
                ...enabledProviders.map((p) => ({ label: p.name || p.id, value: p.id })),
              ]}
              onChange={(v) => setProviderDefaults({ defaultProviderId: v || undefined, defaultModel: undefined })}
            />
            <Select
              label="默认模型"
              value={providerSettings.defaultModel ?? ""}
              options={[
                { label: "（供应商首个模型）", value: "" },
                ...(defaultProvider?.models ?? []).map((m) => ({ label: m.label ?? m.id, value: m.id })),
              ]}
              onChange={(v) => setProviderDefaults({ defaultModel: v || undefined })}
            />
          </div>
        )}
      </div>
    </>
  );
}

// Prompt 库树拍平为 .md 文件列表（推送格式 Skill 候选）。
function flattenPromptFiles(node: PromptNode | undefined): { name: string; path: string }[] {
  if (!node) return [];
  const out: { name: string; path: string }[] = [];
  const walk = (n: PromptNode) => {
    if (n.kind === "file") out.push({ name: n.name, path: n.path });
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

const EXAMPLE_SKILL_NAME = "推送格式-日报.md";

// 全局推送渠道：所有需要推送的场景（当前为时间线日报,未来任务通知等）共用。
function PushSection() {
  const bridge = useDesktopBridge();
  const push = usePersonalStore((s) => s.pushSettings);
  const setPush = usePersonalStore((s) => s.setPushSettings);
  const promptRoot = usePersonalStore((s) => s.promptRoot);
  const promptTree = usePersonalStore((s) => s.promptTree);
  const setPromptTree = usePersonalStore((s) => s.setPromptTree);
  const { wecom, dingtalk, email } = push;

  const skillFiles = flattenPromptFiles(promptTree);
  // 已配置的 skill 不在 Prompt 库里（被移动/删除）时仍显示,便于用户察觉。
  const skillOptions = [
    { label: "默认格式（内置）", value: "" },
    ...skillFiles.map((f) => ({ label: f.name, value: f.path })),
    ...(push.formatSkillPath && !skillFiles.some((f) => f.path === push.formatSkillPath)
      ? [{ label: `${push.formatSkillPath}（已失效）`, value: push.formatSkillPath }]
      : []),
  ];

  const createExampleSkill = async () => {
    if (!bridge || !promptRoot) return;
    const path = `${promptRoot.replace(/[/\\]+$/, "")}/${EXAMPLE_SKILL_NAME}`;
    await bridge.writeFile(path, DEFAULT_PUSH_TEMPLATE);
    setPush({ formatSkillPath: path });
    try {
      setPromptTree(await bridge.scanPromptTree(promptRoot));
    } catch {
      // 重扫失败不影响已写入的 skill 生效。
    }
  };

  const setWecom = (patch: Partial<WecomPushConfig>) =>
    setPush({ wecom: { enabled: false, webhookUrl: "", ...wecom, ...patch } });
  const setDingtalk = (patch: Partial<DingtalkPushConfig>) =>
    setPush({ dingtalk: { enabled: false, webhookUrl: "", ...dingtalk, ...patch } });
  const setEmail = (patch: Partial<EmailPushConfig>) =>
    setPush({
      email: {
        enabled: false,
        smtpHost: "",
        smtpPort: 465,
        secure: true,
        user: "",
        pass: "",
        from: "",
        to: "",
        ...email,
        ...patch,
      },
    });

  return (
    <>
      <div className="pw-dlg-title">推送渠道</div>
      <div className="pw-dlg-desc">全局推送配置,启用后可在任何支持推送的功能中使用（如时间线日报）。</div>

      <div className="twk-sect">推送格式 Skill</div>
      <div className="pw-set-group">
        <div className="pw-set-hint">
          用 Prompt 库中的 .md 模板固化推送格式,渲染后的第一行作为推送标题。可用占位符:
          {" {{project}} 项目名、{{date}} 日期、{{stats}} 统计、{{summary}} 日报正文、{{runs}} 交互列表、{{files}} 文件列表、{{commits}} 提交列表"}
          ;数据为空的占位符行会自动隐藏。
        </div>
        <Select
          label="格式模板"
          value={push.formatSkillPath ?? ""}
          options={skillOptions}
          onChange={(v) => setPush({ formatSkillPath: v || undefined })}
        />
        <div>
          <button className="pw-tl-gen" disabled={!bridge || !promptRoot} onClick={() => void createExampleSkill()}>
            <Icon.Plus size={12} />
            在 Prompt 库创建示例 Skill
          </button>
          {!promptRoot ? <span className="pw-set-hint">（需先在右栏 Prompt 库选择目录）</span> : null}
        </div>
      </div>

      <div className="twk-sect">渠道</div>
      <div className="pw-set-group">
        <Toggle label="企业微信机器人" value={!!wecom?.enabled} onChange={(v) => setWecom({ enabled: v })} />
        {wecom?.enabled ? (
          <Field
            label="Webhook 地址"
            value={wecom.webhookUrl}
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
            onChange={(v) => setWecom({ webhookUrl: v })}
          />
        ) : null}
      </div>
      <div className="pw-set-group">
        <Toggle label="钉钉机器人" value={!!dingtalk?.enabled} onChange={(v) => setDingtalk({ enabled: v })} />
        {dingtalk?.enabled ? (
          <>
            <Field
              label="Webhook 地址"
              value={dingtalk.webhookUrl}
              placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
              onChange={(v) => setDingtalk({ webhookUrl: v })}
            />
            <Field
              label="加签密钥（可选）"
              value={dingtalk.secret ?? ""}
              type="password"
              placeholder="SEC…（机器人安全设置为「加签」时填写）"
              onChange={(v) => setDingtalk({ secret: v })}
            />
          </>
        ) : null}
      </div>
      <div className="pw-set-group">
        <Toggle label="邮件（SMTP）" value={!!email?.enabled} onChange={(v) => setEmail({ enabled: v })} />
        {email?.enabled ? (
          <>
            <div className="pw-set-row2">
              <Field label="SMTP 服务器" value={email.smtpHost} placeholder="smtp.qq.com" onChange={(v) => setEmail({ smtpHost: v })} />
              <Field
                label="端口"
                value={String(email.smtpPort || "")}
                placeholder="465"
                onChange={(v) => setEmail({ smtpPort: Number(v) || 0 })}
              />
            </div>
            <Toggle label="SSL（465 端口开启,587 关闭）" value={email.secure} onChange={(v) => setEmail({ secure: v })} />
            <div className="pw-set-row2">
              <Field label="账号" value={email.user} onChange={(v) => setEmail({ user: v })} />
              <Field label="密码 / 授权码" value={email.pass} type="password" onChange={(v) => setEmail({ pass: v })} />
            </div>
            <div className="pw-set-row2">
              <Field label="发件人" value={email.from} placeholder="留空使用账号" onChange={(v) => setEmail({ from: v })} />
              <Field label="收件人" value={email.to} placeholder="多个用逗号分隔" onChange={(v) => setEmail({ to: v })} />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

// ── 语音 TTS ──────────────────────────────────────────────────────────────

const SPEECH_RATES = [
  { label: "0.8×", value: "0.8" },
  { label: "1×（默认）", value: "1" },
  { label: "1.2×", value: "1.2" },
  { label: "1.5×", value: "1.5" },
];

const FALLBACK_TTS_VOICES: TtsVoiceOption[] = [
  { id: "alloy" },
  { id: "ash" },
  { id: "ballad" },
  { id: "coral" },
  { id: "echo" },
  { id: "fable" },
  { id: "nova" },
  { id: "onyx" },
  { id: "sage" },
  { id: "shimmer" },
];

const TTS_LANGUAGES = [
  { label: "中文 zh", value: "zh" },
  { label: "中文 zh-CN", value: "zh-CN" },
  { label: "English en", value: "en" },
  { label: "日本語 ja", value: "ja" },
  { label: "한국어 ko", value: "ko" },
];

function VoiceSection() {
  const bridge = useDesktopBridge();
  const tts = usePersonalStore((s) => s.ttsSettings);
  const setTts = usePersonalStore((s) => s.setTtsSettings);
  const engine = tts.engine;
  const setEngine = (e: TtsEngineConfig) => setTts({ engine: e });
  const [testing, setTesting] = useState(false);
  const [customVoices, setCustomVoices] = useState<TtsVoiceOption[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  // 系统语音列表（speechSynthesis 异步加载,中文音色排前）。
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => {
      const list = [...synth.getVoices()];
      list.sort((a, b) => Number(b.lang.startsWith("zh")) - Number(a.lang.startsWith("zh")));
      setVoices(list);
    };
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, []);
  const voiceOptions = useMemo(
    () => [
      { label: "系统默认", value: "" },
      ...voices.map((v) => ({ label: `${v.name}（${v.lang}）`, value: v.name })),
    ],
    [voices],
  );

  useEffect(() => {
    if (engine.kind !== "openai" || !bridge || !engine.baseUrl || !engine.model) {
      setCustomVoices([]);
      setLoadingVoices(false);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    bridge
      .listTtsVoices({ baseUrl: engine.baseUrl, apiKey: engine.apiKey, model: engine.model })
      .then((list) => {
        if (alive) setCustomVoices(list);
      })
      .catch(() => {
        if (alive) setCustomVoices([]);
      })
      .finally(() => {
        if (alive) setLoadingVoices(false);
      });
    return () => {
      alive = false;
    };
  }, [bridge, engine]);

  const customVoiceOptions = useMemo(() => {
    if (engine.kind !== "openai") return [];
    const source = customVoices.length > 0 ? customVoices : FALLBACK_TTS_VOICES;
    const seen = new Set<string>();
    const options: { label: string; value: string }[] = [];
    for (const v of source) {
      if (!v.id || seen.has(v.id)) continue;
      seen.add(v.id);
      const suffix = v.locale ? ` · ${v.locale}` : "";
      options.push({ value: v.id, label: `${v.label ?? v.id}${suffix}` });
    }
    if (engine.voice && !seen.has(engine.voice)) options.unshift({ value: engine.voice, label: `${engine.voice}（当前）` });
    return options;
  }, [customVoices, engine]);

  const test = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await speakText(bridge, tts, "你好,这是 Cortex Desktop 的语音测试。");
    } catch {
      // 端点不可用等,静默（按钮恢复即提示完成）
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="pw-dlg-title">语音（TTS）</div>
      <div className="pw-dlg-desc">把 Agent / 大模型输出的内容转成语音。开启自动朗读后,每轮回复完成时朗读（代码块等会自动略过,新回复打断上一条）。</div>

      <Toggle label="自动朗读 Agent 回复" value={tts.autoSpeak} onChange={(v) => setTts({ autoSpeak: v })} />

      <div className="twk-sect">语音引擎</div>
      <SegmentedRadio
        value={engine.kind === "system" ? "系统语音" : "自定义模型"}
        options={["系统语音", "自定义模型"]}
        onChange={(v) =>
          setEngine(
            v === "系统语音"
              ? { kind: "system" }
              : { kind: "openai", baseUrl: "http://localhost:8880", apiKey: "", model: "tts-1", voice: "alloy", language: "zh" },
          )
        }
      />
      {engine.kind === "system" ? (
        <div className="pw-set-group">
          <div className="pw-set-hint">使用本机系统语音库,无需联网与配置。</div>
          <div className="pw-set-row2">
            <Select
              label="音色"
              value={engine.voice ?? ""}
              options={voiceOptions}
              onChange={(v) => setEngine({ ...engine, voice: v || undefined })}
            />
            <Select
              label="语速"
              value={String(engine.rate ?? 1)}
              options={SPEECH_RATES}
              onChange={(v) => setEngine({ ...engine, rate: Number(v) })}
            />
          </div>
        </div>
      ) : (
        <div className="pw-set-group">
          <div className="pw-set-hint">
            OpenAI 兼容 /v1/audio/speech 接口（OpenAI TTS、LocalAI、Kokoro-FastAPI 等本地部署均可）。
          </div>
          <Field
            label="Base URL"
            value={engine.baseUrl}
            placeholder="http://localhost:8880"
            onChange={(v) => setEngine({ ...engine, baseUrl: v })}
          />
          <div className="pw-set-row2">
            <Field label="模型名" value={engine.model} placeholder="tts-1" onChange={(v) => setEngine({ ...engine, model: v })} />
            <Select
              label={loadingVoices ? "音色 voice（加载中）" : customVoices.length > 0 ? "音色 voice（模型返回）" : "音色 voice（常用）"}
              value={engine.voice}
              options={customVoiceOptions}
              onChange={(v) => setEngine({ ...engine, voice: v })}
            />
          </div>
          <Field
            label="自定义 voice"
            value={engine.voice}
            placeholder="alloy"
            onChange={(v) => setEngine({ ...engine, voice: v })}
          />
          <div className="pw-set-row2">
            <Field
              label="API Key（可选）"
              value={engine.apiKey ?? ""}
              type="password"
              onChange={(v) => setEngine({ ...engine, apiKey: v })}
            />
            <Select
              label="语言 language"
              value={engine.language ?? "zh"}
              options={TTS_LANGUAGES}
              onChange={(v) => setEngine({ ...engine, language: v })}
            />
          </div>
          <div className="pw-set-row2">
            <Field
              label="自定义 language"
              value={engine.language ?? "zh"}
              placeholder="zh"
              onChange={(v) => setEngine({ ...engine, language: v || undefined })}
            />
            <Select
              label="语速"
              value={String(engine.speed ?? 1)}
              options={SPEECH_RATES}
              onChange={(v) => setEngine({ ...engine, speed: Number(v) })}
            />
          </div>
        </div>
      )}

      <div className="pw-set-group">
        <div>
          <button className="pw-tl-gen" disabled={testing} onClick={() => void test()}>
            <Icon.Mic size={12} />
            {testing ? "播放中…" : "试听"}
          </button>
          <button className="pw-tl-gen" style={{ marginLeft: 8 }} onClick={() => stopSpeaking()}>
            <Icon.Stop size={12} />
            停止
          </button>
        </div>
      </div>
    </>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("profile");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
      <div className="pw-dlg" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <nav className="pw-dlg-nav">
          <div className="pw-dlg-nav-h">设置</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`pw-dlg-nav-item ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="pw-dlg-body">
          <button className="pw-dlg-x" title="关闭" onClick={onClose}>
            <Icon.X size={15} />
          </button>
          {tab === "profile" ? (
            <ProfileSection />
          ) : tab === "general" ? (
            <GeneralSection />
          ) : tab === "providers" ? (
            <ProvidersSection />
          ) : tab === "agent" ? (
            <AgentSection />
          ) : tab === "pet" ? (
            <PetSection />
          ) : tab === "timeline" ? (
            <TimelineSection />
          ) : tab === "push" ? (
            <PushSection />
          ) : (
            <VoiceSection />
          )}
        </div>
      </div>
    </div>
  );
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="sb-foot">
      <button className={`sb-row is-mute ${open ? "is-active" : ""}`} onClick={() => setOpen(true)}>
        <Icon.Settings size={15} />
        <span className="label">设置</span>
      </button>
      {open ? <SettingsDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
