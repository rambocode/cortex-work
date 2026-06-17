// 个人工作区左栏底部「设置」入口 + 全屏整页设置视图（PersonalSettingsView）。
// 入口：点击调用 store.openSettings()（settingsOpen 瞬态标志,见 store/personal.ts）。
// 整页：全屏不透明覆盖层（.pw-settings-page）接管整窗、隐藏侧栏;底层工作区不卸载以
//   保活终端。左栏菜单（8 分区:个人资料/通用/供应商/Agent/宠物/时间线/推送/语音）
//   + 顶部「返回应用」,右栏按 active tab 渲染对应 Section;ESC 返回（录制/输入态豁免）。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { Toggle } from "@cortex-work/ui/controls/Toggle";
import { PaletteChips, type PaletteOption } from "@cortex-work/ui/controls/PaletteChips";
import { HotkeyCapture } from "@cortex-work/ui/controls/HotkeyCapture";
import { formatAccelerator } from "@cortex-work/ui/controls/hotkeyAccelerator";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  DEFAULT_PI_APPROVAL_TOOLS,
  PI_APPROVAL_TOOL_OPTIONS,
  PI_THINKING_LEVELS,
  PI_THINKING_LABELS,
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
  DesktopBridge,
  DingtalkPushConfig,
  EmailPushConfig,
  EndpointFormat,
  ProviderModelOption,
  ProviderProfile,
  PromptNode,
  SummaryModelConfig,
  ThinkingLevel,
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

type SettingsTab = "profile" | "general" | "providers" | "agent" | "pi" | "pet" | "timeline" | "push" | "voice";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "profile", label: "个人资料", icon: <Icon.Users size={14} /> },
  { id: "general", label: "通用", icon: <Icon.Settings size={14} /> },
  { id: "providers", label: "供应商", icon: <Icon.Globe size={14} /> },
  { id: "agent", label: "Agent", icon: <Icon.Terminal size={14} /> },
  { id: "pi", label: "Pi", icon: <Icon.Bot size={14} /> },
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

      <SettingCard title="昵称与头像">
        <SRow label="昵称" desc="会话中你发出的消息显示的名字。">
          <input
            className="pw-set-input"
            value={nickname}
            placeholder="我"
            spellCheck={false}
            onChange={(e) => setProfile({ nickname: e.target.value })}
          />
        </SRow>
        <SBlock label="头像">
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
        </SBlock>
      </SettingCard>
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

      <SettingCard title="宠物">
        <SwitchRow label="显示宠物" value={petEnabled} onChange={pickEnabled} />
        <SRow label="行为" desc="「自由放置」可随意拖动;「趴在输入框」只露头和前爪搭在聊天框上。">
          <SegmentedRadio value={PET_MODE_LABEL[petMode]} options={PET_MODE_OPTIONS} onChange={pickMode} />
        </SRow>
        {petMode === "free" ? (
          <SwitchRow
            label="闲时底部走动"
            desc="10 分钟无操作时沿应用底边散步,一有动静即回最右侧待命。"
            value={petWalk}
            onChange={pickWalk}
          />
        ) : null}
      </SettingCard>

      <SettingCard title="造型与外观">
        <SBlock label="造型">
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
        </SBlock>
        <SRow label="尺寸">
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
        </SRow>
        <SBlock label="颜色" desc="选择主色后,毛色深浅会自动派生;「默认」恢复各造型的原始配色。">
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
        </SBlock>
      </SettingCard>
    </>
  );
}

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: "跟随系统", value: "system" },
  { label: "浅色", value: "light" },
  { label: "深色", value: "dark" },
];
const FONT_SCALE_LABEL: Record<FontScale, string> = { small: "小", medium: "中", large: "大" };
const LOG_RETENTION_OPTIONS = [1, 2, 3, 5, 7].map((d) => ({ label: `${d} 天`, value: String(d) }));

// 闪记默认全局热键(与主进程 NOTES_HOTKEY_ACCELERATOR 同步;notesHotkey 留空即走此默认）。
const DEFAULT_NOTES_HOTKEY = "CommandOrControl+Shift+N";

// 显示用 isMac:views 不直接读 window,经 navigator 即时探测(ComposerShell / FilesView 等亦如此)。
function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

