// 快捷回复助手（reply）设置分区（U9，视觉重构对齐设计稿「快捷回复设置.dc.html」）。
//
// 结构：sticky 头（标题 + 说明 + 分段导航,滚动 spy 高亮）→
//       生成模型 → 触发键 → 权限中心（进度条 + 状态点）→
//       记忆管理（分区 segmented + 学习要点可编辑 + 学习开关 + 可折叠手写笔记）→
//       渠道连接（暂隐藏，SHOW_REPLY_CHANNELS）→ 数据清理 → 调试记录（仅 devMode）。
//
// macOS-only：非 mac 平台或 bridge.reply* 能力缺失（Web 端）时整分区隐藏（返回 null）。
// 与 SttSettingsSection 同构：数据走 useReplyStore（客户端态）+ DesktopBridge（原生能力）。
//
// 注：设计稿首分区为「生成 Agent」（复用应用默认 Agent），那是迁移前源项目的行为；
// 本仓库 main 侧按 KTD3 走「供应商直连 chat_completions」回退链（见 main/reply/resolve-model.ts），
// 故此处保留功能一致的「生成模型」选择器，仅套用设计稿的版式。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopBridge, usePersonalStore, useReplyStore } from "@cortex-work/core";
import type { ProviderSettings } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type {
  ReplyDraftTriggerKey,
  ReplyVoiceTriggerKey,
  ReplyPermissionKind,
  ReplyPermissionStatus,
  ReplyChannelVerifyResult,
  ReplyDataSummary,
  ReplyDebugEntry,
} from "@cortex-work/core/desktop/types";
import { MEMORY_SCOPES, type MemoryFile, type MemoryScope } from "@cortex-work/core/reply/memory";
import { CHANNEL_DESCRIPTORS, type ChannelId } from "@cortex-work/core/reply/channels";

import { BareSelect, SettingCard, SRow } from "./settingsControls";
import { detectIsMac } from "../shared/platform";

// 译函数最小签名（与 SettingsMenu 一致，避免引入 react-i18next 的 TFunction 泛型）。
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

// ── 常量 ──────────────────────────────────────────────────────────────────────

// 渠道连接分区暂隐藏（缓迁 KTD9）；恢复时改 true 并同步单测 NAV 期望。
export const SHOW_REPLY_CHANNELS = false;

// 起草触发键选项（源项目 draftTrigger 默认 ⌘）。
const DRAFT_TRIGGER_KEYS: ReplyDraftTriggerKey[] = ["cmd", "option", "fn"];
// 语音触发键选项（源项目 voiceTrigger 默认 Fn）。
const VOICE_TRIGGER_KEYS: ReplyVoiceTriggerKey[] = ["fn", "rightOption", "cmd"];

// 分段导航的分区定义：id 同时用作 DOM 锚点（pw-reply-sec-<id>）与 spy 标识，顺序即页面顺序。
type ReplySectionId = "model" | "triggers" | "permissions" | "memory" | "channels" | "data" | "logs";

function buildNavSections(opts: { channels: boolean; debug: boolean }): { id: ReplySectionId; labelKey: string }[] {
  return [
    { id: "model", labelKey: "reply.navModel" },
    { id: "triggers", labelKey: "reply.navTriggers" },
    { id: "permissions", labelKey: "reply.navPermissions" },
    { id: "memory", labelKey: "reply.navMemory" },
    ...(opts.channels ? [{ id: "channels" as const, labelKey: "reply.navChannels" }] : []),
    { id: "data", labelKey: "reply.navData" },
    ...(opts.debug ? [{ id: "logs" as const, labelKey: "reply.navDebug" }] : []),
  ];
}

// spy 判定线（px，相对滚动容器顶部）：略大于 sticky 头高度，与 .pw-reply-sec 的
// scroll-margin-top 配套——锚点跳转落位后目标分区顶部恰在判定线内。
const SPY_OFFSET = 130;

// 触发键 i18n key（cmd/option/fn/rightOption 共用一套「keyXxx」文案）。
function triggerKeyLabel(t: TFunc, key: string): string {
  switch (key) {
    case "cmd": return t("reply.keyCmd");
    case "option": return t("reply.keyOption");
    case "fn": return t("reply.keyFn");
    case "rightOption": return t("reply.keyRightOption");
    default: return key;
  }
}

// 权限项顺序与 i18n key（对应 ReplyPermissionState 的五个字段）。
const PERMISSION_ITEMS: { kind: ReplyPermissionKind; labelKey: string }[] = [
  { kind: "accessibility", labelKey: "reply.permAccessibility" },
  { kind: "screenRecording", labelKey: "reply.permScreen" },
  { kind: "calendar", labelKey: "reply.permCalendar" },
  { kind: "microphone", labelKey: "reply.permMicrophone" },
  { kind: "speechRecognition", labelKey: "reply.permSpeech" },
];

