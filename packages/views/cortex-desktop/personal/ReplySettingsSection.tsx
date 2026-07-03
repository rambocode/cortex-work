// 快捷回复助手（reply）设置分区（U9）。
//
// 结构：触发键 → 权限中心 → 记忆管理（分区 segmented + 手写笔记 + 学习开关）→
//       渠道连接（Slack/Gmail/Lark 粘贴 token 校验）→ 数据清理 → 调试记录。
//
// macOS-only：非 mac 平台或 bridge.reply* 能力缺失（Web 端）时整分区隐藏（返回 null）。
// 与 SttSettingsSection 同构：数据走 useReplyStore（客户端态）+ DesktopBridge（原生能力）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopBridge, usePersonalStore, useReplyStore } from "@cortex-work/core";
import type { ProviderSettings } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type {
  ReplyDraftTriggerKey,
  ReplyVoiceTriggerKey,
  ReplyPermissionKind,
  ReplyPermissionStatus,
  ReplyChannelVerifyResult,
  ReplyDebugEntry,
} from "@cortex-work/core/desktop/types";
import { MEMORY_SCOPES, type MemoryScope } from "@cortex-work/core/reply/memory";
import { CHANNEL_DESCRIPTORS, type ChannelId } from "@cortex-work/core/reply/channels";

import { BareSelect, SecretField, SettingCard, SRow, SwitchRow } from "./settingsControls";
import { detectIsMac } from "./platform";

// 译函数最小签名（与 SettingsMenu 一致，避免引入 react-i18next 的 TFunction 泛型）。
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

// ── 常量 ──────────────────────────────────────────────────────────────────────

// 起草触发键选项（源项目 draftTrigger 默认 ⌘）。
const DRAFT_TRIGGER_KEYS: ReplyDraftTriggerKey[] = ["cmd", "option", "fn"];
// 语音触发键选项（源项目 voiceTrigger 默认 Fn）。
const VOICE_TRIGGER_KEYS: ReplyVoiceTriggerKey[] = ["fn", "rightOption", "cmd"];

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

// ── 权限中心 ──────────────────────────────────────────────────────────────────

function PermissionCenter() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();

  // 权限态经 bridge 异步查询；查询失败时保持空（渲染为「未知」）。
  const [perms, setPerms] = useState<Record<string, ReplyPermissionStatus>>({});

  const refresh = useCallback(async () => {
    if (!bridge?.replyGetPermissions) return;
    try {
      const next = await bridge.replyGetPermissions();
      setPerms(next);
    } catch {
      /* 查询失败保持旧值 */
    }
  }, [bridge]);

  // 进入设置分区即拉一次权限态（授权后用「刷新」按钮重查）。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingCard title={t("reply.permissionsCard")}>
      <div className="pw-srow-desc">{t("reply.permissionsDesc")}</div>
      {PERMISSION_ITEMS.map(({ kind, labelKey }) => {
        const status = perms[kind] ?? "unknown";
        return (
          <SRow key={kind} label={t(labelKey)} end>
            <span className={`pw-perm-badge is-${status}`} data-status={status}>
              {permStatusLabel(t, status)}
            </span>
            {status !== "granted" ? (
              <button
                type="button"
                className="pw-btn-sm"
                onClick={() => void bridge?.replyOpenPermissionSettings?.(kind)}
              >
                {t("reply.grantButton")}
              </button>
            ) : null}
          </SRow>
        );
      })}
      <SRow label="" end>
        <button type="button" className="pw-btn-sm" onClick={() => void refresh()}>
          {t("reply.refreshPermissions")}
        </button>
      </SRow>
    </SettingCard>
  );
}

// ── 记忆管理 ──────────────────────────────────────────────────────────────────