// kun 风格设置卡片 + 行（标签/说明在左,控件在右,行间分隔线）。
function SettingCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pw-scard">
      <div className="pw-scard-t">{title}</div>
      {children}
    </div>
  );
}
// 标签在上、内容全宽的块（宽控件用：头像网格 / 宠物造型 / 多字段表单）。
function SBlock({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="pw-sblock">
      <div className="pw-sblock-head">
        <span className="pw-srow-lbl">{label}</span>
        {desc ? <span className="pw-srow-desc">{desc}</span> : null}
      </div>
      {children}
    </div>
  );
}
function SRow({
  label,
  desc,
  children,
  end,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
  end?: boolean;
}) {
  return (
    <div className="pw-srow">
      <div className="pw-srow-l">
        <span className="pw-srow-lbl">{label}</span>
        {desc ? <span className="pw-srow-desc">{desc}</span> : null}
      </div>
      <div className={`pw-srow-c ${end ? "pw-srow-c-end" : ""}`}>{children}</div>
    </div>
  );
}
function SwitchRow({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SRow label={label} desc={desc} end>
      <button
        type="button"
        className="twk-toggle"
        data-on={value ? "1" : "0"}
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </SRow>
  );
}
function BareSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select className="pw-set-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function GeneralSection() {
  const tweaks = useCortexUIStore((s) => s.tweaks);
  const setTweak = useCortexUIStore((s) => s.setTweak);
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const bridge = useDesktopBridge();
  const pushToast = useCortexUIStore((s) => s.pushToast);
  const isMac = useMemo(() => detectIsMac(), []);
  const notesHotkey = general.notesHotkey ?? DEFAULT_NOTES_HOTKEY;
  const behavior = general.desktopBehavior;
  const setBehavior = (patch: Partial<typeof behavior>) => {
    const next = { ...behavior, ...patch };
    setGeneral({ desktopBehavior: next });
    void bridge?.setDesktopBehavior?.(next);
  };
  // 闪记热键双写:乐观持久化 + 即时通知主进程重注册;被拒(占用/无效)时回滚到旧键,
  // 保证「UI 显示 = 主进程实际绑定」,避免重启再降级。web 端 / 旧壳无桥则仅乐观持久化。
  const applyNotesHotkey = async (acc: string) => {
    const oldAcc = notesHotkey; // 当前实际生效键(已含默认兜底)。
    setGeneral({ notesHotkey: acc }); // 乐观持久化:控件随 notesHotkey 立即显示新键。
    const r = await bridge?.setNotesHotkey?.(acc); // 即时重注册。
    if (!r) return; // r === undefined:web 端 / 旧壳无此能力,保留乐观持久化,不反馈。
    if (r.ok) {
      pushToast(`闪记快捷键已更新为 ${formatAccelerator(acc, isMac)}`, { kind: "success" });
    } else {
      // 被拒(占用/无效/三级兜底落空):回滚显示与持久化到旧键,保持显示=实际。
      setGeneral({ notesHotkey: oldAcc });
      pushToast(r.toast ?? "快捷键设置失败,已保留原快捷键", { kind: "error" });
    }
  };
  const pickWorkspace = async () => {
    const dir = await bridge?.pickDirectory?.();
    if (dir) setGeneral({ workspaceRoot: dir });
  };
  const setFontScale = (label: string) => {
    const f = (Object.keys(FONT_SCALE_LABEL) as FontScale[]).find((k) => FONT_SCALE_LABEL[k] === label);
    if (f) setTweak("fontScale", f);
  };
  return (
    <>
      <div className="pw-dlg-title">通用</div>
      <div className="pw-dlg-desc">管理界面偏好、默认工作目录与桌面行为。</div>

      <SettingCard title="基础设置">
        <SRow label="主题" desc="浅色、深色或跟随系统。">
          <BareSelect value={tweaks.theme} options={THEME_OPTIONS} onChange={(v) => setTweak("theme", v as ThemeMode)} />
        </SRow>
        <SRow label="字号" desc="调整整体界面的文字尺寸。">
          <SegmentedRadio
            value={FONT_SCALE_LABEL[tweaks.fontScale]}
            options={(Object.keys(FONT_SCALE_LABEL) as FontScale[]).map((f) => FONT_SCALE_LABEL[f])}
            onChange={setFontScale}
          />
        </SRow>
        <SRow label="布局密度">
          <SegmentedRadio
            value={tweaks.density}
            options={["compact", "regular", "cozy"]}
            onChange={(v) => setTweak("density", v as Density)}
          />
        </SRow>
        <SRow label="品牌色调">
          <PaletteChips value={tweaks.palette} options={PALETTES} onChange={(v) => setTweak("palette", v as Palette)} />
        </SRow>
        <SRow label="侧栏样式">
          <SegmentedRadio
            value={tweaks.sidebar}
            options={["rich", "minimal", "activity"]}
            onChange={(v) => setTweak("sidebar", v as SidebarMode)}
          />
        </SRow>
        <SRow label="默认工作目录" desc="新建无项目会话 / 定时任务未指定项目时,agent 在此目录运行（留空则用主目录）。">
          <div className="pw-ws-control">
            <input
              className="pw-set-input"
              value={general.workspaceRoot ?? ""}
              placeholder="留空 = 用户主目录"
              spellCheck={false}
              onChange={(e) => setGeneral({ workspaceRoot: e.target.value || undefined })}
            />
            <button className="btn pw-pi-add-btn" onClick={() => void pickWorkspace()}>
              选择…
            </button>
            {general.workspaceRoot ? (
              <button className="btn pw-pi-add-btn" onClick={() => setGeneral({ workspaceRoot: undefined })}>
                清除
              </button>
            ) : null}
          </div>
        </SRow>
      </SettingCard>

      <SettingCard title="桌面行为">
        <SwitchRow
          label="开机自启"
          desc="登录系统后自动启动 Cortex（macOS / Windows）。"
          value={behavior.openAtLogin}
          onChange={(v) => setBehavior({ openAtLogin: v })}
        />
        {behavior.openAtLogin ? (
          <SwitchRow
            label="启动时最小化"
            desc="启动后最小化到后台（主要用于 Windows）。"
            value={behavior.startMinimized}
            onChange={(v) => setBehavior({ startMinimized: v })}
          />
        ) : null}
        <SwitchRow
          label="关闭时隐藏到托盘"
          desc="关闭窗口时隐藏到系统托盘,而非退出应用。"
          value={behavior.closeToTray}
          onChange={(v) => setBehavior({ closeToTray: v })}
        />
        <SRow label="闪记快捷键" desc="全局唤起闪记的快捷键。点击后按下新组合即可录制;被占用时会提示并保留原键。">
          <div className="pw-hotkey-control">
            <HotkeyCapture value={notesHotkey} isMac={isMac} onChange={(acc) => void applyNotesHotkey(acc)} />
            {notesHotkey !== DEFAULT_NOTES_HOTKEY ? (
              <button className="btn pw-pi-add-btn" onClick={() => void applyNotesHotkey(DEFAULT_NOTES_HOTKEY)}>
                恢复默认
              </button>
            ) : null}
          </div>
        </SRow>
      </SettingCard>

      <SettingCard title="通知">
        <SwitchRow
          label="回合完成通知"
          desc="Agent 回合结束且窗口失焦时显示系统通知。"
          value={general.notifications.turnComplete}
          onChange={(v) => setGeneral({ notifications: { ...general.notifications, turnComplete: v } })}
        />
      </SettingCard>

      <SettingCard title="日志">
        <SwitchRow
          label="启用文件日志"
          desc="把主进程日志写入本地文件,便于排查问题。"
          value={general.log.enabled}
          onChange={(v) => {
            setGeneral({ log: { ...general.log, enabled: v } });
            void bridge?.setLogEnabled?.(v);
          }}
        />
        <SRow label="保留天数" desc="超过天数的旧日志启动时自动清理。">
          <BareSelect
            value={String(general.log.retentionDays)}
            options={LOG_RETENTION_OPTIONS}
            onChange={(v) => setGeneral({ log: { ...general.log, retentionDays: Number(v) || 2 } })}
          />
        </SRow>
        <SRow label="日志目录" end>
          <button className="pw-tl-gen" disabled={!bridge?.openLogsDir} onClick={() => void bridge?.openLogsDir?.()}>
            <Icon.Folder size={12} />
            打开日志目录
          </button>
        </SRow>
      </SettingCard>
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

      <SettingCard title="日报生成模型">
        <SRow label="生成方式" desc="集成 Agent 用已装 CLI;自定义模型用 OpenAI 兼容端点。">
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
        </SRow>
        {model.kind === "agent" ? (
          <>
            <SRow label="Agent">
              <BareSelect
                value={model.agent}
                options={INTEGRATED_AGENTS.map((a) => ({ label: AGENT_LABEL[a], value: a }))}
                onChange={(v) => setModel({ kind: "agent", agent: v as AgentKind, model: DEFAULT_MODEL[v as AgentKind] })}
              />
            </SRow>
            <SRow label="模型">
              <BareSelect
                value={model.model ?? DEFAULT_MODEL[model.agent]}
                options={AGENT_MODELS[model.agent]}
                onChange={(v) => setModel({ kind: "agent", agent: model.agent, model: v })}
              />
            </SRow>
          </>
        ) : (
          <>
            <SRow label="Base URL" desc="OpenAI 兼容接口（Ollama / LM Studio / vLLM 均可）。">
              <input
                className="pw-set-input"
                value={model.baseUrl}
                placeholder="http://localhost:11434"
                spellCheck={false}
                onChange={(e) => setModel({ ...model, baseUrl: e.target.value })}
              />
            </SRow>
            <SRow label="模型名">
              <input
                className="pw-set-input"
                value={model.model}
                placeholder="qwen3:14b"
                spellCheck={false}
                onChange={(e) => setModel({ ...model, model: e.target.value })}
              />
            </SRow>
            <SRow label="API Key" desc="可选。">
              <input
                className="pw-set-input"
                type="password"
                value={model.apiKey ?? ""}
                onChange={(e) => setModel({ ...model, apiKey: e.target.value })}
              />
            </SRow>
          </>
        )}
      </SettingCard>
    </>
  );
}