// 权限状态 → 文案 key。
function permStatusLabel(t: TFunc, status: ReplyPermissionStatus): string {
  switch (status) {
    case "granted": return t("reply.statusGranted");
    case "denied": return t("reply.statusDenied");
    case "notDetermined": return t("reply.statusNotDetermined");
    default: return t("reply.statusUnknown");
  }
}

// 分区中文/本地化名（复用 i18n，不硬编码；与 MEMORY_SCOPES 顺序一致）。
function scopeLabel(t: TFunc, scope: MemoryScope): string {
  switch (scope) {
    case "profile": return t("reply.scopeProfile");
    case "core": return t("reply.scopeCore");
    case "im": return t("reply.scopeIm");
    case "email": return t("reply.scopeEmail");
    case "publicVoice": return t("reply.scopePublicVoice");
    default: return scope;
  }
}

// 渠道校验失败结果 → 用户可读错误文案（据 U2 ChannelVerifyError 的 errorKind 分派）。
function channelErrorText(t: TFunc, result: ReplyChannelVerifyResult): string {
  const detail = result.errorDetail ?? "";
  switch (result.errorKind) {
    case "apiError": return t("reply.errApiError", { detail });
    case "httpStatus": return t("reply.errHttpStatus", { detail });
    default: return t("reply.errInvalidResponse");
  }
}

// 分区外壳：提供锚点 id 与 data 标记（spy 扫描用）+ scroll-margin（sticky 头让位）。
function ReplySection({ id, children }: { id: ReplySectionId; children: React.ReactNode }) {
  return (
    <section id={`pw-reply-sec-${id}`} data-reply-section={id} className="pw-reply-sec">
      {children}
    </section>
  );
}

// ── 权限中心 ──────────────────────────────────────────────────────────────────

function PermissionCenter() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();

  // 权限态经 bridge 异步查询；查询失败时保持空（渲染为「未知」）。
  const [perms, setPerms] = useState<Record<string, ReplyPermissionStatus>>({});
  // 查询进行中：驱动头部「刷新」按钮的可见反馈，避免用户点击后界面毫无变化、误以为无响应。
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge?.replyGetPermissions) return;
    setRefreshing(true);
    try {
      const next = await bridge.replyGetPermissions();
      setPerms(next);
    } catch {
      // 查询失败保持旧值（多为 IPC 未就绪等瞬时问题）；不因此卡住用户——
      // 各行仍展示「去授权」直达系统设置，不依赖本次查询结果才能操作。
    } finally {
      setRefreshing(false);
    }
  }, [bridge]);

  // 进入设置分区即拉一次；窗口重获焦点（从系统设置授权回来）时自动重查，免手动刷新。
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const grantedCount = PERMISSION_ITEMS.filter(({ kind }) => perms[kind] === "granted").length;
  const total = PERMISSION_ITEMS.length;

  return (
    // 不用 SettingCard：设计稿的授权进度（计数 + 绿条）与卡片标题同行右对齐，需自定义卡片头。
    <div className="pw-scard">
      <div className="pw-reply-perm-head">
        <div>
          <div className="pw-scard-t">{t("reply.permissionsCard")}</div>
          <div className="pw-srow-desc">{t("reply.permissionsDesc")}</div>
        </div>
        <div className="pw-reply-perm-progress">
          <span className="pw-reply-perm-count">
            {t("reply.permSummary", { granted: grantedCount, total })}
          </span>
          <span className="pw-reply-perm-bar">
            <i style={{ width: `${(grantedCount / total) * 100}%` }} />
          </span>
          {/* 手动重查入口：查询失败时行内按钮已足够操作（直达系统设置），此按钮只用于
              显式重新拉取真实状态（如已在系统设置里授权、回到本页想立即刷新）。 */}
          <button type="button" className="pw-btn-sm" disabled={refreshing} onClick={() => void refresh()}>
            {t("reply.refreshPermissions")}
          </button>
        </div>
      </div>
      {PERMISSION_ITEMS.map(({ kind, labelKey }) => {
        const status = perms[kind] ?? "unknown";
        return (
          <div key={kind} className="pw-reply-perm-row">
            <span className="pw-reply-perm-name">
              <i className={`pw-reply-dot is-${status}`} />
              {t(labelKey)}
            </span>
            <span className="pw-reply-perm-actions">
              <span className={`pw-reply-perm-status is-${status}`}>{permStatusLabel(t, status)}</span>
              {status === "granted" ? null : (
                // 未授权 / 未设置 / 未知(查询失败兜底) 统一给「去授权」直达系统设置——
                // "unknown" 只在查询失败时出现，此时把用户卡在「检查」死循环里没有意义，
                // 直接跳系统设置总是可行的下一步（授权状态回到本页会经 focus 监听自动重查）。
                <button
                  type="button"
                  className="pw-reply-btn-primary"
                  onClick={() => void bridge?.replyOpenPermissionSettings?.(kind)}
                >
                  {t("reply.grantButton")}
                </button>
              )}
            </span>
          </div>
        );
      })}
      <p className="pw-reply-perm-foot">{t("reply.permissionsFoot")}</p>
    </div>
  );
}

