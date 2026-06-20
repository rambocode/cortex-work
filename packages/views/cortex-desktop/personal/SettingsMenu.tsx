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
  DEFAULT_PUSH_TEMPLATE,
  PROVIDER_PRESETS,
  providerFromPreset,
  resolveDefaultAgent,
  speakText,
  stopSpeaking,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalProfile,
  usePersonalStore,
  usePetStore,
  useUpdateState,
  type PetKind,
  type PetMode,
} from "@cortex-work/core";
import { UpdateDialog } from "../UpdateDialog";
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
  UpdateState,
  WecomPushConfig,
} from "@cortex-work/core";
import type { Density, FontScale, Palette, SidebarMode, ThemeMode } from "@cortex-work/core/types";
import { useTranslation, type Locale } from "@cortex-work/core/i18n";
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
import { PluginManager } from "./PluginManager";

const PALETTES: PaletteOption[] = [
  { id: "clay", name: "Clay", colors: ["#c96442", "#f3e7df", "#1a1916"] },
  { id: "twilight", name: "Twilight", colors: ["#7c3aed", "#ede5fd", "#1a1916"] },
  { id: "forest", name: "Forest", colors: ["#0d9488", "#d4ebe8", "#1a1916"] },
  { id: "ink", name: "Ink", colors: ["#1a1916", "#e6e4dd", "#5e5c56"] },
];

const PET_KINDS = Object.keys(PET_DESIGNS) as PetKind[];

// 译函数最小签名（与 TimelineView 一致,避免引入 react-i18next 的 TFunction 泛型）。
type TFunction = (key: string, opts?: Record<string, unknown>) => string;

type SettingsTab = "profile" | "general" | "providers" | "agent" | "pi" | "plugins" | "pet" | "timeline" | "push" | "voice";

// label 走 i18n（settings:tabs.*）,故此处只存 tabKey,渲染时即时翻译。
const TABS: { id: SettingsTab; tabKey: string; icon: React.ReactNode }[] = [
  { id: "profile", tabKey: "tabs.profile", icon: <Icon.Users size={14} /> },
  { id: "general", tabKey: "tabs.general", icon: <Icon.Settings size={14} /> },
  { id: "providers", tabKey: "tabs.providers", icon: <Icon.Globe size={14} /> },
  { id: "agent", tabKey: "tabs.agent", icon: <Icon.Terminal size={14} /> },
  { id: "pi", tabKey: "tabs.pi", icon: <Icon.Bot size={14} /> },
  { id: "plugins", tabKey: "tabs.plugins", icon: <Icon.Workflow size={14} /> },
  { id: "pet", tabKey: "tabs.pet", icon: <Icon.Sparkle size={14} /> },
  { id: "timeline", tabKey: "tabs.timeline", icon: <Icon.Clock size={14} /> },
  { id: "push", tabKey: "tabs.push", icon: <Icon.Send size={14} /> },
  { id: "voice", tabKey: "tabs.voice", icon: <Icon.Mic size={14} /> },
];

// 颜色预设(主色;深/浅两档由 petColorVars 自动派生)。
const PET_COLOR_PRESETS = ["#ecb98a", "#e8a3b2", "#a3c4e8", "#9fc7a8", "#c9b6e8", "#9a958a"];

// 行为模式 ↔ 设置页展示文案 key(SegmentedRadio 以展示值为选项,即时翻译)。
const PET_MODES: PetMode[] = ["free", "perch"];
const PET_MODE_KEY: Record<PetMode, string> = { free: "pet.modeFree", perch: "pet.modePerch" };

// 个人资料:昵称 + 内置头像（写入 personal store 的 profile 切片,随工作区落盘;
// 会话中 who="me" 的气泡据此渲染,见 ChatArea MessageAvatar/MessageHeader）。
function ProfileSection() {
  const { t } = useTranslation("settings");
  const profile = usePersonalProfile();
  const setProfile = usePersonalStore((s) => s.setProfile);
  const nickname = profile.nickname ?? "";
  return (
    <>
      <div className="pw-dlg-title">{t("profile.title")}</div>
      <div className="pw-dlg-desc">{t("profile.desc")}</div>

      <SettingCard title={t("profile.cardTitle")}>
        <SRow label={t("profile.nickname")} desc={t("profile.nicknameDesc")}>
          <input
            className="pw-set-input"
            value={nickname}
            placeholder={t("profile.nicknamePlaceholder")}
            spellCheck={false}
            onChange={(e) => setProfile({ nickname: e.target.value })}
          />
        </SRow>
        <SBlock label={t("profile.avatar")}>
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
  const { t } = useTranslation("settings");
  const { t: tPet } = useTranslation("pet");
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
    const m = PET_MODES.find((k) => t(PET_MODE_KEY[k]) === label);
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
      <div className="pw-dlg-title">{t("pet.title")}</div>
      <div className="pw-dlg-desc">{t("pet.desc")}</div>

      <SettingCard title={t("pet.cardTitle")}>
        <SwitchRow label={t("pet.showPet")} value={petEnabled} onChange={pickEnabled} />
        <SRow label={t("pet.behavior")} desc={t("pet.behaviorDesc")}>
          <SegmentedRadio
            value={t(PET_MODE_KEY[petMode])}
            options={PET_MODES.map((m) => t(PET_MODE_KEY[m]))}
            onChange={pickMode}
          />
        </SRow>
        {petMode === "free" ? (
          <SwitchRow
            label={t("pet.walk")}
            desc={t("pet.walkDesc")}
            value={petWalk}
            onChange={pickWalk}
          />
        ) : null}
      </SettingCard>

      <SettingCard title={t("pet.appearanceCard")}>
        <SBlock label={t("pet.design")}>
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
                  <span className="pw-pet-name">{tPet(`kind.${k}.name`)}</span>
                  <span className="pw-pet-desc">{tPet(`kind.${k}.desc`)}</span>
                </button>
              );
            })}
          </div>
        </SBlock>
        <SRow label={t("pet.size")}>
          <div className="pw-pet-size">
            <input
              type="range"
              min={PET_SIZE_MIN}
              max={PET_SIZE_MAX}
              step={0.05}
              value={petSize}
              onChange={(e) => pickSize(Number(e.target.value))}
              aria-label={t("pet.sizeAria")}
            />
            <span className="pw-pet-size-val">{Math.round(petSize * 100)}%</span>
            {petSize !== 1 ? (
              <button className="pw-pet-reset" onClick={() => pickSize(1)}>
                {t("pet.reset")}
              </button>
            ) : null}
          </div>
        </SRow>
        <SBlock label={t("pet.color")} desc={t("pet.colorDesc")}>
          <div className="pw-pet-colors">
            <button
              className={`pw-pet-color-chip is-default ${petColor ? "" : "is-active"}`}
              title={t("pet.colorDefaultTitle")}
              onClick={() => pickColor(null)}
            >
              {t("pet.colorDefault")}
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
            <label className="pw-pet-color-chip is-custom" title={t("pet.colorCustomTitle")}>
              <input type="color" value={petColor ?? "#ecb98a"} onChange={(e) => pickColor(e.target.value)} />
              <Icon.Plus size={12} />
            </label>
          </div>
        </SBlock>
      </SettingCard>
    </>
  );
}

