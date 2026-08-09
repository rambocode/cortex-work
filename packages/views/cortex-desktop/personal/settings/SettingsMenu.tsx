// 个人工作区左栏底部「设置」入口 + 全屏整页设置视图（PersonalSettingsView）。
// 入口：点击调用 store.openSettings()（settingsOpen 瞬态标志,见 store/personal.ts）。
// 整页：全屏不透明覆盖层（.pw-settings-page）接管整窗、隐藏侧栏;底层工作区不卸载以
//   保活终端。左栏菜单按 NAV_GROUPS 分组渲染（模型组:Pi(含供应商管理)/Agent/角色）
//   + 顶部「返回应用」,右栏按 active tab 渲染对应 Section;ESC 返回（录制/输入态豁免）。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { HotkeyCapture } from "@cortex-work/ui/controls/HotkeyCapture";
import { formatAccelerator } from "@cortex-work/ui/controls/hotkeyAccelerator";
import {
  AGENT_LABEL,
  AGENT_MODELS,
  AVATAR_BG_COLORS,
  AVATAR_EMOJIS,
  DEFAULT_MODEL,
  DEFAULT_PUSH_TEMPLATE,
  profileInitial,
  resolveAvatar,
  resolveDefaultAgent,
  useCortexUIStore,
  useDesktopBridge,
  usePersonalProfile,
  usePersonalStore,
  useUpdateState,
} from "@cortex-work/core";
import { UpdateDialog } from "../../UpdateDialog";
import type {
  AgentKind,
  DesktopBridge,
  DingtalkPushConfig,
  EmailPushConfig,
  FeishuPushConfig,
  InternalNotifyConfig,
  PromptNode,
  SummaryModelConfig,
  UpdateState,
  WecomPushConfig,
} from "@cortex-work/core";
import type { Density, FontScale, SidebarMode, ThemeMode } from "@cortex-work/core/types";
import { useTranslation, type Locale } from "@cortex-work/core/i18n";
import { PetSettingsSection } from "./PetSettingsSection";
import { PluginManager } from "../plugins/PluginManager";
import { ArchivedSessionsSection } from "../sessions/ArchivedSessionsSection";
import { SpeechSettingsSection } from "./SpeechSettingsSection";
import { RolesSection } from "./RolesSettingsSection";
import { DesignSettingsSection } from "./DesignSettingsSection";
import { WritingSettingsSection } from "./WritingSettingsSection";
import { MemorySettingsSection } from "./MemorySettingsSection";
import { ResearchSettingsSection } from "./ResearchSettingsSection";
import { KnowledgeSettingsSection } from "./KnowledgeSettingsSection";
import { PiProvidersSection } from "./provider/PiProvidersSection";
import { DefaultModelSelects } from "./provider/DefaultModelSelects";
import { ModelRefField } from "./provider/ModelRefField";
import { BareSelect, SBlock, SRow, SettingCard, SwitchRow } from "./settingsControls";
import { detectIsMac } from "../shared/platform";
import { SettingsSavedIndicator } from "./SettingsSavedIndicator";
import { BrowserSection, isSettingsTypingTarget, MediaGenSection, ReplySection } from "./SettingsViewSupport";
import { SubagentSettingsSection } from "./SubagentSettingsSection";
// 译函数最小签名（与 TimelineView 一致,避免引入 react-i18next 的 TFunction 泛型）。
type TFunction = (key: string, opts?: Record<string, unknown>) => string;
type SettingsTab =
  | "profile"
  | "general"
  | "memory"
  | "archivedSessions"
  | "agent"
  | "subagents"
  | "pi"
  | "plugins"
  | "browser"
  | "mediaGen"
  | "pet"
  | "timeline"
  | "push"
  | "speech"
  | "reply"
  | "roles"
  | "design"
  | "writing"
  | "research"
  | "knowledge";