// ── 记忆管理 ──────────────────────────────────────────────────────────────────

function MemoryManager() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const memory = useReplyStore((s) => s.memory);
  const setMemoryFile = useReplyStore((s) => s.setMemoryFile);
  const learningEnabled = useReplyStore((s) => s.settings.learningEnabled);
  const historyEnabled = useReplyStore((s) => s.settings.historyEnabled);
  const setSettings = useReplyStore((s) => s.setSettings);

  // 编辑落盘（KTD6 修订）：本地缓存即时更新保证输入流畅；真源写入（bridge.replySetMemoryFile）
  // 按「分区+字段」防抖 400ms 合并连续击键。卸载时冲刷未落盘的最后一笔，避免丢字。
  const pendingWrites = useRef(new Map<string, { scope: MemoryScope; patch: Partial<MemoryFile> }>());
  const writeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const updateMemoryFile = useCallback(
    (targetScope: MemoryScope, patch: Partial<MemoryFile>) => {
      setMemoryFile(targetScope, patch);
      if (!bridge?.replySetMemoryFile) return;
      const key = `${targetScope}:${Object.keys(patch).join(",")}`;
      pendingWrites.current.set(key, { scope: targetScope, patch });
      const existing = writeTimers.current.get(key);
      if (existing) clearTimeout(existing);
      writeTimers.current.set(
        key,
        setTimeout(() => {
          writeTimers.current.delete(key);
          const pending = pendingWrites.current.get(key);
          pendingWrites.current.delete(key);
          if (pending) void bridge.replySetMemoryFile?.(pending.scope, pending.patch);
        }, 400),
      );
    },
    [bridge, setMemoryFile],
  );
  useEffect(
    () => () => {
      // 卸载冲刷：清计时器并把未发送的最后一笔立即写真源。
      for (const timer of writeTimers.current.values()) clearTimeout(timer);
      writeTimers.current.clear();
      for (const { scope: s, patch } of pendingWrites.current.values()) {
        void bridge?.replySetMemoryFile?.(s, patch);
      }
      pendingWrites.current.clear();
    },
    [bridge],
  );

  // 当前编辑的记忆分区（本地 UI 态，默认档案）。
  const [scope, setScope] = useState<MemoryScope>("profile");
  // 手写笔记默认折叠，减少首屏噪音；学习要点更常需要查看/微调。
  const [manualOpen, setManualOpen] = useState(false);
  const file = memory[scope];

  return (
    // 不用 SettingCard：学习开关与标题同行右对齐（对齐设计稿），仿权限中心自定义卡片头。
    <div className="pw-scard">
      <div className="pw-reply-memory-head">
        <div>
          <div className="pw-scard-t">{t("reply.memoryCard")}</div>
          <div className="pw-srow-desc">{t("reply.memoryDesc")}</div>
        </div>
        {/* 学习开关置顶右：仅开启时才蒸馏（KTD8） */}
        <div className="pw-reply-memory-learning">
          <div className="pw-reply-memory-learning-text">
            <span className="pw-srow-lbl">{t("reply.learningLabel")}</span>
            <span className="pw-srow-desc">{t("reply.learningDesc")}</span>
          </div>
          <button
            type="button"
            className="twk-toggle"
            data-on={learningEnabled ? "1" : "0"}
            role="switch"
            aria-checked={learningEnabled}
            aria-label={t("reply.learningLabel")}
            onClick={() => setSettings({ learningEnabled: !learningEnabled })}
          >
            <i />
          </button>
        </div>
      </div>

      {/* 保存回复历史开关（KTD8 边界修订）：开启时已采纳会话（含对话原文与候选）落本机
          history.json；与学习开关独立门控，数据分区可清空。 */}
      <SRow label={t("reply.historyLabel")} desc={t("reply.historyDesc")} end>
        <button
          type="button"
          className="twk-toggle"
          data-on={historyEnabled ? "1" : "0"}
          role="switch"
          aria-checked={historyEnabled}
          aria-label={t("reply.historyLabel")}
          onClick={() => setSettings({ historyEnabled: !historyEnabled })}
        >
          <i />
        </button>
      </SRow>

      {/* 分区切换：本地化名的 segmented 按钮组 */}
      <div className="pw-reply-scopes" role="tablist" aria-label={t("reply.memoryCard")}>
        {MEMORY_SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === scope}
            className={`pw-reply-scope ${s === scope ? "is-active" : ""}`}
            onClick={() => setScope(s)}
          >
            {scopeLabel(t, s)}
          </button>
        ))}
      </div>

      {/* 学习要点：可编辑（蒸馏管线写入，也允许用户手动校正） */}
      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("reply.autoLabel")}</span>
        <textarea
          className="pw-ta pw-reply-memo"
          rows={5}
          value={file.auto}
          placeholder={t("reply.autoEmpty")}
          onChange={(e) => updateMemoryFile(scope, { auto: e.target.value })}
        />
      </label>

      {/* 手写笔记（优先级最高；默认折叠，位于学习要点之下） */}
      <div className="pw-reply-manual">
        <button
          type="button"
          className="pw-reply-manual-toggle"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((o) => !o)}
        >
          <span className="pw-set-lbl">{t("reply.manualLabel")}</span>
          <span className="pw-reply-manual-action">
            {manualOpen ? t("reply.manualCollapse") : t("reply.manualExpand")}
          </span>
        </button>
        {manualOpen ? (
          <textarea
            className="pw-ta pw-reply-memo"
            rows={5}
            value={file.manual}
            placeholder={t("reply.manualPlaceholder")}
            onChange={(e) => updateMemoryFile(scope, { manual: e.target.value })}
          />
        ) : null}
      </div>

      {/* 数据文件工具行（源项目「打开文件夹 / 立即重新学习」）：紧凑单排，Web 端 bridge 缺失时整行隐藏 */}
      {bridge?.replyOpenDataFolder || bridge?.replyRelearn ? <MemoryTools /> : null}
    </div>
  );
}

