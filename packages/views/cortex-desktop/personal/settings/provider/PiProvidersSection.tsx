// 「设置 → Pi」内联的供应商管理平铺页（替代旧 ProviderManagerModal 弹窗）。
//
// 按认证形态分四区（对齐高保真原型「Pi Providers 设置 v1」）：
//   · 订阅登录  —— auth 含 oauth 的 Provider，卡片网格，一键 OAuth（也可改用 API Key）；
//   · API Key   —— 纯 api-key 的 Provider，行式列表，粘贴即存、只写不读；
//   · 云平台    —— Bedrock / Azure / Cloudflare / Vertex 等多环境变量 Provider，折叠行
//                  （凭据常来自宿主环境，Cortex 只能标注来源；额外提供 Base URL 覆盖）；
//   · 自定义    —— 用户粘贴完整 Pi Provider JSON（见 PiCustomProviderSection）。
//
// 继承弹窗时代的四种降级态（不能白屏、不能崩）：Catalog 失败 / 桥不支持 / safeStorage
// 只读 / 旧配置被清理的一次性提示。模型能力仍然**只读**——每行「N 模型」展开的是
// ProviderModelList（系统元数据），不存在任何能力编辑控件（事故根因回归）。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import { ProviderModelList } from "./ProviderModelList";
import { ProviderAuthDialog } from "./ProviderAuthDialog";
import { ProviderTestControl } from "./ProviderTestControl";
import { PiProviderCloudRows } from "./PiProviderCloudRows";
import { PiCustomProviderSection } from "./PiCustomProviderSection";
import {
  authStatusKey,
  credentialDeletable,
  providerUsable,
  useProviderAuthActions,
  useProviderViews,
  type ProviderView,
} from "./useProviderData";

/**
 * 「云平台」分区的成员（按真实 Catalog id 固定枚举）：这些 Provider 的凭据往往不止一个
 * API Key（Region / Account ID / ADC…），来自宿主环境变量或云 SDK，交互形态与普通
 * API Key 行不同，故单独一区用折叠行展示。Catalog 里出现新云平台时在此追加即可。
 */
const CLOUD_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "azure-openai-responses",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "google-vertex",
]);

/** 未搜索、未展开时 API Key 分区默认露出的行数（已配置的行始终露出）。 */
const KEY_ROWS_COLLAPSED = 6;