// 项元数据唯一来源：label 走 i18n（settings:tabs.*）,故此处只存 tabKey + icon,渲染时即时翻译。
// 分组（NAV_GROUPS）只描述「哪些项归哪组 + 顺序」,不重复 icon/文案,避免双写漂移（KTD3）。
const TAB_META: Record<SettingsTab, { tabKey: string; icon: React.ReactNode }> = {
  profile: { tabKey: "tabs.profile", icon: <Icon.Users size={14} /> },
  general: { tabKey: "tabs.general", icon: <Icon.Settings size={14} /> },
  // 用户记忆（跨会话/写作/设计共享的做梦式持久记忆;Web 端由 memoryAvailable 过滤隐藏）
  memory: { tabKey: "tabs.memory", icon: <Icon.Sparkle size={14} /> },
  archivedSessions: { tabKey: "tabs.archivedSessions", icon: <Icon.Archive size={14} /> },
  agent: { tabKey: "tabs.agent", icon: <Icon.Terminal size={14} /> },
  subagents: { tabKey: "tabs.subagents", icon: <Icon.Bot size={14} /> },
  // 「模型」分区：接入供应商 + 设默认模型（原独立「供应商」tab 已并入）。
  // 枚举值仍是 "pi"——它是技术标识符,且 openSettings("pi") 有多处调用点;只有显示名改为「模型」。
  pi: { tabKey: "tabs.pi", icon: <Icon.Bot size={14} /> },
  plugins: { tabKey: "tabs.plugins", icon: <Icon.Workflow size={14} /> },
  browser: { tabKey: "tabs.browser", icon: <Icon.Globe size={14} /> },
  // 媒体生成 / 统一语音设置
  mediaGen: { tabKey: "tabs.mediaGen", icon: <Icon.Image size={14} /> },
  speech: { tabKey: "tabs.speech", icon: <Icon.Mic size={14} /> },
  // 快捷回复助手（U9，macOS-only；非 mac / Web 端由 replyAvailable 过滤隐藏）
  reply: { tabKey: "tabs.reply", icon: <Icon.Send size={14} /> },
  pet: { tabKey: "tabs.pet", icon: <Icon.Sparkle size={14} /> },
  timeline: { tabKey: "tabs.timeline", icon: <Icon.Clock size={14} /> },
  push: { tabKey: "tabs.push", icon: <Icon.Send size={14} /> },
  roles: { tabKey: "tabs.roles", icon: <Icon.Users size={14} /> },
  // 设计工作台（AI 设计画布,desktop-only）
  design: { tabKey: "tabs.design", icon: <Icon.Palette size={14} /> },
  // 写作续写/改写（U3，ghost text + Cmd-K 就地改写的独立模型配置）
  writing: { tabKey: "tabs.writing", icon: <Icon.Edit size={14} /> },
  // 研究引擎（CRE，desktop-only；旧壳/Web 无 bridge.research → 由 researchAvailable 过滤隐藏）
  research: { tabKey: "tabs.research", icon: <Icon.Search size={14} /> },
  // 公司知识库（远端 MCP server，desktop-only；旧壳/Web 无 bridge.knowledge → 由 knowledgeAvailable 过滤隐藏）
  knowledge: { tabKey: "tabs.knowledge", icon: <Icon.Archive size={14} /> },
};
// 设置左栏分组：组标题走 i18n（settings:tabGroups.*）,组内项按数组顺序渲染。
// 「应用」组并列「插件」「浏览器」两项（用户确认的 IA）。
const NAV_GROUPS: { groupKey: string; items: SettingsTab[] }[] = [
  { groupKey: "tabGroups.general", items: ["profile", "general", "memory", "archivedSessions"] },
  { groupKey: "tabGroups.models", items: ["pi", "agent", "subagents", "roles"] },
  // 媒体生成挂「应用」组，统一语音设置与个性化能力并列。
  {
    groupKey: "tabGroups.apps",
    items: ["plugins", "knowledge", "browser", "mediaGen", "design", "writing", "research"],
  },
  { groupKey: "tabGroups.personalization", items: ["pet", "speech", "reply"] },
  { groupKey: "tabGroups.automation", items: ["timeline", "push"] },
];
// 个人资料:昵称 + 头像(背景色 + 图标两模式:用户名首字符 / Emoji,参考 Notion 头像编辑器)。
// 写入 personal store 的 profile 切片(随工作区落盘);会话中 who="me" 的气泡经
// whoMeta → resolveAvatar 据此渲染(见 ChatArea MessageAvatar),此处预览与其同源。
function ProfileSection() {
  const { t } = useTranslation("settings");
  const profile = usePersonalProfile();
  const setProfile = usePersonalStore((s) => s.setProfile);
  const nickname = profile.nickname ?? "";
  // 缺省字段(模式/emoji/背景)的兜底只收敛在 resolveAvatar 一处,预览直接消费其结果。
  const avatar = resolveAvatar(profile);
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
          <div className="pw-profile-preview">
            <div
              className={`pw-profile-preview-avatar ${avatar.mode === "initials" ? "is-initial" : ""}`}
              style={{ background: avatar.bg }}
            >
              {avatar.mode === "emoji" ? avatar.emoji : profileInitial(nickname)}
            </div>
            <div className="pw-profile-preview-name">{nickname.trim() || t("profile.nicknamePlaceholder")}</div>
          </div>
        </SBlock>
        <SBlock label={t("profile.bgColor")}>
          <div className="pw-bg-swatches">
            {AVATAR_BG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`pw-bg-swatch ${c === avatar.bg ? "is-active" : ""}`}
                style={{ background: c }}
                aria-label={c}
                onClick={() => setProfile({ avatarBg: c })}
              />
            ))}
          </div>
        </SBlock>
        <SBlock label={t("profile.icon")}>
          <div className="pw-icon-radios">
            <label className="pw-icon-radio">
              <input
                type="radio"
                name="pw-avatar-icon-mode"
                checked={avatar.mode === "initials"}
                onChange={() => setProfile({ avatarMode: "initials" })}
              />
              {t("profile.iconInitials")}
            </label>
            <label className="pw-icon-radio">
              <input
                type="radio"
                name="pw-avatar-icon-mode"
                checked={avatar.mode === "emoji"}
                onChange={() => setProfile({ avatarMode: "emoji" })}
              />
              {t("profile.iconEmoji")}
            </label>
          </div>
          {/* emoji 网格仅 emoji 模式显示;initials 模式的图标取自昵称,无可选清单。 */}
          {avatar.mode === "emoji" ? (
            <div className="pw-emoji-grid">
              {AVATAR_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`pw-emoji-btn ${e === avatar.emoji ? "is-active" : ""}`}
                  onClick={() => setProfile({ avatarEmoji: e })}
                >
                  {e}
                </button>
              ))}
            </div>
          ) : null}
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