/**
 * 记忆数据工具行：在 Finder 打开数据文件夹 + 立即重新学习（依据已落盘回复历史重建语气要点）。
 * relearn 结果以一行小字反馈（成功/无历史/未配置模型/失败原因），错误码映射见 ReplyRelearnResult；
 * 重学后的要点刷新由 main 的 reply:memoryChanged 推送 → 记忆缓存 hydrate 自动完成。
 */
function MemoryTools() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const [relearnBusy, setRelearnBusy] = useState(false);
  const [relearnMsg, setRelearnMsg] = useState<string | null>(null);

  const handleRelearn = useCallback(async () => {
    if (!bridge?.replyRelearn || relearnBusy) return;
    setRelearnBusy(true);
    setRelearnMsg(null);
    try {
      const result = await bridge.replyRelearn();
      if (result.ok) {
        setRelearnMsg(t("reply.relearnDone"));
      } else if (result.error === "no-history" || result.error === "no-samples") {
        setRelearnMsg(t("reply.relearnNoHistory"));
      } else if (result.error === "model-not-configured") {
        setRelearnMsg(t("reply.relearnNoModel"));
      } else {
        setRelearnMsg(t("reply.relearnFailed", { detail: result.error ?? "" }));
      }
    } catch {
      setRelearnMsg(t("reply.relearnFailed", { detail: "" }));
    } finally {
      setRelearnBusy(false);
    }
  }, [bridge, relearnBusy, t]);

  return (
    <div className="pw-reply-memory-tools">
      <span className="pw-srow-desc">{t("reply.memoryFilesDesc")}</span>
      {bridge?.replyOpenDataFolder ? (
        <button
          type="button"
          className="pw-btn-sm"
          onClick={() => void bridge.replyOpenDataFolder?.()}
        >
          {t("reply.openDataFolder")}
        </button>
      ) : null}
      {bridge?.replyRelearn ? (
        <button type="button" className="pw-btn-sm" disabled={relearnBusy} onClick={() => void handleRelearn()}>
          {relearnBusy ? t("reply.relearnBusy") : t("reply.relearnNow")}
        </button>
      ) : null}
      {relearnMsg ? <span className="pw-srow-desc">{relearnMsg}</span> : null}
    </div>
  );
}

// ── 渠道卡片 ──────────────────────────────────────────────────────────────────