export function PiProvidersSection() {
  const { t } = useTranslation("settings");
  const { views, loading, catalogError, catalogUnsupported, snapshot } = useProviderViews();
  const [query, setQuery] = useState("");
  const [showAllKeys, setShowAllKeys] = useState(false);
  const legacyCleared = usePersonalStore((s) => s.legacyProviderSettingsCleared);
  const acknowledgeLegacy = usePersonalStore((s) => s.acknowledgeLegacyProviderNotice);

  const storageAvailable = snapshot.health.available;
  const hiddenIds = snapshot.hiddenProviderIds;

  // 四区拆分 + 搜索过滤。分区之间互斥：oauth 优先（订阅），再云平台，剩下全归 API Key
  // （含 auth 为空的免认证本地端点与 ambient-only —— 行内按状态渲染差异）。
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (v: ProviderView) =>
      !q || v.provider.name.toLowerCase().includes(q) || v.provider.id.toLowerCase().includes(q);
    const builtin = views.filter((v) => !v.custom);
    return {
      subs: builtin.filter((v) => v.provider.auth.includes("oauth")).filter(match),
      clouds: builtin
        .filter((v) => !v.provider.auth.includes("oauth") && CLOUD_PROVIDER_IDS.has(v.provider.id))
        .filter(match),
      keys: builtin
        .filter((v) => !v.provider.auth.includes("oauth") && !CLOUD_PROVIDER_IDS.has(v.provider.id))
        .filter(match),
      configured: views.filter(providerUsable).length,
      total: views.length,
    };
  }, [views, query]);

  // API Key 分区折叠规则（对齐原型）：已配置的行始终露出，其余只露前几行，尾部「展开全部」。
  const searching = !!query.trim();
  const keysVisible =
    searching || showAllKeys
      ? groups.keys
      : groups.keys.filter((v, i) => providerUsable(v) || i < KEY_ROWS_COLLAPSED);
  const keysHiddenCount = groups.keys.length - keysVisible.length;

  return (
    <div className="pw-pip">
      {/* 总览行：分区标题 + 配置计数 + 搜索 */}
      <div className="pw-pip-head">
        <span className="pw-pip-title">{t("providers.title")}</span>
        <span className="pw-pip-count">
          {t("providers.inline.counts", { configured: groups.configured, total: groups.total })}
        </span>
        <input
          className="pw-set-input pw-pip-search"
          value={query}
          placeholder={t("providers.search")}
          aria-label={t("providers.search")}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* safeStorage 不可用是全局性的：影响全部密钥输入，警告条置顶。 */}
      {!storageAvailable ? (
        <div className="pw-prov-alert is-warn" role="status">
          {t("providers.storageUnavailable", { reason: snapshot.health.reason ?? "" })}
        </div>
      ) : null}

      {/* 旧 providerSettings 被首启清理 → 一次性告知「请重新登录」，确认后随全量保存落盘。 */}
      {legacyCleared && !legacyCleared.noticeAcknowledged ? (
        <div className="pw-prov-alert is-warn" role="status">
          {t("providers.legacyCleared")}
          <div className="pw-mode-block-actions">
            <button type="button" className="pw-mode-block-btn" onClick={acknowledgeLegacy}>
              {t("providers.legacyClearedDismiss")}
            </button>
          </div>
        </div>
      ) : null}

      {catalogUnsupported ? <div className="pw-set-hint">{t("providers.catalogUnsupported")}</div> : null}
      {catalogError ? (
        <div className="pw-prov-alert is-error" role="alert">
          {t("providers.catalogUnavailable", { error: catalogError })}
        </div>
      ) : null}
      {loading && !catalogUnsupported ? <div className="pw-set-hint">{t("providers.catalogLoading")}</div> : null}

      {searching && groups.subs.length + groups.clouds.length + groups.keys.length === 0 ? (
        <div className="pw-set-hint">{t("providers.searchNoResult")}</div>
      ) : null}

      {/* 订阅登录（OAuth） */}
      {groups.subs.length > 0 ? (
        <div className="pw-pip-sec">
          <div className="pw-pip-sec-h">
            <span className="pw-pip-sec-t">{t("providers.inline.subsTitle")}</span>
            <span className="pw-pip-sec-d">{t("providers.inline.subsDesc")}</span>
          </div>
          <div className="pw-pip-grid">
            {groups.subs.map((v) => (
              <SubscriptionCard key={v.provider.id} view={v} hiddenIds={hiddenIds} storageAvailable={storageAvailable} />
            ))}
          </div>
        </div>
      ) : null}

      {/* API Key */}
      {groups.keys.length > 0 ? (
        <div className="pw-pip-sec">
          <div className="pw-pip-sec-h">
            <span className="pw-pip-sec-t">{t("providers.inline.keysTitle")}</span>
            <span className="pw-pip-sec-d">{t("providers.inline.keysDesc")}</span>
          </div>
          <div className="pw-pip-table">
            {keysVisible.map((v) => (
              <ApiKeyRow key={v.provider.id} view={v} hiddenIds={hiddenIds} storageAvailable={storageAvailable} />
            ))}
            {!searching && (keysHiddenCount > 0 || showAllKeys) ? (
              <button type="button" className="pw-pip-more" onClick={() => setShowAllKeys((s) => !s)}>
                {showAllKeys
                  ? t("providers.inline.collapse")
                  : t("providers.inline.expandAll", { count: groups.keys.length })}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 云平台 */}
      {groups.clouds.length > 0 ? (
        <div className="pw-pip-sec">
          <div className="pw-pip-sec-h">
            <span className="pw-pip-sec-t">{t("providers.inline.cloudTitle")}</span>
            <span className="pw-pip-sec-d">{t("providers.inline.cloudDesc")}</span>
          </div>
          <PiProviderCloudRows views={groups.clouds} hiddenIds={hiddenIds} storageAvailable={storageAvailable} />
        </div>
      ) : null}

      {/* 自定义供应商（含内联 JSON 编辑器；搜索由分区内部自理，因为它的数据源是自定义列表） */}
      <PiCustomProviderSection storageAvailable={storageAvailable} query={query} />
    </div>
  );
}

/** 「在模型选择器中隐藏」的眼睛开关：三个分区的行/卡片共用。隐藏是展示偏好，与认证解耦。 */
export function HiddenToggle({ view, hiddenIds }: { view: ProviderView; hiddenIds: string[] }) {
  const { t } = useTranslation("settings");
  const { setHidden } = useProviderAuthActions();
  const label = view.hidden ? t("providers.unhide") : t("providers.hide");
  return (
    <button
      type="button"
      className={`pw-pip-iconbtn ${view.hidden ? "is-off" : ""}`}
      title={label}
      aria-label={label}
      onClick={() =>
        setHidden.mutate(
          view.hidden ? hiddenIds.filter((id) => id !== view.provider.id) : [...hiddenIds, view.provider.id],
        )
      }
    >
      {view.hidden ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
    </button>
  );
}

/**
 * 「更换 / 注销」两步确认的武装态。第一击武装(按钮变「确认…?」)、二击才执行;
 * 三种途径自动解除,防止红色确认文案卡死在界面上(用户实测:登录完成后残留过):
 *   · 3 秒未二次点击 → 超时解除;
 *   · 认证状态一变(登录/注销/换来源,resetKey 变化)→ 立即解除;
 *   · 失焦解除(调用方在按钮上挂 onBlur={disarm})。
 */
export function useArmedConfirm(resetKey: string): { armed: boolean; arm: () => void; disarm: () => void } {
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [resetKey]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return { armed, arm: () => setArmed(true), disarm: () => setArmed(false) };
}

/** useArmedConfirm 的 resetKey:认证状态的任何变化都解除武装。 */
export function authResetKey(status: ProviderView["status"]): string {
  return `${status.configured}:${status.source}:${status.type ?? ""}`;
}

/**
 * 「N 模型」徽标按钮 + 只读能力列表 popover(用户反馈:展开撑开行/卡片太挤,改浮层)。
 * 能力是系统元数据,这里只有「看」没有「改」。点外部 / ESC 关闭。
 */
export function ModelsPopover({ view }: { view: ProviderView }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="pw-pip-models-wrap" ref={wrapRef}>
      <button
        type="button"
        className="pw-pip-badge-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((s) => !s)}
      >
        {t("providers.badgeModels", { count: view.provider.models.length })}
        <span className={`pw-pip-chev ${open ? "is-open" : ""}`}>
          <Icon.ChevronRight size={10} />
        </span>
      </button>
      {open ? (
        <div
          className="pw-pip-models-pop"
          role="dialog"
          aria-label={t("providers.models.title", { count: view.provider.models.length })}
        >
          <ProviderModelList models={view.provider.models} />
        </div>
      ) : null}
    </span>
  );
}

/** 订阅登录卡片：OAuth 一键登录 / 注销；auth 同时含 api-key 的可切到「改用 API Key」。 */
function SubscriptionCard({
  view,
  hiddenIds,
  storageAvailable,
}: {
  view: ProviderView;
  hiddenIds: string[];
  storageAvailable: boolean;
}) {
  const { t } = useTranslation("settings");
  const { setApiKey, logout } = useProviderAuthActions();
  const [authOpen, setAuthOpen] = useState(false);
  const [keyMode, setKeyMode] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const { provider, status } = view;
  const on = providerUsable(view);
  const statusKey = authStatusKey(status);
  const deletable = credentialDeletable(status);
  const supportsKey = provider.auth.includes("api-key");
  const confirmLogout = useArmedConfirm(authResetKey(status));
  const expiry = status.expiresAt ? t("providers.expiresAt", { time: new Date(status.expiresAt).toLocaleString() }) : "";

  const saveKey = () => {
    const key = keyDraft.trim();
    if (!key) return;
    setApiKey.mutate(
      { providerId: provider.id, apiKey: key },
      // 保存即清空草稿：明文不在 renderer 内存里多留一秒。
      { onSuccess: () => setKeyDraft("") },
    );
  };

  return (
    <div className={`pw-pip-card ${on ? "is-on" : ""}`}>
      <div className="pw-pip-card-head">
        <span className="pw-pip-card-name">{provider.name}</span>
        {on ? (
          <span className="pw-pip-on">
            <span className="pw-pip-dot is-on" />
            {t("providers.inline.loggedIn")}
          </span>
        ) : null}
        <HiddenToggle view={view} hiddenIds={hiddenIds} />
      </div>
      <div className="pw-pip-card-desc">
        {t(`providers.statusHint.${statusKey}`, { expiry, vars: (provider.envVars ?? []).join(", ") })}
      </div>
      {status.error ? <div className="pw-prov-alert is-warn">{t("providers.authError", { error: status.error })}</div> : null}

      <div className="pw-pip-card-foot">
        <ModelsPopover view={view} />
        <span className="pw-pip-spacer" />
        {on ? (
          <>
            <ProviderTestControl providerId={provider.id} modelId={provider.models[0]?.id ?? ""} />
            <button
              type="button"
              className={`pw-pip-linkbtn ${confirmLogout.armed ? "is-confirming" : ""}`}
              // ambient / env 来源的凭据不是 Cortex 存的，删不掉；禁用并说明去哪儿删。
              disabled={!deletable || logout.isPending}
              title={deletable ? undefined : t("providers.ambientReadOnly", { source: status.source })}
              onBlur={confirmLogout.disarm}
              onClick={() => (confirmLogout.armed ? logout.mutate(provider.id) : confirmLogout.arm())}
            >
              {confirmLogout.armed ? t("providers.logoutConfirm") : t("providers.logout")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pw-pip-primary" onClick={() => setAuthOpen(true)}>
              {t("providers.login")}
            </button>
            {supportsKey ? (
              <button type="button" className="pw-pip-linkbtn" onClick={() => setKeyMode((s) => !s)}>
                {t("providers.inline.useApiKey")}
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* 「改用 API Key」的内联输入：只在未配置时出现；保存走同一条 setApiKey 通道。 */}
      {!on && keyMode ? (
        <div className="pw-pip-card-keyrow">
          <input
            className="pw-set-input"
            type="password"
            value={keyDraft}
            placeholder={t("providers.apiKeyPlaceholder")}
            aria-label={t("providers.apiKey")}
            spellCheck={false}
            autoComplete="off"
            disabled={!storageAvailable}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveKey();
            }}
          />
          <button
            type="button"
            className="pw-pip-primary"
            disabled={!storageAvailable || !keyDraft.trim() || setApiKey.isPending}
            onClick={saveKey}
          >
            {t("providers.inline.save")}
          </button>
        </div>
      ) : null}

      {authOpen ? (
        <ProviderAuthDialog providerId={provider.id} providerName={provider.name} onClose={() => setAuthOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * API Key 行。三种形态按状态互斥：
 *   未配置（有 api-key 认证）→ 密码输入 + 保存；
 *   已配置              → 状态徽标 + 测试 + 更换（env/ambient 来源不可删，禁用并说明）；
 *   免认证（auth 为空）  → 「本地端点」说明 + 测试。
 */
function ApiKeyRow({
  view,
  hiddenIds,
  storageAvailable,
}: {
  view: ProviderView;
  hiddenIds: string[];
  storageAvailable: boolean;
}) {
  const { t } = useTranslation("settings");
  const { setApiKey, logout } = useProviderAuthActions();
  const [draft, setDraft] = useState("");

  const { provider, status } = view;
  const on = providerUsable(view);
  const noAuth = provider.auth.length === 0;
  const statusKey = authStatusKey(status);
  const deletable = credentialDeletable(status);
  const confirmReplace = useArmedConfirm(authResetKey(status));

  const saveKey = () => {
    const key = draft.trim();
    if (!key) return;
    // 保存即清空草稿：明文不在 renderer 内存里多留一秒。
    setApiKey.mutate({ providerId: provider.id, apiKey: key }, { onSuccess: () => setDraft("") });
  };

  return (
    <div className={`pw-pip-row ${on ? "is-on" : ""}`}>
      <div className="pw-pip-row-main">
        <span className={`pw-pip-dot ${on ? "is-on" : ""}`} />
        <div className="pw-pip-row-info">
          <span className="pw-pip-row-name">{provider.name}</span>
          <ModelsPopover view={view} />
        </div>

        {status.configured || noAuth ? (
          <>
            {noAuth && !status.configured ? (
              <span className="pw-pip-row-hint">{t("providers.authNoMethod")}</span>
            ) : (
              <span className={`pw-prov-status is-${statusKey}`}>{t(`providers.status.${statusKey}`)}</span>
            )}
            <span className="pw-pip-spacer" />
            <ProviderTestControl providerId={provider.id} modelId={provider.models[0]?.id ?? ""} />
            {status.configured ? (
              <button
                type="button"
                className={`pw-pip-linkbtn ${confirmReplace.armed ? "is-confirming" : ""}`}
                // env / ambient 凭据由宿主环境提供，Cortex 只能读不能删——禁用并在 title 说明。
                disabled={!deletable || logout.isPending}
                title={deletable ? undefined : t("providers.ambientReadOnly", { source: status.source })}
                onBlur={confirmReplace.disarm}
                onClick={() => (confirmReplace.armed ? logout.mutate(provider.id) : confirmReplace.arm())}
              >
                {confirmReplace.armed ? t("providers.inline.replaceConfirm") : t("providers.inline.replace")}
              </button>
            ) : null}
          </>
        ) : (
          <>
            <input
              className="pw-set-input pw-pip-keyinput"
              type="password"
              value={draft}
              placeholder={t("providers.apiKeyPlaceholder")}
              aria-label={`${provider.name} ${t("providers.apiKey")}`}
              spellCheck={false}
              autoComplete="off"
              disabled={!storageAvailable}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveKey();
              }}
            />
            <button
              type="button"
              className="pw-pip-primary"
              disabled={!storageAvailable || !draft.trim() || setApiKey.isPending}
              onClick={saveKey}
            >
              {t("providers.inline.save")}
            </button>
          </>
        )}
        <HiddenToggle view={view} hiddenIds={hiddenIds} />
      </div>
      {status.error ? <div className="pw-prov-alert is-warn">{t("providers.authError", { error: status.error })}</div> : null}
      {!deletable && status.configured ? (
        <div className="pw-set-hint">{t("providers.ambientReadOnly", { source: status.source })}</div>
      ) : null}
    </div>
  );
}