// 集成 Agent 列表（与会话创建可选的 agent 一致,来自 AGENT_MODELS 注册表;
// 新增 agent 接入后此处自动出现）。
const INTEGRATED_AGENTS = Object.keys(AGENT_MODELS) as AgentKind[];


function TimelineSection() {
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.timelineSettings);
  const setSettings = usePersonalStore((s) => s.setTimelineSettings);
  const model = settings.summaryModel;
  const setModel = (m: SummaryModelConfig) => setSettings({ summaryModel: m });

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
                  // 自定义模型档改走 Model Gateway：ref 缺省 = 未配置，由下方 ModelRefField
                  // 渲染阻断态要求用户显式选一个，不预填任何模型（计划 §5）。
                  : { kind: "gateway" },
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
                    // 切到 pi 不预填模型：由下方 ModelRefField 显式选。旧版在这里读
                    // providerSettings 猜「默认供应商的第一个模型」，正是 §5 禁止的静默回退。
                    setModel({ kind: "agent", agent: "pi" });
                  } else {
                    setModel({ kind: "agent", agent: next, model: DEFAULT_MODEL[next] });
                  }
                }}
              />
            </SRow>
            {model.agent === "pi" ? (
              // pi 日报模型与全局模型选择器同一份 Catalog 候选（认证可用 ∧ 未隐藏）；
              // 悬空引用进阻断态并要求重选，不自动回退。
              <ModelRefField
                label={t("timeline.model")}
                value={
                  model.providerId && model.model
                    ? { providerId: model.providerId, modelId: model.model }
                    : undefined
                }
                onChange={(ref) =>
                  setModel({ kind: "agent", agent: "pi", providerId: ref.providerId, model: ref.modelId })
                }
              />
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
          // Gateway 档：寻址统一成 Catalog 引用，渲染端不再持有 baseUrl/apiKey
          //（旧的 kind:"openai" 是全仓第三处明文密钥落盘点，已随类型删除）。
          <ModelRefField
            label={t("timeline.model")}
            hint={t("timeline.gatewayHint")}
            value={settings.summaryModel.kind === "gateway" ? settings.summaryModel.ref : undefined}
            onChange={(ref) => setModel({ kind: "gateway", ref })}
          />
        )}
      </SettingCard>
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