function ChannelCard({ id, displayName, detail }: { id: ChannelId; displayName: string; detail: string }) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();

  const connection = useReplyStore((s) => s.channels.connections[id]);
  const note = useReplyStore((s) => s.channels.notes[id]) ?? "";
  const setChannelConnection = useReplyStore((s) => s.setChannelConnection);
  const setChannelCredential = useReplyStore((s) => s.setChannelCredential);
  const disconnectChannel = useReplyStore((s) => s.disconnectChannel);
  const setChannelNote = useReplyStore((s) => s.setChannelNote);

  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = connection?.isConnected === true;

  // 连接：main 侧 fetch 校验 + safeStorage 加密；成功写连接态与密文，失败展示错误。
  const handleConnect = useCallback(async () => {
    if (!bridge?.replyVerifyChannel || token.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.replyVerifyChannel(id, token.trim());
      if (result.ok) {
        setChannelConnection(id, {
          id,
          isConnected: true,
          accountName: result.accountName,
          accountDetail: result.accountDetail,
          connectedAt: Date.now(),
        });
        // 密文可能缺失（加密不可用时 main 侧回空串）；仍记连接态，仅密文置空。
        setChannelCredential(id, { ciphertext: result.ciphertext ?? "" });
        setToken("");
      } else {
        setError(channelErrorText(t, result));
      }
    } catch {
      setError(t("reply.errBridge"));
    } finally {
      setBusy(false);
    }
  }, [bridge, id, token, setChannelConnection, setChannelCredential, t]);

  // 断开：清 main 侧密文（safeStorage 无持久态，形式调用）后清 store 连接态与密文。
  const handleDisconnect = useCallback(async () => {
    try {
      await bridge?.replyDisconnectChannel?.(id);
    } catch {
      /* 忽略：即便 main 侧失败也清本地态 */
    }
    disconnectChannel(id);
    setError(null);
  }, [bridge, id, disconnectChannel]);

  const accountText = connection?.accountDetail
    ? `${connection.accountName ?? ""}（${connection.accountDetail}）`
    : connection?.accountName ?? "";

  return (
    <div className="pw-reply-channel">
      {/* 头行：名称 + 说明在左，连接态胶囊（状态点 + 文案）在右 */}
      <div className="pw-reply-channel-head">
        <div className="pw-reply-channel-titles">
          <span className="pw-reply-channel-name">{displayName}</span>
          <span className="pw-srow-desc">{detail}</span>
        </div>
        <span className={`pw-reply-pill ${connected ? "is-on" : "is-off"}`}>
          <i />
          {connected ? t("reply.statusConnected") : t("reply.statusDisconnected")}
        </span>
      </div>

      {connected ? (
        <div className="pw-reply-channel-acct-row">
          <span className="pw-reply-channel-acct">{t("reply.connectedAs", { name: accountText })}</span>
          <button type="button" className="pw-btn-sm" onClick={() => void handleDisconnect()}>
            {t("reply.disconnectButton")}
          </button>
        </div>
      ) : (
        <>
          {/* token 行：输入 + 显隐切换 + 主按钮「连接」（设计稿同排三件套） */}
          <label className="pw-set-field">
            <span className="pw-set-lbl">{t("reply.tokenLabel")}</span>
            <span className="pw-secret-wrap">
              <input
                className="pw-set-input"
                type={showToken ? "text" : "password"}
                value={token}
                placeholder={t("reply.tokenPlaceholder")}
                spellCheck={false}
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="button" className="pw-secret-toggle" onClick={() => setShowToken((s) => !s)}>
                {showToken ? t("providers.secretHide") : t("providers.secretShow")}
              </button>
              <button
                type="button"
                className="pw-reply-btn-primary"
                disabled={busy || token.trim().length === 0}
                onClick={() => void handleConnect()}
              >
                {busy ? t("reply.connecting") : t("reply.connectButton")}
              </button>
            </span>
          </label>
          {error ? <div className="pw-reply-channel-err">{error}</div> : null}
        </>
      )}

      {/* 渠道备注（数据清理可整体清空） */}
      <SRow label={t("reply.noteLabel")} end>
        <input
          className="pw-set-input"
          value={note}
          placeholder={t("reply.notePlaceholder")}
          onChange={(e) => setChannelNote(id, e.target.value)}
        />
      </SRow>
    </div>
  );
}

function ChannelsSection() {
  const { t } = useTranslation("settings");
  // 只渲染消息类渠道（Slack/Gmail/Lark）；日历渠道不在本分区（KTD9 缓迁）。
  const messagingChannels = useMemo(
    () => CHANNEL_DESCRIPTORS.filter((d) => d.kind === "messaging"),
    [],
  );
  return (
    <SettingCard title={t("reply.channelsCard")}>
      <div className="pw-srow-desc">{t("reply.channelsDesc")}</div>
      {messagingChannels.map((d) => (
        <ChannelCard key={d.id} id={d.id} displayName={d.displayName} detail={d.detail} />
      ))}
    </SettingCard>
  );
}

// ── 数据清理 ──────────────────────────────────────────────────────────────────