// label 走 i18n（settings:general.theme*）,故 value→themeKey 映射,渲染时翻译。
const THEME_OPTIONS: { themeKey: string; value: ThemeMode }[] = [
  { themeKey: "general.themeSystem", value: "system" },
  { themeKey: "general.themeLight", value: "light" },
  { themeKey: "general.themeDark", value: "dark" },
];
const FONT_SCALE_KEY: Record<FontScale, string> = {
  small: "general.fontSmall",
  medium: "general.fontMedium",
  large: "general.fontLarge",
};
const LOG_RETENTION_DAYS = [1, 2, 3, 5, 7];

function updateStatusText(state: UpdateState, t: TFunction): string {
  switch (state.phase) {
    case "checking":
      return t("updateStatus.checking");
    case "available":
      return t("updateStatus.available", { version: state.version ?? "" }).trim();
    case "downloading":
      return t("updateStatus.downloading", {
        percent: Math.max(0, Math.min(100, Math.round(state.percent ?? 0))),
      });
    case "downloaded":
      return t("updateStatus.downloaded", { version: state.version ?? "" }).trim();
    case "error":
      return state.version ? t("updateStatus.errorDownload") : t("updateStatus.errorCheck");
    default:
      return t("updateStatus.idle");
  }
}

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
  // tc: common 命名空间(语言切换器复用 common.language.*,U3);t: settings 命名空间(本区其余文案)。
  const { t: tc } = useTranslation();
  const { t } = useTranslation("settings");
  const tweaks = useCortexUIStore((s) => s.tweaks);
  const setTweak = useCortexUIStore((s) => s.setTweak);
  const general = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  const bridge = useDesktopBridge();
  const pushToast = useCortexUIStore((s) => s.pushToast);
  // 更新状态走共享 useUpdateState（主进程为 owner,广播驱动）,与标题栏 UpdateButton 同源。
  const updateState = useUpdateState();
  // 「检查更新」点击到 main 广播 checking 之间的即时反馈（dev 未打包不会广播,亦靠此显示）。
  const [checking, setChecking] = useState(false);
  // 更新内容弹窗开关:点「查看更新内容」打开,复用标题栏同款 UpdateDialog。
  const [showNotes, setShowNotes] = useState(false);
  const isMac = useMemo(() => detectIsMac(), []);
  const notesHotkey = general.notesHotkey ?? DEFAULT_NOTES_HOTKEY;
  const behavior = general.desktopBehavior;
  const setBehavior = (patch: Partial<typeof behavior>) => {
    const next = { ...behavior, ...patch };
    setGeneral({ desktopBehavior: next });
    void bridge?.setDesktopBehavior?.(next);
  };
  const checkUpdate = async () => {
    if (!bridge?.updateCheck) return;
    setChecking(true);
    try {
      // 结果经 main 广播驱动 useUpdateState;此处不本地写状态,避免双数据源。
      await bridge.updateCheck();
    } catch (e) {
      pushToast(`检查更新失败：${e instanceof Error ? e.message : String(e)}`, { kind: "error" });
    } finally {
      setChecking(false);
    }
  };
  const isChecking = checking || updateState.phase === "checking";
  // 闪记热键双写:乐观持久化 + 即时通知主进程重注册;被拒(占用/无效)时回滚到旧键,
  // 保证「UI 显示 = 主进程实际绑定」,避免重启再降级。web 端 / 旧壳无桥则仅乐观持久化。
  const applyNotesHotkey = async (acc: string) => {
    const oldAcc = notesHotkey; // 当前实际生效键(已含默认兜底)。
    setGeneral({ notesHotkey: acc }); // 乐观持久化:控件随 notesHotkey 立即显示新键。
    const r = await bridge?.setNotesHotkey?.(acc); // 即时重注册。
    if (!r) return; // r === undefined:web 端 / 旧壳无此能力,保留乐观持久化,不反馈。
    if (r.ok) {
      pushToast(t("general.notesHotkeyUpdated", { accelerator: formatAccelerator(acc, isMac) }), { kind: "success" });
    } else {
      // 被拒(占用/无效/三级兜底落空):回滚显示与持久化到旧键,保持显示=实际。
      setGeneral({ notesHotkey: oldAcc });
      pushToast(r.toast ?? t("general.notesHotkeyFailed"), { kind: "error" });
    }
  };
  const pickWorkspace = async () => {
    const dir = await bridge?.pickDirectory?.();
    if (dir) setGeneral({ workspaceRoot: dir });
  };
  const fontScales = Object.keys(FONT_SCALE_KEY) as FontScale[];
  const setFontScale = (label: string) => {
    const f = fontScales.find((k) => t(FONT_SCALE_KEY[k]) === label);
    if (f) setTweak("fontScale", f);
  };
  return (
    <>
      <div className="pw-dlg-title">{t("general.title")}</div>
      <div className="pw-dlg-desc">{t("general.desc")}</div>

      <SettingCard title={t("general.baseCard")}>
        <SRow label={tc("language.label")} desc={tc("language.desc")}>
          <SegmentedRadio
            value={tweaks.language === "en" ? tc("language.en") : tc("language.zh-Hans")}
            options={[tc("language.zh-Hans"), tc("language.en")]}
            onChange={(v) => setTweak("language", (v === tc("language.en") ? "en" : "zh-Hans") satisfies Locale)}
          />
        </SRow>
        <SRow label={t("general.theme")} desc={t("general.themeDesc")}>
          <BareSelect
            value={tweaks.theme}
            options={THEME_OPTIONS.map((o) => ({ label: t(o.themeKey), value: o.value }))}
            onChange={(v) => setTweak("theme", v as ThemeMode)}
          />
        </SRow>
        <SRow label={t("general.fontSize")} desc={t("general.fontSizeDesc")}>
          <SegmentedRadio
            value={t(FONT_SCALE_KEY[tweaks.fontScale])}
            options={fontScales.map((f) => t(FONT_SCALE_KEY[f]))}
            onChange={setFontScale}
          />
        </SRow>
        <SRow label={t("general.density")}>
          <SegmentedRadio
            value={tweaks.density}
            options={["compact", "regular", "cozy"]}
            onChange={(v) => setTweak("density", v as Density)}
          />
        </SRow>
        <SRow label={t("general.palette")}>
          <PaletteChips value={tweaks.palette} options={PALETTES} onChange={(v) => setTweak("palette", v as Palette)} />
        </SRow>
        <SRow label={t("general.sidebar")}>
          <SegmentedRadio
            value={tweaks.sidebar}
            options={["rich", "minimal", "activity"]}
            onChange={(v) => setTweak("sidebar", v as SidebarMode)}
          />
        </SRow>
        <SRow label={t("general.workspaceRoot")} desc={t("general.workspaceRootDesc")}>
          <div className="pw-ws-control">
            <input
              className="pw-set-input"
              value={general.workspaceRoot ?? ""}
              placeholder={t("general.workspaceRootPlaceholder")}
              spellCheck={false}
              onChange={(e) => setGeneral({ workspaceRoot: e.target.value || undefined })}
            />
            <button className="btn pw-pi-add-btn" onClick={() => void pickWorkspace()}>
              {t("general.choose")}
            </button>
            {general.workspaceRoot ? (
              <button className="btn pw-pi-add-btn" onClick={() => setGeneral({ workspaceRoot: undefined })}>
                {t("general.clear")}
              </button>
            ) : null}
          </div>
        </SRow>
      </SettingCard>

      <SettingCard title={t("general.globalInstructionCard")}>
        <SBlock label={t("general.globalInstruction")} desc={t("general.globalInstructionDesc")}>
          <textarea
            className="pw-ta"
            rows={6}
            maxLength={4000}
            placeholder={t("general.globalInstructionPlaceholder")}
            value={general.globalInstruction ?? ""}
            spellCheck={false}
            onChange={(e) => setGeneral({ globalInstruction: e.target.value || undefined })}
          />
          <div className="pw-ta-count">{(general.globalInstruction ?? "").length}/4000</div>
        </SBlock>
      </SettingCard>

      <SettingCard title={t("general.behaviorCard")}>
        <SwitchRow
          label={t("general.openAtLogin")}
          desc={t("general.openAtLoginDesc")}
          value={behavior.openAtLogin}
          onChange={(v) => setBehavior({ openAtLogin: v })}
        />
        {behavior.openAtLogin ? (
          <SwitchRow
            label={t("general.startMinimized")}
            desc={t("general.startMinimizedDesc")}
            value={behavior.startMinimized}
            onChange={(v) => setBehavior({ startMinimized: v })}
          />
        ) : null}
        <SwitchRow
          label={t("general.closeToTray")}
          desc={t("general.closeToTrayDesc")}
          value={behavior.closeToTray}
          onChange={(v) => setBehavior({ closeToTray: v })}
        />
        <SRow label={t("general.notesHotkey")} desc={t("general.notesHotkeyDesc")}>
          <div className="pw-hotkey-control">
            <HotkeyCapture value={notesHotkey} isMac={isMac} onChange={(acc) => void applyNotesHotkey(acc)} />
            {notesHotkey !== DEFAULT_NOTES_HOTKEY ? (
              <button className="btn pw-pi-add-btn" onClick={() => void applyNotesHotkey(DEFAULT_NOTES_HOTKEY)}>
                {t("general.restoreDefault")}
              </button>
            ) : null}
          </div>
        </SRow>
      </SettingCard>

      <SettingCard title={t("general.notificationsCard")}>
        <SwitchRow
          label={t("general.turnComplete")}
          desc={t("general.turnCompleteDesc")}
          value={general.notifications.turnComplete}
          onChange={(v) => setGeneral({ notifications: { ...general.notifications, turnComplete: v } })}
        />
      </SettingCard>

      <SettingCard title={t("general.updateCard")}>
        <SRow label={t("general.currentVersion")} desc={t("general.currentVersionDesc")}>
          <div className="pw-update-control">
            <span className="pw-update-version">v{bridge?.appInfo?.version ?? "0.0.0"}</span>
            <button
              className="pw-tl-gen"
              disabled={!bridge?.updateCheck || isChecking}
              onClick={() => void checkUpdate()}
            >
              <Icon.Retry size={12} />
              {isChecking ? t("general.checking") : t("general.checkUpdate")}
            </button>
          </div>
        </SRow>
        <SRow label={t("general.updateStatus")} desc={updateState.phase === "error" ? updateState.error : undefined}>
          <div className={`pw-update-status is-${updateState.phase}`}>{updateStatusText(updateState, t)}</div>
        </SRow>
        {updateState.phase === "available" || (updateState.phase === "error" && updateState.version) ? (
          <SRow label={t("general.action")} end>
            <div className="pw-update-control">
              <button className="pw-tl-gen" onClick={() => setShowNotes(true)}>
                {t("general.viewReleaseNotes")}
              </button>
              <button className="pw-tl-gen" disabled={!bridge?.updateDownload} onClick={() => void bridge?.updateDownload?.()}>
                <Icon.Retry size={12} />
                {t("general.downloadUpdate")}
              </button>
            </div>
          </SRow>
        ) : null}
        {updateState.phase === "downloaded" ? (
          <SRow label={t("general.action")} end>
            <button className="pw-tl-gen" disabled={!bridge?.updateInstall} onClick={() => void bridge?.updateInstall?.()}>
              <Icon.Retry size={12} />
              {t("general.restartUpdate")}
            </button>
          </SRow>
        ) : null}
      </SettingCard>
      {showNotes ? (
        <UpdateDialog
          state={updateState}
          onDownload={() => void bridge?.updateDownload?.()}
          onInstall={() => void bridge?.updateInstall?.()}
          onClose={() => setShowNotes(false)}
        />
      ) : null}

      <SettingCard title={t("general.logCard")}>
        <SwitchRow
          label={t("general.logEnabled")}
          desc={t("general.logEnabledDesc")}
          value={general.log.enabled}
          onChange={(v) => {
            setGeneral({ log: { ...general.log, enabled: v } });
            void bridge?.setLogEnabled?.(v);
          }}
        />
        <SRow label={t("general.logRetention")} desc={t("general.logRetentionDesc")}>
          <BareSelect
            value={String(general.log.retentionDays)}
            options={LOG_RETENTION_DAYS.map((d) => ({ label: t("general.logRetentionDays", { count: d }), value: String(d) }))}
            onChange={(v) => setGeneral({ log: { ...general.log, retentionDays: Number(v) || 2 } })}
          />
        </SRow>
        <SRow label={t("general.logDir")} end>
          <button className="pw-tl-gen" disabled={!bridge?.openLogsDir} onClick={() => void bridge?.openLogsDir?.()}>
            <Icon.Folder size={12} />
            {t("general.openLogDir")}
          </button>
        </SRow>
      </SettingCard>

      {/* 通知预览:触发图中示例提醒,验证全局通用提醒样式(icon 用 Run、info 着色贴合图)。 */}
      <SettingCard title={tc("toast.previewTitle")}>
        <SRow label={tc("toast.previewAction")} desc={tc("toast.previewDesc")} end>
          <button
            className="pw-tl-gen"
            onClick={() =>
              pushToast("", {
                kind: "info",
                icon: "Run",
                title: tc("toast.demo.quotaTitle"),
                description: tc("toast.demo.quotaDesc"),
              })
            }
          >
            <Icon.Bell size={12} />
            {tc("toast.previewAction")}
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
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.timelineSettings);
  const setSettings = usePersonalStore((s) => s.setTimelineSettings);
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const enabledProviders = providerSettings.providers.filter((p) => p.enabled);
  const model = settings.summaryModel;
  const setModel = (m: SummaryModelConfig) => setSettings({ summaryModel: m });
  // pi 日报模型来自配置的供应商（与新建 Pi 会话/Pi 设置一致）:选中供应商缺省回退全局默认。
  const piProviderId =
    model.kind === "agent" && model.agent === "pi"
      ? model.providerId ?? providerSettings.defaultProviderId
      : undefined;
  const piProvider = enabledProviders.find((p) => p.id === piProviderId);

  return (
    <>
      <div className="pw-dlg-title">{t("timeline.title")}</div>
      <div className="pw-dlg-desc">{t("timeline.desc")}</div>

      <SettingCard title={t("timeline.modelCard")}>
        <SRow label={t("timeline.generateMode")} desc={t("timeline.generateModeDesc")}>
          <SegmentedRadio
            value={model.kind === "agent" ? t("timeline.integratedAgent") : t("timeline.customModel")}
            options={[t("timeline.integratedAgent"), t("timeline.customModel")]}
            onChange={(v) =>
              setModel(
                v === t("timeline.integratedAgent")
                  ? { kind: "agent", agent: "claude", model: "haiku" }
                  : { kind: "openai", baseUrl: "http://localhost:11434", apiKey: "", model: "" },
              )
            }
          />
        </SRow>
        {model.kind === "agent" ? (
          <>
            <SRow label={t("timeline.agent")}>
              <BareSelect
                value={model.agent}
                options={INTEGRATED_AGENTS.map((a) => ({ label: AGENT_LABEL[a], value: a }))}
                onChange={(v) => {
                  const next = v as AgentKind;
                  if (next === "pi") {
                    // 切到 pi:默认供应商 + 其默认/首个模型,沿用 providerSettings 配置。
                    const pid = providerSettings.defaultProviderId;
                    const p = enabledProviders.find((x) => x.id === pid);
                    setModel({
                      kind: "agent",
                      agent: "pi",
                      providerId: pid,
                      model: providerSettings.defaultModel ?? p?.models[0]?.id,
                    });
                  } else {
                    setModel({ kind: "agent", agent: next, model: DEFAULT_MODEL[next] });
                  }
                }}
              />
            </SRow>
            {model.agent === "pi" ? (
              enabledProviders.length === 0 ? (
                <div className="pw-scard-empty">{t("timeline.piNoProvider")}</div>
              ) : (
                <>
                  <SRow label={t("timeline.provider")} desc={t("timeline.providerDesc")}>
                    <BareSelect
                      value={piProviderId ?? ""}
                      options={enabledProviders.map((p) => ({ label: p.name || p.id, value: p.id }))}
                      onChange={(v) => {
                        const p = enabledProviders.find((x) => x.id === v);
                        setModel({ kind: "agent", agent: "pi", providerId: v, model: p?.models[0]?.id });
                      }}
                    />
                  </SRow>
                  <SRow label={t("timeline.model")}>
                    <BareSelect
                      value={model.model ?? ""}
                      options={(piProvider?.models ?? []).map((m) => ({ label: m.label ?? m.id, value: m.id }))}
                      onChange={(v) => setModel({ kind: "agent", agent: "pi", providerId: piProviderId, model: v })}
                    />
                  </SRow>
                </>
              )
            ) : (
              <SRow label={t("timeline.model")}>
                <BareSelect
                  value={model.model ?? DEFAULT_MODEL[model.agent]}
                  options={AGENT_MODELS[model.agent]}
                  onChange={(v) => setModel({ kind: "agent", agent: model.agent, model: v })}
                />
              </SRow>
            )}
          </>
        ) : (
          <>
            <SRow label={t("timeline.baseUrl")} desc={t("timeline.baseUrlDesc")}>
              <input
                className="pw-set-input"
                value={model.baseUrl}
                placeholder="http://localhost:11434"
                spellCheck={false}
                onChange={(e) => setModel({ ...model, baseUrl: e.target.value })}
              />
            </SRow>
            <SRow label={t("timeline.modelName")}>
              <input
                className="pw-set-input"
                value={model.model}
                placeholder="qwen3:14b"
                spellCheck={false}
                onChange={(e) => setModel({ ...model, model: e.target.value })}
              />
            </SRow>
            <SRow label={t("timeline.apiKey")} desc={t("timeline.apiKeyOptional")}>
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

// label 走 i18n（settings:providers.endpointFormat.*）,故 value→formatKey,渲染时翻译。
const ENDPOINT_FORMAT_OPTIONS: { formatKey: string; value: EndpointFormat }[] = [
  { formatKey: "providers.endpointFormat.chatCompletions", value: "chat_completions" },
  { formatKey: "providers.endpointFormat.responses", value: "responses" },
  { formatKey: "providers.endpointFormat.messages", value: "messages" },
  { formatKey: "providers.endpointFormat.custom", value: "custom" },
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
  const { t } = useTranslation("settings");
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
          {show ? t("providers.secretHide") : t("providers.secretShow")}
        </button>
      </span>
    </label>
  );
}

// 两段式删除确认（仿 ProjectMenu:首次点击进入确认态,再次点击执行,失焦撤销）。
function ConfirmDelete({ onConfirm, title }: { onConfirm: () => void; title?: string }) {
  const { t } = useTranslation("settings");
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      className={`pw-pi-channel-del ${confirming ? "is-confirming" : ""}`}
      title={title}
      onClick={() => (confirming ? onConfirm() : setConfirming(true))}
      onBlur={() => setConfirming(false)}
    >
      {confirming ? t("providers.confirmDelete") : <Icon.Trash size={14} />}
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
  const { t } = useTranslation("settings");
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
          placeholder={t("providers.models.idPlaceholder")}
          spellCheck={false}
          autoFocus
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
        <input
          className="pw-set-input"
          value={label}
          placeholder={t("providers.models.labelPlaceholder")}
          spellCheck={false}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
      </div>
      <div className="pw-ml-edit-row">
        <input
          className="pw-set-input pw-ml-ctx"
          value={ctx}
          placeholder={t("providers.models.contextPlaceholder")}
          spellCheck={false}
          onChange={(e) => setCtx(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
        <label className="pw-ml-check">
          <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
          {t("providers.models.reasoning")}
        </label>
        <label className="pw-ml-check">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
          {t("providers.models.vision")}
        </label>
        <span className="pw-ml-edit-spacer" />
        <button className="btn pw-pi-add-btn" disabled={!id.trim()} onClick={save}>
          {t("providers.models.save")}
        </button>
        <button className="pw-ml-cancel" onClick={onCancel}>
          {t("providers.models.cancel")}
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
  const { t } = useTranslation("settings");
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
      setProbe(res.ok ? { kind: "ok", models: res.models ?? [] } : { kind: "err", error: res.error ?? t("providers.models.connectFailed") });
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
        <span className="pw-ml-title">{t("providers.models.listTitle", { count: models.length })}</span>
        <button
          className="pw-tl-gen"
          disabled={!canProbe || probe.kind === "testing"}
          onClick={() => void runProbe()}
          title={endpointFormat === "custom" ? t("providers.models.customNoProbe") : undefined}
        >
          <Icon.Retry size={12} />
          {probe.kind === "testing" ? t("providers.models.fetchProbing") : t("providers.models.fetch")}
        </button>
      </div>
      <div className="pw-set-hint">{t("providers.models.hint")}</div>

      {probe.kind === "ok" ? (
        <div className="pw-ml-probe pw-ml-probe-ok">
          {t("providers.models.probeOk", { count: probe.models.length })}
          {probe.models.length > 0 ? (
            <button className="pw-prov-probe-apply" onClick={() => applyFetched(probe.models)}>
              {t("providers.models.apply")}
            </button>
          ) : null}
        </div>
      ) : null}
      {probe.kind === "err" ? <div className="pw-ml-probe pw-ml-probe-err">{probe.error}</div> : null}

      {models.length === 0 && editIdx === null ? (
        <div className="pw-set-hint">{t("providers.models.emptyHint")}</div>
      ) : null}

      {models.map((m, i) =>
        editIdx === i ? (
          <ModelEditRow key={i} initial={m} onSave={saveModel} onCancel={() => setEditIdx(null)} />
        ) : (
          <div key={i} className="pw-ml-card">
            <div className="pw-ml-card-main">
              <span className="pw-ml-id">{m.id}</span>
              <span className="pw-ml-badges">
                <span className="pw-ml-badge">{t("providers.models.badgeText")}</span>
                {m.contextTokens ? <span className="pw-ml-badge">{t("providers.models.badgeContext", { value: formatContext(m.contextTokens) })}</span> : null}
                {m.reasoning ? <span className="pw-ml-badge">{t("providers.models.badgeReasoning")}</span> : null}
                {m.vision ? <span className="pw-ml-badge">{t("providers.models.badgeVision")}</span> : null}
                {m.label && m.label !== m.id ? <span className="pw-ml-badge is-name">{m.label}</span> : null}
              </span>
            </div>
            <div className="pw-ml-actions">
              <button title={t("providers.models.edit")} onClick={() => setEditIdx(i)}>
                <Icon.Edit size={14} />
              </button>
              <button title={t("providers.models.delete")} onClick={() => removeModel(i)}>
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
          {t("providers.models.addModel")}
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
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  return (
    <div className="pw-prov-detail">
      <div className="pw-pi-channel-head">
        <input
          className="pw-set-input"
          value={provider.name}
          placeholder={t("providers.namePlaceholder")}
          spellCheck={false}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <Toggle label={t("providers.enable")} value={provider.enabled} onChange={(v) => onPatch({ enabled: v })} />
        <ConfirmDelete onConfirm={onRemove} title={t("providers.deleteProvider")} />
      </div>
      <Select
        label={t("providers.protocolType")}
        value={provider.endpointFormat}
        options={ENDPOINT_FORMAT_OPTIONS.map((o) => ({ label: t(o.formatKey), value: o.value }))}
        onChange={(v) => onPatch({ endpointFormat: v as EndpointFormat })}
      />
      <Field
        label={t("providers.baseUrl")}
        value={provider.baseUrl}
        placeholder={t("providers.baseUrlPlaceholder")}
        onChange={(v) => onPatch({ baseUrl: v })}
      />
      <SecretField
        label={t("providers.apiKey")}
        value={provider.apiKey ?? ""}
        placeholder={t("providers.apiKeyPlaceholder")}
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
  const { t } = useTranslation("settings");
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const addProvider = usePersonalStore((s) => s.addProvider);
  const updateProvider = usePersonalStore((s) => s.updateProvider);
  const removeProvider = usePersonalStore((s) => s.removeProvider);
  const providers = providerSettings.providers;
  const [selectedId, setSelectedId] = useState<string | undefined>(providers[0]?.id);
  const [tmplKey, setTmplKey] = useState(PROVIDER_PRESETS[0]?.templateKey ?? "deepseek");

  const selected = providers.find((p) => p.id === selectedId) ?? providers[0];

  const addFromTemplate = () => {
    const preset = PROVIDER_PRESETS.find((x) => x.templateKey === tmplKey);
    if (!preset) return;
    const base = slugify(preset.templateKey === "custom" ? "custom-provider" : preset.templateKey);
    const existing = new Set(providers.map((p) => p.id));
    let id = base;
    let n = 1;
    while (existing.has(id)) id = `${base}-${++n}`;
    addProvider(providerFromPreset(preset, id));
    setSelectedId(id);
  };

  return (
    <>
      <div className="pw-dlg-title">{t("providers.title")}</div>
      <div className="pw-dlg-desc">{t("providers.desc")}</div>

      <div className="pw-pi-add">
        <Select
          label={t("providers.addFromTemplate")}
          value={tmplKey}
          options={PROVIDER_PRESETS.map((preset) => ({ label: t(preset.nameKey), value: preset.templateKey }))}
          onChange={setTmplKey}
        />
        <button className="btn pw-pi-add-btn" onClick={addFromTemplate}>
          {t("providers.addProvider")}
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="pw-set-hint">{t("providers.empty")}</div>
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
                    <span className="pw-prov-badge is-default">{t("providers.badgeDefault")}</span>
                  ) : null}
                  {p.enabled ? null : <span className="pw-prov-badge">{t("providers.badgeDisabled")}</span>}
                  <span className="pw-prov-badge">{t("providers.badgeModels", { count: p.models.length })}</span>
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
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const setGeneral = usePersonalStore((s) => s.setGeneralSettings);
  // 当前生效值:用户显式设置优先,否则展示运行时派生的兜底 agent。
  const effectiveDefault = resolveDefaultAgent({ generalSettings, agentsAvailable });

  return (
    <>
      <div className="pw-dlg-title">{t("agent.title")}</div>
      <div className="pw-dlg-desc">{t("agent.desc")}</div>

      <SettingCard title={t("agent.defaultCard")}>
        <SRow label={t("agent.defaultLabel")} desc={t("agent.defaultDesc")} end>
          <BareSelect
            value={effectiveDefault}
            options={INTEGRATED_AGENTS.map((a) => ({
              label: a === "pi" || agentsAvailable?.[a] ? AGENT_LABEL[a] : t("agent.labelNotInstalled", { name: AGENT_LABEL[a] }),
              value: a,
            }))}
            onChange={(v) => setGeneral({ defaultAgent: v as AgentKind })}
          />
        </SRow>
      </SettingCard>

      <SettingCard title={t("agent.availabilityCard")}>
        {INTEGRATED_AGENTS.map((a) => {
          const on = a === "pi" || !!agentsAvailable?.[a];
          return (
            <SRow key={a} label={AGENT_LABEL[a]} end>
              <span className={`pw-agent-status ${on ? "is-on" : "is-off"}`}>
                {a === "pi" ? t("agent.builtin") : agentsAvailable?.[a] ? t("agent.installed") : t("agent.notDetected")}
              </span>
            </SRow>
          );
        })}
      </SettingCard>

      {bridge?.appInfo?.devMode ? <AgentTraceWindowCard bridge={bridge} /> : null}
    </>
  );
}

/* eslint-disable i18next/no-literal-string -- dev-only diagnostics labels are intentionally not localized. */
function AgentTraceWindowCard({ bridge }: { bridge: DesktopBridge }) {
  return (
    <SettingCard title="调试跟踪">
      <div className="pw-scard-empty">实时 Agent 事件会在独立窗口中显示,便于边操作边观察。</div>
      <button className="pw-tl-gen" onClick={() => void bridge.openAgentTraceWindow?.()} disabled={!bridge.openAgentTraceWindow}>
        打开调试跟踪窗口
      </button>
    </SettingCard>
  );
}
/* eslint-enable i18next/no-literal-string */

// 「Pi」设置分区:聚合 pi 专属设置(默认供应商/模型、工具审批、高级定制),并承载后续新增的
// 会话级能力。卡片锚点顺序:默认供应商 → Thinking → System Prompt → 工具审批 → 高级定制 →
// 供应商高级说明(后续阶段按此顺序插入,减少改动冲突)。
function PiSection() {
  const { t } = useTranslation("settings");
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
      <div className="pw-dlg-title">{t("pi.title")}</div>
      <div className="pw-dlg-desc">{t("pi.desc")}</div>

      <SettingCard title={t("pi.defaultProviderCard")}>
        {enabledProviders.length === 0 ? (
          <div className="pw-scard-empty">{t("pi.noProvider")}</div>
        ) : (
          <>
            <SRow label={t("pi.defaultProvider")} desc={t("pi.defaultProviderDesc")}>
              <BareSelect
                value={defaultValue}
                options={[
                  { label: t("pi.providerUnset"), value: "" },
                  ...enabledProviders.map((p) => ({ label: p.name || p.id, value: p.id })),
                ]}
                onChange={(v) => setProviderDefaults({ defaultProviderId: v || undefined, defaultModel: undefined })}
              />
            </SRow>
            <SRow label={t("pi.defaultModel")}>
              <BareSelect
                value={providerSettings.defaultModel ?? ""}
                options={[
                  { label: t("pi.modelFirst"), value: "" },
                  ...(defaultProvider?.models ?? []).map((m) => ({ label: m.label ?? m.id, value: m.id })),
                ]}
                onChange={(v) => setProviderDefaults({ defaultModel: v || undefined })}
              />
            </SRow>
          </>
        )}
      </SettingCard>

      <SettingCard title={t("pi.thinkingCard")}>
        <SRow label={t("pi.thinkingDefault")} desc={t("pi.thinkingDefaultDesc")}>
          <BareSelect
            value={general.piThinkingDefault ?? "off"}
            options={PI_THINKING_LEVELS.map((lv) => ({ label: t(`thinkingLevel.${lv}`), value: lv }))}
            onChange={(v) => setGeneral({ piThinkingDefault: v as ThinkingLevel })}
          />
        </SRow>
      </SettingCard>

      <SettingCard title={t("pi.systemPromptCard")}>
        <SBlock label={t("pi.systemPrompt")} desc={t("pi.systemPromptDesc")}>
          <textarea
            className="pw-ta"
            rows={6}
            maxLength={4000}
            placeholder={t("pi.systemPromptPlaceholder")}
            value={general.piSystemPrompt ?? ""}
            spellCheck={false}
            onChange={(e) => setGeneral({ piSystemPrompt: e.target.value || undefined })}
          />
          <div className="pw-ta-count">{(general.piSystemPrompt ?? "").length}/4000</div>
        </SBlock>
      </SettingCard>

      <SettingCard title={t("pi.toolApprovalCard")}>
        <SwitchRow
          label={t("pi.toolApproval")}
          desc={t("pi.toolApprovalDesc")}
          value={general.piCustomization?.toolApproval ?? false}
          onChange={(v) => setGeneral({ piCustomization: { sampleTools: false, sampleCommands: false, approvalTools: DEFAULT_PI_APPROVAL_TOOLS, ...general.piCustomization, toolApproval: v } })}
        />
        {general.piCustomization?.toolApproval ? (
          <SBlock label={t("pi.approvalTools")} desc={t("pi.approvalToolsDesc")}>
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
                        const next = e.target.checked ? [...selected, tool] : selected.filter((x) => x !== tool);
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

      <SettingCard title={t("pi.advancedCard")}>
        <SwitchRow
          label={t("pi.sampleTools")}
          desc={t("pi.sampleToolsDesc")}
          value={general.piCustomization?.sampleTools ?? false}
          onChange={(v) => setGeneral({ piCustomization: { toolApproval: false, sampleCommands: false, ...general.piCustomization, sampleTools: v } })}
        />
        <SwitchRow
          label={t("pi.sampleCommands")}
          desc={t("pi.sampleCommandsDesc")}
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
  const { t } = useTranslation("settings");
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
    { label: t("push.formatDefault"), value: "" },
    ...skillFiles.map((f) => ({ label: f.name, value: f.path })),
    ...(push.formatSkillPath && !skillFiles.some((f) => f.path === push.formatSkillPath)
      ? [{ label: t("push.formatInvalid", { path: push.formatSkillPath }), value: push.formatSkillPath }]
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
      <div className="pw-dlg-title">{t("push.title")}</div>
      <div className="pw-dlg-desc">{t("push.desc")}</div>

      <SettingCard title={t("push.formatCard")}>
        <div className="pw-scard-empty">
          {t("push.formatHint", {
            placeholders: " {{project}}、{{date}}、{{stats}}、{{summary}}、{{runs}}、{{files}}、{{commits}}",
          })}
        </div>
        <SRow label={t("push.formatTemplate")}>
          <BareSelect
            value={push.formatSkillPath ?? ""}
            options={skillOptions}
            onChange={(v) => setPush({ formatSkillPath: v || undefined })}
          />
        </SRow>
        <SRow label={t("push.exampleSkill")} desc={!promptRoot ? t("push.exampleSkillDesc") : undefined} end>
          <button className="pw-tl-gen" disabled={!bridge || !promptRoot} onClick={() => void createExampleSkill()}>
            <Icon.Plus size={12} />
            {t("push.createExample")}
          </button>
        </SRow>
      </SettingCard>

      <SettingCard title={t("push.channelCard")}>
        <SwitchRow label={t("push.wecom")} value={!!wecom?.enabled} onChange={(v) => setWecom({ enabled: v })} />
        {wecom?.enabled ? (
          <SRow label={t("push.webhookUrl")}>
            <input
              className="pw-set-input"
              value={wecom.webhookUrl}
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
              spellCheck={false}
              onChange={(e) => setWecom({ webhookUrl: e.target.value })}
            />
          </SRow>
        ) : null}

        <SwitchRow label={t("push.dingtalk")} value={!!dingtalk?.enabled} onChange={(v) => setDingtalk({ enabled: v })} />
        {dingtalk?.enabled ? (
          <>
            <SRow label={t("push.webhookUrl")}>
              <input
                className="pw-set-input"
                value={dingtalk.webhookUrl}
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
                spellCheck={false}
                onChange={(e) => setDingtalk({ webhookUrl: e.target.value })}
              />
            </SRow>
            <SRow label={t("push.dingtalkSecret")} desc={t("push.dingtalkSecretDesc")}>
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

        <SwitchRow label={t("push.email")} value={!!email?.enabled} onChange={(v) => setEmail({ enabled: v })} />
        {email?.enabled ? (
          <>
            <SRow label={t("push.smtpHost")}>
              <input
                className="pw-set-input"
                value={email.smtpHost}
                placeholder="smtp.qq.com"
                spellCheck={false}
                onChange={(e) => setEmail({ smtpHost: e.target.value })}
              />
            </SRow>
            <SRow label={t("push.smtpPort")}>
              <input
                className="pw-set-input"
                value={String(email.smtpPort || "")}
                placeholder="465"
                onChange={(e) => setEmail({ smtpPort: Number(e.target.value) || 0 })}
              />
            </SRow>
            <SwitchRow
              label={t("push.ssl")}
              desc={t("push.sslDesc")}
              value={email.secure}
              onChange={(v) => setEmail({ secure: v })}
            />
            <SRow label={t("push.account")}>
              <input className="pw-set-input" value={email.user} spellCheck={false} onChange={(e) => setEmail({ user: e.target.value })} />
            </SRow>
            <SRow label={t("push.password")}>
              <input className="pw-set-input" type="password" value={email.pass} onChange={(e) => setEmail({ pass: e.target.value })} />
            </SRow>
            <SRow label={t("push.from")}>
              <input
                className="pw-set-input"
                value={email.from}
                placeholder={t("push.fromPlaceholder")}
                spellCheck={false}
                onChange={(e) => setEmail({ from: e.target.value })}
              />
            </SRow>
            <SRow label={t("push.to")}>
              <input
                className="pw-set-input"
                value={email.to}
                placeholder={t("push.toPlaceholder")}
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

// 1× 档展示带「默认」后缀,走 i18n（settings:voice.speechRateDefault）,其余纯符号无需翻译。
const SPEECH_RATE_VALUES = ["0.8", "1", "1.2", "1.5"];

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

// 语言项标签是「原生语言名 + BCP47 码」,各语言通用,无需随界面语言翻译。
const TTS_LANGUAGES = [
  { label: "中文 zh", value: "zh" },
  { label: "中文 zh-CN", value: "zh-CN" },
  { label: "English en", value: "en" },
  { label: "日本語 ja", value: "ja" },
  { label: "한국어 ko", value: "ko" },
];

function VoiceSection() {
  const { t } = useTranslation("settings");
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
      { label: t("voice.voiceSystemDefault"), value: "" },
      ...voices.map((v) => ({ label: `${v.name}（${v.lang}）`, value: v.name })),
    ],
    [voices, t],
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
    if (engine.voice && !seen.has(engine.voice)) options.unshift({ value: engine.voice, label: t("voice.voiceCurrent", { voice: engine.voice }) });
    return options;
  }, [customVoices, engine, t]);

  const test = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await speakText(bridge, tts, t("voice.testText"));
    } catch {
      // 端点不可用等,静默（按钮恢复即提示完成）
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="pw-dlg-title">{t("voice.title")}</div>
      <div className="pw-dlg-desc">{t("voice.desc")}</div>

      <SettingCard title={t("voice.readCard")}>
        <SwitchRow
          label={t("voice.autoSpeak")}
          desc={t("voice.autoSpeakDesc")}
          value={tts.autoSpeak}
          onChange={(v) => setTts({ autoSpeak: v })}
        />
        <SRow label={t("voice.engine")}>
          <SegmentedRadio
            value={engine.kind === "system" ? t("voice.engineSystem") : t("voice.engineCustom")}
            options={[t("voice.engineSystem"), t("voice.engineCustom")]}
            onChange={(v) =>
              setEngine(
                v === t("voice.engineSystem")
                  ? { kind: "system" }
                  : { kind: "openai", baseUrl: "http://localhost:8880", apiKey: "", model: "tts-1", voice: "alloy", language: "zh" },
              )
            }
          />
        </SRow>
        {engine.kind === "system" ? (
          <>
            <SRow label={t("voice.voiceLabel")} desc={t("voice.voiceSystemDesc")}>
              <BareSelect
                value={engine.voice ?? ""}
                options={voiceOptions}
                onChange={(v) => setEngine({ ...engine, voice: v || undefined })}
              />
            </SRow>
            <SRow label={t("voice.rate")}>
              <BareSelect
                value={String(engine.rate ?? 1)}
                options={SPEECH_RATE_VALUES.map((v) => ({ label: v === "1" ? t("voice.speechRateDefault") : `${v}×`, value: v }))}
                onChange={(v) => setEngine({ ...engine, rate: Number(v) })}
              />
            </SRow>
          </>
        ) : (
          <>
            <SRow label={t("voice.baseUrl")} desc={t("voice.baseUrlDesc")}>
              <input
                className="pw-set-input"
                value={engine.baseUrl}
                placeholder="http://localhost:8880"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, baseUrl: e.target.value })}
              />
            </SRow>
            <SRow label={t("voice.modelName")}>
              <input
                className="pw-set-input"
                value={engine.model}
                placeholder="tts-1"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, model: e.target.value })}
              />
            </SRow>
            <SRow
              label={t("voice.voiceLabel")}
              desc={loadingVoices ? t("voice.voiceLoading") : customVoices.length > 0 ? t("voice.voiceFromModel") : t("voice.voiceCommon")}
            >
              <BareSelect value={engine.voice} options={customVoiceOptions} onChange={(v) => setEngine({ ...engine, voice: v })} />
            </SRow>
            <SRow label={t("voice.customVoice")}>
              <input
                className="pw-set-input"
                value={engine.voice}
                placeholder="alloy"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, voice: e.target.value })}
              />
            </SRow>
            <SRow label={t("voice.apiKey")} desc={t("voice.apiKeyOptional")}>
              <input
                className="pw-set-input"
                type="password"
                value={engine.apiKey ?? ""}
                onChange={(e) => setEngine({ ...engine, apiKey: e.target.value })}
              />
            </SRow>
            <SRow label={t("voice.language")}>
              <BareSelect value={engine.language ?? "zh"} options={TTS_LANGUAGES} onChange={(v) => setEngine({ ...engine, language: v })} />
            </SRow>
            <SRow label={t("voice.customLanguage")}>
              <input
                className="pw-set-input"
                value={engine.language ?? "zh"}
                placeholder="zh"
                spellCheck={false}
                onChange={(e) => setEngine({ ...engine, language: e.target.value || undefined })}
              />
            </SRow>
            <SRow label={t("voice.rate")}>
              <BareSelect
                value={String(engine.speed ?? 1)}
                options={SPEECH_RATE_VALUES.map((v) => ({ label: v === "1" ? t("voice.speechRateDefault") : `${v}×`, value: v }))}
                onChange={(v) => setEngine({ ...engine, speed: Number(v) })}
              />
            </SRow>
          </>
        )}
        <SRow label={t("voice.test")} end>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="pw-tl-gen" disabled={testing} onClick={() => void test()}>
              <Icon.Mic size={12} />
              {testing ? t("voice.testPlaying") : t("voice.test")}
            </button>
            <button className="pw-tl-gen" onClick={() => stopSpeaking()}>
              <Icon.Stop size={12} />
              {t("voice.stop")}
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
  const { t } = useTranslation("settings");
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
    <div className="pw-settings-page" role="dialog" aria-modal="true" aria-label={t("page.ariaLabel")}>
      <nav className="pw-dlg-nav" aria-label={t("page.navAriaLabel")}>
        <button ref={backRef} className="pw-settings-back" onClick={closeSettings}>
          <Icon.Back size={15} />
          {t("page.back")}
        </button>
        {TABS.map((tab2) => (
          <button
            key={tab2.id}
            className={`pw-dlg-nav-item ${tab === tab2.id ? "is-active" : ""}`}
            aria-current={tab === tab2.id ? "page" : undefined}
            onClick={() => setTab(tab2.id)}
          >
            {tab2.icon}
            {t(tab2.tabKey)}
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
          ) : tab === "plugins" ? (
            <PluginManager />
          ) : (
            <VoiceSection />
          )}
        </div>
      </div>
    </div>
  );
}

export function SettingsMenu() {
  const { t } = useTranslation();
  const openSettings = usePersonalStore((s) => s.openSettings);
  return (
    <div className="sb-foot">
      <button className="sb-row is-mute" onClick={openSettings}>
        <Icon.Settings size={15} />
        <span className="label">{t("sidebar.settings")}</span>
      </button>
    </div>
  );
}