// 「模型」设置分区(原「Pi」分区,对齐高保真原型「Pi Providers 设置 v1"):默认模型级联下拉 +
// 供应商管理**内联平铺**(订阅登录 / API Key / 云平台 / 自定义四区,见 PiProvidersSection)——
// 旧的 ProviderManagerModal 弹窗已删除。本页只做供应商接入与默认模型;思考强度 / System Prompt /
// 工具审批等行为设置卡片已按原型移除(piThinkingDefault 等 store 字段仍在,由会话内控件消费)。
//
// 这里配的供应商供内置 agent「Cortex」(技术标识符 pi)使用;tab 枚举值仍为 "pi",只有显示名改了。
function ModelsSection() {
  const { t } = useTranslation("settings");

  return (
    <>
      <div className="pw-dlg-title">{t("pi.title")}</div>
      <div className="pw-dlg-desc">{t("pi.desc")}</div>

      {/* 默认模型:写 PersistedState.defaultModelRef(主进程 providers/default-model.ts 读
          同一字段,是 Reply / Research / 做梦蒸馏的兜底源)。候选只含「认证可用 ∧ 未隐藏」
          的供应商;引用悬空时阻断提示,**不自动回退到任何模型**(计划 §5)。 */}
      <SettingCard title={t("pi.defaultProviderCard")}>
        <DefaultModelSelects />
      </SettingCard>

      {/* 供应商接入平铺在本页完成:登录/粘贴 Key 即保存,改动即刻反映到上面的默认模型候选。 */}
      <PiProvidersSection />
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
  const { wecom, dingtalk, feishu, internal, email } = push;

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
      // 与 PromptPanel/持久化同源:Skills 库树为全部文件(scanDirTree),不再仅 .md,避免写回后被 md-only 覆盖。
      setPromptTree(await bridge.scanDirTree(promptRoot));
    } catch {
      // 重扫失败不影响已写入的 skill 生效。
    }
  };

  const setWecom = (patch: Partial<WecomPushConfig>) =>
    setPush({ wecom: { enabled: false, webhookUrl: "", ...wecom, ...patch } });
  const setDingtalk = (patch: Partial<DingtalkPushConfig>) =>
    setPush({ dingtalk: { enabled: false, webhookUrl: "", ...dingtalk, ...patch } });
  const setFeishu = (patch: Partial<FeishuPushConfig>) =>
    setPush({ feishu: { enabled: false, webhookUrl: "", ...feishu, ...patch } });
  const setInternal = (patch: Partial<InternalNotifyConfig>) =>
    setPush({ internal: { enabled: false, ...internal, ...patch } });
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

        <SwitchRow label={t("push.feishu")} value={!!feishu?.enabled} onChange={(v) => setFeishu({ enabled: v })} />
        {feishu?.enabled ? (
          <>
            <SRow label={t("push.webhookUrl")}>
              <input
                className="pw-set-input"
                value={feishu.webhookUrl}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
                spellCheck={false}
                onChange={(e) => setFeishu({ webhookUrl: e.target.value })}
              />
            </SRow>
            <SRow label={t("push.feishuSecret")} desc={t("push.feishuSecretDesc")}>
              <input
                className="pw-set-input"
                type="password"
                value={feishu.secret ?? ""}
                placeholder="…"
                onChange={(e) => setFeishu({ secret: e.target.value })}
              />
            </SRow>
          </>
        ) : null}

        <SwitchRow
          label={t("push.internal")}
          desc={t("push.internalDesc")}
          value={!!internal?.enabled}
          onChange={(v) => setInternal({ enabled: v })}
        />

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