function DataCleanup() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const clearAllMemory = useReplyStore((s) => s.clearAllMemory);
  const clearAutoRules = useReplyStore((s) => s.clearAutoRules);
  const clearChannelNotes = useReplyStore((s) => s.clearChannelNotes);

  // 落盘数据摘要（历史/对话记忆条数）：main 侧统计 ~/.cortex-desktop/reply/；bridge 缺失
  //（Web / 旧 preload）时隐藏摘要与对应清理行，天然降级。
  const [summary, setSummary] = useState<ReplyDataSummary | null>(null);
  const refreshSummary = useCallback(() => {
    if (!bridge?.replyGetDataSummary) return;
    bridge
      .replyGetDataSummary()
      .then(setSummary)
      .catch(() => {});
  }, [bridge]);
  useEffect(() => {
    refreshSummary();
  }, [refreshSummary]);

  // 紧凑版式：不再每项一行（标签+描述+按钮太占高度），全部收成一排小危险按钮，
  // 影响范围说明折叠进按钮的 hover title。
  // 记忆清空（KTD6 修订）：真源在 main（bridge.replyClearMemory），本地缓存同步清以即时反馈。
  const actions: { labelKey: string; descKey: string; onClear: () => void }[] = [
    {
      labelKey: "reply.clearMemory",
      descKey: "reply.clearMemoryDesc",
      onClear: () => {
        clearAllMemory();
        void bridge?.replyClearMemory?.("all");
      },
    },
    {
      labelKey: "reply.clearAutoRules",
      descKey: "reply.clearAutoRulesDesc",
      onClear: () => {
        clearAutoRules();
        void bridge?.replyClearMemory?.("auto");
      },
    },
    { labelKey: "reply.clearChannelNotes", descKey: "reply.clearChannelNotesDesc", onClear: clearChannelNotes },
  ];
  // 历史 / 对话记忆清空走 main 侧文件存储（清完即刷新摘要计数）。
  if (bridge?.replyClearHistory) {
    actions.push({
      labelKey: "reply.clearHistory",
      descKey: "reply.clearHistoryDesc",
      onClear: () => {
        void bridge.replyClearHistory?.().then(refreshSummary);
      },
    });
  }
  if (bridge?.replyClearConversationMemory) {
    actions.push({
      labelKey: "reply.clearConversations",
      descKey: "reply.clearConversationsDesc",
      onClear: () => {
        void bridge.replyClearConversationMemory?.().then(refreshSummary);
      },
    });
  }

  return (
    <SettingCard title={t("reply.cleanupCard")}>
      <div className="pw-srow-desc">
        {t("reply.cleanupDesc")}
        {summary
          ? ` ${t("reply.dataSummary", {
              history: summary.historyCount,
              conversations: summary.conversationCount,
            })}`
          : null}
      </div>
      <div className="pw-reply-cleanup-actions">
        {actions.map(({ labelKey, descKey, onClear }) => (
          <button
            key={labelKey}
            type="button"
            className="pw-btn-sm pw-btn-sm--danger"
            title={t(descKey)}
            onClick={onClear}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </SettingCard>
  );
}

// ── 调试记录 ──────────────────────────────────────────────────────────────────

// 1 次唤起会触发 1 条 first + N 条 pregenerate/flip 生成调用，但都复用同一次 capture 结果；
// 徽章展示"调用阶段"（kind）而非 capture 来源（source），避免用户把多次生成误读成多次 OCR/AX 调用。
const DEBUG_KIND_LABEL_KEYS: Record<ReplyDebugEntry["kind"], string> = {
  first: "reply.debugKindFirst",
  pregenerate: "reply.debugKindPregenerate",
  flip: "reply.debugKindFlip",
};

function DebugEntryRow({ entry }: { entry: ReplyDebugEntry }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const kindLabel = t(DEBUG_KIND_LABEL_KEYS[entry.kind]);
  const sourceLabel = entry.source === "ocr" ? t("reply.debugSourceOcr") : t("reply.debugSourceAx");
  const time = new Date(entry.ts).toLocaleTimeString();
  // 有 error 字段即视为失败调用（与 main 侧 debug-log 写入约定一致）。
  const ok = !entry.error;
  return (
    <div className="pw-reply-dbg">
      <div className="pw-reply-dbg-row">
        <span className={`pw-reply-dbg-badge is-${entry.kind}`}>{kindLabel}</span>
        <span className="pw-reply-dbg-src">{sourceLabel}</span>
        <span className="pw-reply-dbg-time">{time}</span>
        <span className={`pw-reply-dbg-status ${ok ? "" : "is-fail"}`}>
          <i />
          {ok ? t("reply.debugStatusOk") : t("reply.debugStatusFail")}
        </span>
        <button type="button" className="pw-reply-dbg-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? t("reply.debugCollapse") : t("reply.debugExpand")}
        </button>
      </div>
      {open ? (
        <div className="pw-reply-dbg-body">
          {entry.systemPrompt || entry.userPrompt ? (
            <>
              <span className="pw-set-lbl">{t("reply.debugPrompt")}</span>
              <pre className="pw-reply-auto-body">{[entry.systemPrompt, entry.userPrompt].filter(Boolean).join("\n\n")}</pre>
            </>
          ) : null}
          {entry.output ? (
            <>
              <span className="pw-set-lbl">{t("reply.debugOutput")}</span>
              <pre className="pw-reply-auto-body">{entry.output}</pre>
            </>
          ) : null}
          {entry.error ? (
            <>
              <span className="pw-set-lbl">{t("reply.debugError")}</span>
              <pre className="pw-reply-auto-body is-error">{entry.error}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DebugLog() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const [entries, setEntries] = useState<ReplyDebugEntry[]>([]);

  const refresh = useCallback(async () => {
    if (!bridge?.replyGetDebugLog) return;
    try {
      setEntries(await bridge.replyGetDebugLog());
    } catch {
      /* 拉取失败保持旧值 */
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingCard title={t("reply.debugCard")}>
      {/* 头行：说明在左，「刷新」在右（设计稿卡片头右侧按钮） */}
      <div className="pw-reply-perm-top">
        <div className="pw-srow-desc">{t("reply.debugDesc")}</div>
        <button type="button" className="pw-btn-sm" onClick={() => void refresh()}>
          {t("reply.debugRefresh")}
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="pw-reply-dbg-empty">{t("reply.debugEmpty")}</div>
      ) : (
        entries.map((e) => <DebugEntryRow key={e.id} entry={e} />)
      )}
    </SettingCard>
  );
}

// ── 生成模型选择器 ─────────────────────────────────────────────────────────────

/**
 * 展示用「跟随供应商默认」回退目标解析：语义与 main 侧 resolve-model.ts 的默认分支（第 2 级）一致——
 * defaultProviderId 对应供应商须「存在 + enabled + endpointFormat==='chat_completions'」，
 * model 取 defaultModel?.trim() 或该供应商 models[0]?.id。任一不成立返回 null（推「未配置可用模型」警示）。
 * 仅用于 UI 呈现回退目标，真正的解析仍在 main 侧起草时执行。
 */
function resolveFollowDefault(
  ps: ProviderSettings | undefined,
): { providerName: string; model: string } | null {
  const providers = ps?.providers ?? [];
  const defaultId = ps?.defaultProviderId?.trim();
  if (!defaultId) return null;
  const p = providers.find((x) => x.id === defaultId);
  if (!p || !p.enabled || p.endpointFormat !== "chat_completions") return null;
  const model = ps?.defaultModel?.trim() || p.models[0]?.id?.trim();
  if (!model) return null;
  return { providerName: p.name, model };
}

// reply 专属生成模型选择器（KTD3）：供应商 + 模型直连，空供应商=跟随 providerSettings 默认回退链。
// 只列 enabled 且 chat_completions 的供应商（与 resolve-model 候选校验一致）；「跟随默认」展示实际回退目标。
function ReplyModelSelector() {
  const { t } = useTranslation("settings");

  // 取全部 providers（不在 selector 内 filter，避免每次返回新数组触发 Zustand 无限循环，同 SttSettingsSection）。
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const openSettings = usePersonalStore((s) => s.openSettings);

  const providerId = useReplyStore((s) => s.settings.providerId);
  const model = useReplyStore((s) => s.settings.model);
  const setSettings = useReplyStore((s) => s.setSettings);

  // 候选供应商：enabled 且 chat_completions（其余 endpointFormat 本期不支持直连）。
  // 另过滤空 models[] 的供应商：选中它模型下拉必为空、main 侧 tryResolve 也解析不出,
  // 提供出来只会造成「UI 显示已选 X、实际落默认链」的静默分歧。
  const chatProviders = useMemo(
    () =>
      (providerSettings?.providers ?? []).filter(
        (p) => p.enabled && p.endpointFormat === "chat_completions" && p.models.length > 0,
      ),
    [providerSettings],
  );

  // 选中的具体供应商；stored providerId 已失效（供应商被删/禁用/改协议）时按「跟随默认」呈现——
  // 与 main 侧回退运行时行为一致（该候选 tryResolve 失败即落默认链），也避免受控 select 值不匹配任何 option。
  const selectedProvider = providerId
    ? chatProviders.find((p) => p.id === providerId)
    : undefined;

  const followTarget = useMemo(() => resolveFollowDefault(providerSettings), [providerSettings]);

  // 供应商下拉：首项「跟随默认」（空值）+ 各 chat 供应商（显示 name）。
  const providerOptions = useMemo(
    () => [
      { label: t("reply.modelFollowDefault"), value: "" },
      ...chatProviders.map((p) => ({ label: p.name, value: p.id })),
    ],
    [chatProviders, t],
  );

  // 切供应商：选空=跟随默认（清专属选择）；选具体供应商则默认取其首个模型 id 一并写入。
  const handleProviderChange = (v: string) => {
    if (!v) {
      setSettings({ providerId: undefined, model: undefined });
      return;
    }
    const p = chatProviders.find((x) => x.id === v);
    setSettings({ providerId: v, model: p?.models[0]?.id });
  };

  return (
    <SettingCard title={t("reply.modelCard")}>
      <div className="pw-srow-desc">{t("reply.modelDesc")}</div>

      <SRow label={t("reply.modelProviderLabel")} end>
        <BareSelect
          value={selectedProvider ? selectedProvider.id : ""}
          options={providerOptions}
          onChange={handleProviderChange}
        />
      </SRow>

      {selectedProvider ? (
        // 具体供应商：列该供应商 models（label 优先，缺省显示 id）。
        <SRow label={t("reply.modelModelLabel")} end>
          <BareSelect
            value={model ?? selectedProvider.models[0]?.id ?? ""}
            options={selectedProvider.models.map((m) => ({ label: m.label ?? m.id, value: m.id }))}
            onChange={(v) => setSettings({ providerId: selectedProvider.id, model: v })}
          />
        </SRow>
      ) : followTarget ? (
        // 跟随默认且可解析：展示实际回退目标（供应商 + 模型）。
        <div className="pw-srow-desc">
          {t("reply.modelFollowTarget", { provider: followTarget.providerName, model: followTarget.model })}
        </div>
      ) : (
        // 跟随默认但无可用供应商/默认：警示 + 引导去「Pi」分区（供应商管理已并入）配置。
        <SRow label={t("reply.modelNoneWarn")} end>
          <button type="button" className="pw-btn-sm" onClick={() => openSettings("pi")}>
            {t("reply.modelGotoProviders")}
          </button>
        </SRow>
      )}
    </SettingCard>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export function ReplySettingsSection() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();

  const draftTrigger = useReplyStore((s) => s.settings.draftTrigger);
  const voiceTrigger = useReplyStore((s) => s.settings.voiceTrigger);
  const setSettings = useReplyStore((s) => s.setSettings);

  // 平台守卫：非 mac 或 bridge.reply 能力缺失（Web 端）→ 整分区隐藏。
  const available = detectIsMac() && !!bridge?.replyGetPermissions;
  // 调试记录仅开发包可见（与 SettingsMenu Agent Trace 同判据：bridge.appInfo.devMode）。
  const showDebugLog = bridge?.appInfo?.devMode === true;
  const navSections = useMemo(
    () => buildNavSections({ channels: SHOW_REPLY_CHANNELS, debug: showDebugLog }),
    [showDebugLog],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<ReplySectionId>("model");

  // 滚动 spy：设置页滚动容器是外层 .pw-dlg-body（本组件不自带滚动），故经 closest 向上取。
  // 判定规则同设计稿：取顶部进入判定线（SPY_OFFSET）内的最后一个分区；滚到底则强制取最后
  // 一个分区（否则短尾分区永远到不了判定线、导航点不亮）。
  useEffect(() => {
    if (!available) return;
    const root = rootRef.current;
    const scroller = root?.closest(".pw-dlg-body");
    if (!root || !scroller) return;
    const onScroll = () => {
      const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-reply-section]"));
      if (sections.length === 0) return;
      let cur = sections[0]!.dataset.replySection as ReplySectionId;
      const base = scroller.getBoundingClientRect().top;
      for (const el of sections) {
        if (el.getBoundingClientRect().top - base <= SPY_OFFSET) {
          cur = el.dataset.replySection as ReplySectionId;
        }
      }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        cur = sections[sections.length - 1]!.dataset.replySection as ReplySectionId;
      }
      setActiveSection(cur);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [available]);

  // 导航跳转：先亮再滚（点击即时反馈）；落位后 spy 会收敛到同一分区。
  const jumpTo = (id: ReplySectionId) => {
    setActiveSection(id);
    document.getElementById(`pw-reply-sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!available) return null;

  return (
    <div ref={rootRef} className="pw-reply-root">
      {/* sticky 头：标题 + 说明 + 分段导航（滚动时吸附在滚动容器顶部） */}
      <div className="pw-reply-head">
        <div className="pw-dlg-title">{t("reply.title")}</div>
        <div className="pw-dlg-desc">{t("reply.desc")}</div>
        <div className="pw-reply-nav">
          {navSections.map(({ id, labelKey }) => (
            <button
              key={id}
              type="button"
              className={`pw-reply-nav-item ${activeSection === id ? "is-active" : ""}`}
              onClick={() => jumpTo(id)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* 生成模型：reply 专属供应商 + 模型直连（KTD3），空=跟随 providerSettings 默认回退链 */}
      <ReplySection id="model">
        <ReplyModelSelector />
      </ReplySection>

      {/* 触发键 */}
      <ReplySection id="triggers">
        <SettingCard title={t("reply.triggersCard")}>
          <SRow label={t("reply.draftTriggerLabel")} desc={t("reply.draftTriggerDesc")} end>
            <BareSelect
              value={draftTrigger}
              options={DRAFT_TRIGGER_KEYS.map((k) => ({ label: triggerKeyLabel(t, k), value: k }))}
              onChange={(v) => setSettings({ draftTrigger: v as ReplyDraftTriggerKey })}
            />
          </SRow>
          <SRow label={t("reply.voiceTriggerLabel")} desc={t("reply.voiceTriggerDesc")} end>
            <BareSelect
              value={voiceTrigger}
              options={VOICE_TRIGGER_KEYS.map((k) => ({ label: triggerKeyLabel(t, k), value: k }))}
              onChange={(v) => setSettings({ voiceTrigger: v as ReplyVoiceTriggerKey })}
            />
          </SRow>
        </SettingCard>
      </ReplySection>

      <ReplySection id="permissions">
        <PermissionCenter />
      </ReplySection>
      <ReplySection id="memory">
        <MemoryManager />
      </ReplySection>
      {SHOW_REPLY_CHANNELS ? (
        <ReplySection id="channels">
          <ChannelsSection />
        </ReplySection>
      ) : null}
      <ReplySection id="data">
        <DataCleanup />
      </ReplySection>
      {showDebugLog ? (
        <ReplySection id="logs">
          <DebugLog />
        </ReplySection>
      ) : null}
    </div>
  );
}