// ── 供应商（Provider）设置 ──────────────────────────────────────────────────

// provider id slug 化:作为 pi provider 名,仅允许字母数字与 - _。
function slugify(s: string): string {
  const out = s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "provider";
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

// 单个模型的内联编辑行（添加/编辑共用）：id + 显示名 + 保存/取消。
// 上下文输入解析："128K" / "1M" / "128000" → token 数；非法 → undefined。
function parseContextInput(s: string): number | undefined {
  const m = s.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([KM]?)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const mult = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  return Math.round(n * mult);
}
// token 数 → 紧凑展示："1M" / "128K" / "512"。
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1_000) return `${+(tokens / 1_000).toFixed(tokens % 1_000 ? 1 : 0)}K`;
  return String(tokens);
}

function ModelEditRow({
  initial,
  onSave,
  onCancel,
}: {
  initial: ProviderModelOption;
  onSave: (m: ProviderModelOption) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial.id);
  const [label, setLabel] = useState(initial.label ?? "");
  const [ctx, setCtx] = useState(initial.contextTokens ? formatContext(initial.contextTokens) : "");
  const [reasoning, setReasoning] = useState(initial.reasoning ?? false);
  const [vision, setVision] = useState(initial.vision ?? false);
  const save = () => {
    const trimmed = id.trim();
    if (!trimmed) return;
    const m: ProviderModelOption = { id: trimmed };
    if (label.trim()) m.label = label.trim();
    const ctxNum = parseContextInput(ctx);
    if (ctxNum) m.contextTokens = ctxNum;
    if (reasoning) m.reasoning = true;
    if (vision) m.vision = true;
    onSave(m);
  };
  return (
    <div className="pw-ml-edit">
      <div className="pw-ml-edit-row">
        <input
          className="pw-set-input"
          value={id}
          placeholder="模型 id（如 deepseek-chat）"
          spellCheck={false}
          autoFocus
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
        <input
          className="pw-set-input"
          value={label}
          placeholder="显示名（可选）"
          spellCheck={false}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
      </div>
      <div className="pw-ml-edit-row">
        <input
          className="pw-set-input pw-ml-ctx"
          value={ctx}
          placeholder="上下文（如 128K / 1M）"
          spellCheck={false}
          onChange={(e) => setCtx(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
        <label className="pw-ml-check">
          <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
          推理
        </label>
        <label className="pw-ml-check">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
          视觉
        </label>
        <span className="pw-ml-edit-spacer" />
        <button className="btn pw-pi-add-btn" disabled={!id.trim()} onClick={save}>
          保存
        </button>
        <button className="pw-ml-cancel" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// kun 风格模型列表：每个模型一张卡（id + 能力徽标 + 编辑/删除）,顶部「从 API 拉取」,底部「添加模型」。
function ProviderModels({
  models,
  onChange,
  bridge,
  baseUrl,
  apiKey,
  endpointFormat,
}: {
  models: ProviderModelOption[];
  onChange: (models: ProviderModelOption[]) => void;
  bridge: DesktopBridge | null;
  baseUrl: string;
  apiKey?: string;
  endpointFormat: EndpointFormat;
}) {
  // editIdx：正在编辑的下标;models.length 表示新增;null 表示无编辑。
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  useEffect(() => {
    setProbe({ kind: "idle" });
  }, [baseUrl, apiKey, endpointFormat]);

  const canProbe = !!bridge?.probeProvider && endpointFormat !== "custom" && !!baseUrl.trim();

  const runProbe = async () => {
    if (!bridge?.probeProvider || probe.kind === "testing") return;
    setProbe({ kind: "testing" });
    try {
      const res = await bridge.probeProvider({ baseUrl, apiKey, endpointFormat });
      setProbe(res.ok ? { kind: "ok", models: res.models ?? [] } : { kind: "err", error: res.error ?? "连接失败" });
    } catch (e) {
      setProbe({ kind: "err", error: e instanceof Error ? e.message : String(e) });
    }
  };
  // 拉取应用：保留已有显示名,按拉取结果重排（新 id 无显示名）。
  const applyFetched = (ids: string[]) => {
    const existing = new Map(models.map((m) => [m.id, m]));
    onChange(ids.map((id) => existing.get(id) ?? { id }));
    setProbe({ kind: "idle" });
  };

  const saveModel = (m: ProviderModelOption) => {
    const next = [...models];
    if (editIdx === models.length) next.push(m);
    else if (editIdx !== null) next[editIdx] = m;
    onChange(next);
    setEditIdx(null);
  };
  const removeModel = (i: number) => {
    onChange(models.filter((_, j) => j !== i));
    if (editIdx === i) setEditIdx(null);
  };

  return (
    <div className="pw-ml">
      <div className="pw-ml-head">
        <span className="pw-ml-title">模型列表 · {models.length}</span>
        <button
          className="pw-tl-gen"
          disabled={!canProbe || probe.kind === "testing"}
          onClick={() => void runProbe()}
          title={endpointFormat === "custom" ? "自定义端点不支持探测,请手动添加" : undefined}
        >
          <Icon.Retry size={12} />
          {probe.kind === "testing" ? "拉取中…" : "从 API 拉取"}
        </button>
      </div>
      <div className="pw-set-hint">供应商发布新模型后可在这里手动添加或从 API 拉取。</div>

      {probe.kind === "ok" ? (
        <div className="pw-ml-probe pw-ml-probe-ok">
          拉取到 {probe.models.length} 个模型
          {probe.models.length > 0 ? (
            <button className="pw-prov-probe-apply" onClick={() => applyFetched(probe.models)}>
              应用
            </button>
          ) : null}
        </div>
      ) : null}
      {probe.kind === "err" ? <div className="pw-ml-probe pw-ml-probe-err">{probe.error}</div> : null}

      {models.length === 0 && editIdx === null ? (
        <div className="pw-set-hint">还没有模型。点「添加模型」或「从 API 拉取」。</div>
      ) : null}

      {models.map((m, i) =>
        editIdx === i ? (
          <ModelEditRow key={i} initial={m} onSave={saveModel} onCancel={() => setEditIdx(null)} />
        ) : (
          <div key={i} className="pw-ml-card">
            <div className="pw-ml-card-main">
              <span className="pw-ml-id">{m.id}</span>
              <span className="pw-ml-badges">
                <span className="pw-ml-badge">文本对话</span>
                {m.contextTokens ? <span className="pw-ml-badge">{formatContext(m.contextTokens)} 上下文</span> : null}
                {m.reasoning ? <span className="pw-ml-badge">推理</span> : null}
                {m.vision ? <span className="pw-ml-badge">视觉</span> : null}
                {m.label && m.label !== m.id ? <span className="pw-ml-badge is-name">{m.label}</span> : null}
              </span>
            </div>
            <div className="pw-ml-actions">
              <button title="编辑" onClick={() => setEditIdx(i)}>
                <Icon.Edit size={14} />
              </button>
              <button title="删除" onClick={() => removeModel(i)}>
                <Icon.Trash size={14} />
              </button>
            </div>
          </div>
        ),
      )}

      {editIdx === models.length ? (
        <ModelEditRow initial={{ id: "" }} onSave={saveModel} onCancel={() => setEditIdx(null)} />
      ) : (
        <button className="pw-ml-add" onClick={() => setEditIdx(models.length)}>
          <Icon.Plus size={13} />
          添加模型
        </button>
      )}
    </div>
  );
}

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
      <ProviderModels
        models={provider.models}
        onChange={(models) => onPatch({ models })}
        bridge={bridge}
        baseUrl={provider.baseUrl}
        apiKey={provider.apiKey}
        endpointFormat={provider.endpointFormat}
      />
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
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);

  return (
    <>
      <div className="pw-dlg-title">Agent</div>
      <div className="pw-dlg-desc">
        Cortex 支持 Claude Code、Codex、内置 Pi 三种 Agent。Claude / Codex 用各自 CLI 自带鉴权;Pi 在未装 CLI
        时兜底,使用「供应商」中配置的 LLM 端点。Pi 的专属设置见「Pi」分区。
      </div>

      <SettingCard title="可用性">
        {INTEGRATED_AGENTS.map((a) => {
          const on = a === "pi" || !!agentsAvailable?.[a];
          return (
            <SRow key={a} label={AGENT_LABEL[a]} end>
              <span className={`pw-agent-status ${on ? "is-on" : "is-off"}`}>
                {a === "pi" ? "内置" : agentsAvailable?.[a] ? "已安装" : "未检测到 CLI"}
              </span>
            </SRow>
          );
        })}
      </SettingCard>
    </>
  );
}

// 「Pi」设置分区:聚合 pi 专属设置(默认供应商/模型、工具审批、高级定制),并承载后续新增的
// 会话级能力。卡片锚点顺序:默认供应商 → Thinking → System Prompt → 工具审批 → 高级定制 →
// 供应商高级说明(后续阶段按此顺序插入,减少改动冲突)。
function PiSection() {
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const setProviderDefaults = usePersonalStore((s) => s.setProviderDefaults);
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const enabledProviders = providerSettings.providers.filter((p) => p.enabled);
  // defaultProviderId 可能指向已删除/已停用的 provider → 下拉回退「（未设置）」。
  const defaultProvider = enabledProviders.find((p) => p.id === providerSettings.defaultProviderId);
  const defaultValue = defaultProvider ? defaultProvider.id : "";

  return (
    <>
      <div className="pw-dlg-title">Pi</div>
      <div className="pw-dlg-desc">
        Pi 是内置 Agent,以长驻会话运行。下列设置在新建会话或下次发送时生效;其中工具审批等
        extension 类设置改动会重启当前 pi 会话(丢失内存上下文,自动从磁盘历史恢复)。
      </div>

      <SettingCard title="默认供应商">
        {enabledProviders.length === 0 ? (
          <div className="pw-scard-empty">还没有启用的供应商。先在「供应商」设置中添加并启用,再回此处选默认。</div>
        ) : (
          <>
            <SRow label="默认供应商" desc="新建 Pi 会话默认使用的供应商。">
              <BareSelect
                value={defaultValue}
                options={[
                  { label: "（未设置）", value: "" },
                  ...enabledProviders.map((p) => ({ label: p.name || p.id, value: p.id })),
                ]}
                onChange={(v) => setProviderDefaults({ defaultProviderId: v || undefined, defaultModel: undefined })}
              />
            </SRow>
            <SRow label="默认模型">
              <BareSelect
                value={providerSettings.defaultModel ?? ""}
                options={[
                  { label: "（供应商首个模型）", value: "" },
                  ...(defaultProvider?.models ?? []).map((m) => ({ label: m.label ?? m.id, value: m.id })),
                ]}
                onChange={(v) => setProviderDefaults({ defaultModel: v || undefined })}
              />
            </SRow>
          </>
        )}
      </SettingCard>

      <SettingCard title="思考强度">
        <SRow label="默认思考强度" desc="新建 Pi 会话的默认思考强度;单会话可在输入框旁单独切换,即时生效不重启。">
          <BareSelect
            value={general.piThinkingDefault ?? "off"}
            options={PI_THINKING_LEVELS.map((lv) => ({ label: PI_THINKING_LABELS[lv], value: lv }))}
            onChange={(v) => setGeneral({ piThinkingDefault: v as ThinkingLevel })}
          />
        </SRow>
      </SettingCard>

      <SettingCard title="System Prompt">
        <SBlock label="持久系统提示词" desc="追加到 pi 系统提示词尾部,定制人设/规则。改动在下次发送时生效(会重启当前 pi 会话)。">
          <textarea
            className="pw-ta"
            rows={6}
            maxLength={4000}
            placeholder="例如:你是资深 TypeScript 工程师,回答简洁、优先给可运行代码。"
            value={general.piSystemPrompt ?? ""}
            spellCheck={false}
            onChange={(e) => setGeneral({ piSystemPrompt: e.target.value || undefined })}
          />
          <div className="pw-ta-count">{(general.piSystemPrompt ?? "").length}/4000</div>
        </SBlock>
      </SettingCard>

      <SettingCard title="工具审批">
        <SwitchRow
          label="工具执行审批"
          desc="pi 调用高风险工具前弹窗确认,拒绝则阻断。改动在下次发送消息时生效(会重启当前 pi 会话,丢失其内存上下文)。"
          value={general.piCustomization?.toolApproval ?? false}
          onChange={(v) => setGeneral({ piCustomization: { sampleTools: false, sampleCommands: false, approvalTools: DEFAULT_PI_APPROVAL_TOOLS, ...general.piCustomization, toolApproval: v } })}
        />
        {general.piCustomization?.toolApproval ? (
          <SBlock label="需审批的工具" desc="仅勾选的工具会触发确认弹窗;全部取消勾选 = 不审批任何工具(等同关闭)。">
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px" }}>
              {PI_APPROVAL_TOOL_OPTIONS.map((tool) => {
                const selected = general.piCustomization?.approvalTools ?? DEFAULT_PI_APPROVAL_TOOLS;
                const checked = selected.includes(tool);
                return (
                  <label key={tool} className="pw-ml-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked ? [...selected, tool] : selected.filter((t) => t !== tool);
                        setGeneral({
                          piCustomization: {
                            sampleTools: false,
                            sampleCommands: false,
                            ...general.piCustomization,
                            toolApproval: true,
                            approvalTools: next,
                          },
                        });
                      }}
                    />
                    {tool}
                  </label>
                );
              })}
            </div>
          </SBlock>
        ) : null}
      </SettingCard>

      <SettingCard title="高级定制">
        <SwitchRow
          label="自定义工具样例"
          desc="加载示例工具 echo_upper（把文本转大写）,演示 pi 自定义工具能力。改动下次发送时生效(重启会话)。"
          value={general.piCustomization?.sampleTools ?? false}
          onChange={(v) => setGeneral({ piCustomization: { toolApproval: false, sampleCommands: false, ...general.piCustomization, sampleTools: v } })}
        />
        <SwitchRow
          label="自定义斜杠命令样例"
          desc="加载示例命令 /greet,演示 pi 自定义斜杠命令能力。改动下次发送时生效(重启会话)。"
          value={general.piCustomization?.sampleCommands ?? false}
          onChange={(v) => setGeneral({ piCustomization: { toolApproval: false, sampleTools: false, ...general.piCustomization, sampleCommands: v } })}
        />
      </SettingCard>
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

      <SettingCard title="推送格式 Skill">
        <div className="pw-scard-empty">
          用 Prompt 库中的 .md 模板固化推送格式,渲染后第一行作为推送标题。可用占位符:
          {" {{project}}、{{date}}、{{stats}}、{{summary}}、{{runs}}、{{files}}、{{commits}}"}
          ;数据为空的占位符行会自动隐藏。
        </div>
        <SRow label="格式模板">
          <BareSelect
            value={push.formatSkillPath ?? ""}
            options={skillOptions}
            onChange={(v) => setPush({ formatSkillPath: v || undefined })}
          />
        </SRow>
        <SRow label="示例 Skill" desc={!promptRoot ? "需先在右栏 Prompt 库选择目录。" : undefined} end>
          <button className="pw-tl-gen" disabled={!bridge || !promptRoot} onClick={() => void createExampleSkill()}>
            <Icon.Plus size={12} />
            在 Prompt 库创建示例
          </button>
        </SRow>
      </SettingCard>

      <SettingCard title="渠道">
        <SwitchRow label="企业微信机器人" value={!!wecom?.enabled} onChange={(v) => setWecom({ enabled: v })} />
        {wecom?.enabled ? (
          <SRow label="Webhook 地址">
            <input
              className="pw-set-input"
              value={wecom.webhookUrl}
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
              spellCheck={false}
              onChange={(e) => setWecom({ webhookUrl: e.target.value })}
            />
          </SRow>
        ) : null}

        <SwitchRow label="钉钉机器人" value={!!dingtalk?.enabled} onChange={(v) => setDingtalk({ enabled: v })} />
        {dingtalk?.enabled ? (
          <>
            <SRow label="Webhook 地址">
              <input
                className="pw-set-input"
                value={dingtalk.webhookUrl}
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
                spellCheck={false}
                onChange={(e) => setDingtalk({ webhookUrl: e.target.value })}
              />
            </SRow>
            <SRow label="加签密钥" desc="可选,安全设置为「加签」时填写。">
              <input
                className="pw-set-input"
                type="password"
                value={dingtalk.secret ?? ""}
                placeholder="SEC…"
                onChange={(e) => setDingtalk({ secret: e.target.value })}
              />
            </SRow>
          </>
        ) : null}

        <SwitchRow label="邮件（SMTP）" value={!!email?.enabled} onChange={(v) => setEmail({ enabled: v })} />
        {email?.enabled ? (
          <>
            <SRow label="SMTP 服务器">
              <input
                className="pw-set-input"
                value={email.smtpHost}
                placeholder="smtp.qq.com"
                spellCheck={false}
                onChange={(e) => setEmail({ smtpHost: e.target.value })}
              />
            </SRow>
            <SRow label="端口">
              <input
                className="pw-set-input"
                value={String(email.smtpPort || "")}
                placeholder="465"
                onChange={(e) => setEmail({ smtpPort: Number(e.target.value) || 0 })}
              />
            </SRow>
            <SwitchRow
              label="SSL"
              desc="465 端口开启,587 关闭。"
              value={email.secure}
              onChange={(v) => setEmail({ secure: v })}
            />
            <SRow label="账号">
              <input className="pw-set-input" value={email.user} spellCheck={false} onChange={(e) => setEmail({ user: e.target.value })} />
            </SRow>
            <SRow label="密码 / 授权码">
              <input className="pw-set-input" type="password" value={email.pass} onChange={(e) => setEmail({ pass: e.target.value })} />
            </SRow>
            <SRow label="发件人">
              <input
                className="pw-set-input"
                value={email.from}
                placeholder="留空使用账号"
                spellCheck={false}
                onChange={(e) => setEmail({ from: e.target.value })}
              />
            </SRow>
            <SRow label="收件人">
              <input
                className="pw-set-input"
                value={email.to}
                placeholder="多个用逗号分隔"
                spellCheck={false}
                onChange={(e) => setEmail({ to: e.target.value })}
              />
            </SRow>
          </>
        ) : null}
      </SettingCard>
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

      <SettingCard title="朗读">
        <SwitchRow
          label="自动朗读 Agent 回复"
          desc="每轮回复完成时朗读（代码块自动略过,新回复打断上一条）。"
          value={tts.autoSpeak}
          onChange={(v) => setTts({ autoSpeak: v })}
        />
        <SRow label="语音引擎">
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
        </SRow>
        {engine.kind === "system" ? (
          <>
            <SRow label="音色" desc="使用本机系统语音库,无需联网与配置。">
              <BareSelect
                value={engine.voice ?? ""}
                options={voiceOptions}
                onChange={(v) => setEngine({ ...engine, voice: v || undefined })}
              />
            </SRow>
            <SRow label="语速">
              <BareSelect
                value={String(engine.rate ?? 1)}
                options={SPEECH_RATES}
                onChange={(v) => setEngine({ ...engine, rate: Number(v) })}
              />
            </SRow>
          </>
        ) : (
          <>
            <SRow label="Base URL" desc="OpenAI 兼容 /v1/audio/speech（OpenAI TTS / LocalAI / Kokoro 等本地部署均可）。">
              <input
                className="pw-set-input"
                value={engine.baseUrl}
                placeholder="http://localhost:8880"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, baseUrl: e.target.value })}
              />
            </SRow>
            <SRow label="模型名">
              <input
                className="pw-set-input"
                value={engine.model}
                placeholder="tts-1"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, model: e.target.value })}
              />
            </SRow>
            <SRow
              label="音色"
              desc={loadingVoices ? "加载中…" : customVoices.length > 0 ? "模型返回" : "常用音色"}
            >
              <BareSelect value={engine.voice} options={customVoiceOptions} onChange={(v) => setEngine({ ...engine, voice: v })} />
            </SRow>
            <SRow label="自定义 voice">
              <input
                className="pw-set-input"
                value={engine.voice}
                placeholder="alloy"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, voice: e.target.value })}
              />
            </SRow>
            <SRow label="API Key" desc="可选。">
              <input
                className="pw-set-input"
                type="password"
                value={engine.apiKey ?? ""}
                onChange={(e) => setEngine({ ...engine, apiKey: e.target.value })}
              />
            </SRow>
            <SRow label="语言">
              <BareSelect value={engine.language ?? "zh"} options={TTS_LANGUAGES} onChange={(v) => setEngine({ ...engine, language: v })} />
            </SRow>
            <SRow label="自定义 language">
              <input
                className="pw-set-input"
                value={engine.language ?? "zh"}
                placeholder="zh"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, language: e.target.value || undefined })}
              />
            </SRow>
            <SRow label="语速">
              <BareSelect
                value={String(engine.speed ?? 1)}
                options={SPEECH_RATES}
                onChange={(v) => setEngine({ ...engine, speed: Number(v) })}
              />
            </SRow>
          </>
        )}
        <SRow label="试听" end>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="pw-tl-gen" disabled={testing} onClick={() => void test()}>
              <Icon.Mic size={12} />
              {testing ? "播放中…" : "试听"}
            </button>
            <button className="pw-tl-gen" onClick={() => stopSpeaking()}>
              <Icon.Stop size={12} />
              停止
            </button>
          </span>
        </SRow>
      </SettingCard>
    </>
  );
}