export function PersonalSettingsView() {
  const { t } = useTranslation("settings");
  const closeSettings = usePersonalStore((s) => s.closeSettings);
  // 外部入口（快捷回复气泡「去设置」等）指定的目标分区；变化时跳转到对应 tab。
  const settingsTab = usePersonalStore((s) => s.settingsTab);
  const bridge = useDesktopBridge();
  const [tab, setTab] = useState<SettingsTab>("profile");
  const backRef = useRef<HTMLButtonElement>(null);

  // 快捷回复分区仅 macOS + 桥接可用时出现（非 mac / Web 隐藏整分区，含左栏入口）。
  const replyAvailable = useMemo(() => detectIsMac() && !!bridge?.replyGetPermissions, [bridge]);
  // 用户记忆分区仅桌面端桥接可用时出现（Web/旧壳无 memory* 方法 → 隐藏整分区）。
  const memoryAvailable = useMemo(() => !!bridge?.memoryGet, [bridge]);
  // 研究引擎分区仅在壳提供 research 子桥时出现（Web/旧壳没有 → 开关开了也无处生效，隐藏整分区）。
  const researchAvailable = useMemo(() => !!bridge?.research, [bridge]);
  // 知识库分区仅在壳提供 knowledge 子桥时出现（Web/旧壳没有 → 配了也无处生效，隐藏整分区）。
  const knowledgeAvailable = useMemo(() => !!bridge?.knowledge, [bridge]);

  // 消费 store 的目标分区跳转（openSettings(tab) 设入）：合法且可见的 tab 才切换。
  // 依赖 replyAvailable 保证 reply 分区在门控通过后才跳转，避免跳到被隐藏的分区。
  useEffect(() => {
    if (!settingsTab) return;
    if (settingsTab === "reply" && !replyAvailable) return;
    if (settingsTab === "memory" && !memoryAvailable) return;
    if (settingsTab === "research" && !researchAvailable) return;
    if (settingsTab === "knowledge" && !knowledgeAvailable) return;
    // 旧调用方可能仍传 "voice" / "stt"；两者统一进入 speech，避免升级后落到默认分区。
    if (settingsTab === "voice" || settingsTab === "stt") setTab("speech");
    else if (settingsTab in TAB_META) setTab(settingsTab as SettingsTab);
  }, [settingsTab, replyAvailable, memoryAvailable, researchAvailable, knowledgeAvailable]);
  // 挂载时把焦点移入覆盖层（返回按钮）,避免键盘焦点停在被遮挡但仍在 DOM 的底层控件上。
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  // ESC 返回;录制/输入态豁免（见 isTypingTarget）。监听 window:HotkeyCapture 的合成事件
  // stopPropagation 拦不住原生 window 监听,故只能靠 activeElement 守卫避免误关。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isSettingsTypingTarget(document.activeElement)) return;
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
        {NAV_GROUPS.map((group) => (
          <div key={group.groupKey} className="pw-dlg-nav-group">
            <div className="pw-dlg-nav-h">{t(group.groupKey)}</div>
            {group.items
              .filter((id) => id !== "reply" || replyAvailable)
              .filter((id) => id !== "memory" || memoryAvailable)
              .filter((id) => id !== "research" || researchAvailable)
              .filter((id) => id !== "knowledge" || knowledgeAvailable)
              .map((id) => (
              <button
                key={id}
                className={`pw-dlg-nav-item ${tab === id ? "is-active" : ""}`}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => setTab(id)}
              >
                {TAB_META[id].icon}
                {t(TAB_META[id].tabKey)}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="pw-dlg-body">
        {/* 修改任一设置后顶部右侧浮出「已自动保存」反馈（store 切片变化驱动）。 */}
        <SettingsSavedIndicator />
        <div className="pw-settings-content">
          {tab === "profile" ? (
            <ProfileSection />
          ) : tab === "general" ? (
            <GeneralSection />
          ) : tab === "memory" ? (
            <MemorySettingsSection />
          ) : tab === "archivedSessions" ? (
            <ArchivedSessionsSection />
          ) : tab === "agent" ? (
            <AgentSection />
          ) : tab === "subagents" ? (
            <SubagentSettingsSection />
          ) : tab === "pi" ? (
            <ModelsSection />
          ) : tab === "pet" ? (
            <PetSettingsSection />
          ) : tab === "timeline" ? (
            <TimelineSection />
          ) : tab === "push" ? (
            <PushSection />
          ) : tab === "plugins" ? (
            <PluginManager />
          ) : tab === "browser" ? (
            <BrowserSection />
          ) : tab === "mediaGen" ? (
            <MediaGenSection />
          ) : tab === "speech" ? (
            <SpeechSettingsSection />
          ) : tab === "reply" ? (
            <ReplySection />
          ) : tab === "roles" ? (
            <RolesSection />
          ) : tab === "design" ? (
            <DesignSettingsSection />
          ) : tab === "writing" ? (
            <WritingSettingsSection />
          ) : tab === "research" ? (
            <ResearchSettingsSection />
          ) : tab === "knowledge" ? (
            <KnowledgeSettingsSection />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SettingsMenu({ variant = "row" }: { variant?: "row" | "shortcut" }) {
  const { t } = useTranslation();
  const openSettings = usePersonalStore((s) => s.openSettings);
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  if (variant === "shortcut") {
    return (
      <button
        className={`pw-sidebar-shortcut ${settingsOpen ? "is-active" : ""}`}
        onClick={() => openSettings()}
        aria-label={t("sidebar.settings")}
      >
        <Icon.Settings size={15} />
        <span>{t("sidebar.settings")}</span>
      </button>
    );
  }
  return (
    <div className="sb-foot">
      <button className="sb-row is-mute" onClick={() => openSettings()}>
        <Icon.Settings size={15} />
        <span className="label">{t("sidebar.settings")}</span>
      </button>
    </div>
  );
}