function MemoryManager() {
  const { t } = useTranslation("settings");
  const memory = useReplyStore((s) => s.memory);
  const setMemoryFile = useReplyStore((s) => s.setMemoryFile);
  const learningEnabled = useReplyStore((s) => s.settings.learningEnabled);
  const setSettings = useReplyStore((s) => s.setSettings);

  // 当前编辑的记忆分区（本地 UI 态，默认档案）。
  const [scope, setScope] = useState<MemoryScope>("profile");
  const file = memory[scope];

  return (
    <SettingCard title={t("reply.memoryCard")}>
      <div className="pw-srow-desc">{t("reply.memoryDesc")}</div>

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

      {/* 手写笔记（优先级最高，注入 prompt 时标注冲突以此为准） */}
      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("reply.manualLabel")}</span>
        <textarea
          className="pw-ta pw-reply-memo"
          rows={5}
          value={file.manual}
          placeholder={t("reply.manualPlaceholder")}
          onChange={(e) => setMemoryFile(scope, { manual: e.target.value })}
        />
      </label>

      {/* 自动学习要点：只读展示（由 U10 蒸馏管线写入 auto 区） */}
      <div className="pw-reply-auto">
        <span className="pw-set-lbl">{t("reply.autoLabel")}</span>
        <pre className="pw-reply-auto-body">
          {file.auto.trim().length > 0 ? file.auto : t("reply.autoEmpty")}
        </pre>
      </div>

      {/* 学习开关：仅开启时才蒸馏（KTD8） */}
      <SwitchRow
        label={t("reply.learningLabel")}
        desc={t("reply.learningDesc")}
        value={learningEnabled}
        onChange={(v) => setSettings({ learningEnabled: v })}
      />
    </SettingCard>
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
      <div className="pw-reply-channel-head">
        <span className="pw-reply-channel-name">{displayName}</span>
        {connected ? <span className="pw-perm-badge is-granted">{t("reply.statusGranted")}</span> : null}
      </div>
      <div className="pw-srow-desc">{detail}</div>

      {connected ? (
        <>
          <div className="pw-reply-channel-acct">{t("reply.connectedAs", { name: accountText })}</div>
          <button type="button" className="pw-btn-sm" onClick={() => void handleDisconnect()}>
            {t("reply.disconnectButton")}
          </button>
        </>
      ) : (
        <>
          <SecretField
            label={t("reply.tokenLabel")}
            value={token}
            onChange={setToken}
            placeholder={t("reply.tokenPlaceholder")}
          />
          {error ? <div className="pw-reply-channel-err">{error}</div> : null}
          <button
            type="button"
            className="pw-btn-sm"
            disabled={busy || token.trim().length === 0}
            onClick={() => void handleConnect()}
          >
            {busy ? t("reply.connecting") : t("reply.connectButton")}
          </button>
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
  const clearAllMemory = useReplyStore((s) => s.clearAllMemory);
  const clearAutoRules = useReplyStore((s) => s.clearAutoRules);
  const clearChannelNotes = useReplyStore((s) => s.clearChannelNotes);
  return (
    <SettingCard title={t("reply.cleanupCard")}>
      <div className="pw-srow-desc">{t("reply.cleanupDesc")}</div>
      <SRow label={t("reply.clearMemory")} end>
        <button type="button" className="pw-btn-sm pw-btn-sm--danger" onClick={() => clearAllMemory()}>
          {t("reply.clearMemory")}
        </button>
      </SRow>
      <SRow label={t("reply.clearAutoRules")} end>
        <button type="button" className="pw-btn-sm pw-btn-sm--danger" onClick={() => clearAutoRules()}>
          {t("reply.clearAutoRules")}
        </button>
      </SRow>
      <SRow label={t("reply.clearChannelNotes")} end>
        <button type="button" className="pw-btn-sm pw-btn-sm--danger" onClick={() => clearChannelNotes()}>
          {t("reply.clearChannelNotes")}
        </button>
      </SRow>
    </SettingCard>
  );
}

// ── 调试记录 ──────────────────────────────────────────────────────────────────

function DebugEntryRow({ entry }: { entry: ReplyDebugEntry }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const sourceLabel = entry.source === "ocr" ? t("reply.debugSourceOcr") : t("reply.debugSourceAx");
  const time = new Date(entry.ts).toLocaleTimeString();
  return (
    <div className="pw-reply-dbg">
      <button type="button" className="pw-reply-dbg-head" onClick={() => setOpen((o) => !o)}>
        <span className="pw-reply-dbg-src">{sourceLabel}</span>
        <span className="pw-reply-dbg-time">{time}</span>
        <span className="pw-reply-dbg-toggle">{open ? t("reply.debugCollapse") : t("reply.debugExpand")}</span>
      </button>
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
      <div className="pw-srow-desc">{t("reply.debugDesc")}</div>
      <SRow label="" end>
        <button type="button" className="pw-btn-sm" onClick={() => void refresh()}>
          {t("reply.debugRefresh")}
        </button>
      </SRow>
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
  const chatProviders = useMemo(
    () =>
      (providerSettings?.providers ?? []).filter(
        (p) => p.enabled && p.endpointFormat === "chat_completions",
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
        // 跟随默认但无可用供应商/默认：警示 + 引导去「模型供应商」分区配置。
        <SRow label={t("reply.modelNoneWarn")} end>
          <button type="button" className="pw-btn-sm" onClick={() => openSettings("providers")}>
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
  if (!available) return null;

  return (
    <>
      {/* 生成模型：reply 专属供应商 + 模型直连（KTD3），空=跟随 providerSettings 默认回退链 */}
      <ReplyModelSelector />

      {/* 触发键 */}
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

      <PermissionCenter />
      <MemoryManager />
      <ChannelsSection />
      <DataCleanup />
      <DebugLog />
    </>
  );
}