// ESC 守卫：录制态（HotkeyCapture 的 .is-recording 按钮）或可编辑控件聚焦时,ESC 有其
// 局部语义（取消录制 / 不丢输入）,不应连带关闭整页设置——故这些焦点下 ESC 不触发返回。
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.classList.contains("is-recording")) return true;
  return false;
}

export function PersonalSettingsView() {
  const closeSettings = usePersonalStore((s) => s.closeSettings);
  const [tab, setTab] = useState<SettingsTab>("profile");
  const backRef = useRef<HTMLButtonElement>(null);

  // 挂载时把焦点移入覆盖层（返回按钮）,避免键盘焦点停在被遮挡但仍在 DOM 的底层控件上。
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  // ESC 返回;录制/输入态豁免（见 isTypingTarget）。监听 window:HotkeyCapture 的合成事件
  // stopPropagation 拦不住原生 window 监听,故只能靠 activeElement 守卫避免误关。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isTypingTarget(document.activeElement)) return;
      closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSettings]);

  return (
    <div className="pw-settings-page" role="dialog" aria-modal="true" aria-label="设置">
      <nav className="pw-dlg-nav" aria-label="设置菜单">
        <button ref={backRef} className="pw-settings-back" onClick={closeSettings}>
          <Icon.Back size={15} />
          返回应用
        </button>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`pw-dlg-nav-item ${tab === t.id ? "is-active" : ""}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
      <div className="pw-dlg-body">
        <div className="pw-settings-content">
          {tab === "profile" ? (
            <ProfileSection />
          ) : tab === "general" ? (
            <GeneralSection />
          ) : tab === "providers" ? (
            <ProvidersSection />
          ) : tab === "agent" ? (
            <AgentSection />
          ) : tab === "pi" ? (
            <PiSection />
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
  const openSettings = usePersonalStore((s) => s.openSettings);
  return (
    <div className="sb-foot">
      <button className="sb-row is-mute" onClick={openSettings}>
        <Icon.Settings size={15} />
        <span className="label">设置</span>
      </button>
    </div>
  );
}
