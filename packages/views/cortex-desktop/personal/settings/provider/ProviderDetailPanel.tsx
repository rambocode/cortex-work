// 内建 Provider 详情面板：认证（登录 / API Key / 注销）+ 显示隐藏偏好 + 连接测试 +
// 高级 baseUrl 覆盖 + 只读模型列表。
//
// 与旧版的关键差异（都是事故根因或安全问题的直接修复）：
//   · 删除模型增删、能力 checkbox、上下文手填 —— 能力只读，见 ProviderModelList 文件头。
//   · 删除「启用」开关 —— 旧 `enabled` 把「有没有凭据」和「要不要出现在选择器里」混成一个开关。
//     现在拆成两件事：认证状态由主进程判定（只读展示），显示与否是用户偏好（providerAuthSetHidden）。
//   · API Key 只写不读 —— 保存后界面永远拿不回明文，桥上只过 configured/type/source。
//   · ambient / env 凭据不可删 —— 那是宿主环境（shell、AWS profile、gcloud ADC）给的，
//     Cortex 删不掉也不该假装能删；按钮禁用并说明去哪儿删。
//   · 连接测试**必须**先弹费用确认 —— 它是真实的模型调用；保存配置绝不自动测试。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDesktopBridge } from "@cortex-work/core";
import type { ProviderConnectionTestResult } from "@cortex-work/core/desktop/provider-catalog";
import { ProviderModelList } from "./ProviderModelList";
import { ProviderAuthDialog } from "./ProviderAuthDialog";
import { credentialDeletable, useProviderAuthActions, type ProviderView } from "./useProviderData";

type TestState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | { kind: "done"; result: ProviderConnectionTestResult };

export function ProviderDetailPanel({
  view,
  hiddenIds,
  /** safeStorage 是否可用。false → 只读降级：禁止新增/修改密钥（且绝不明文回写）。 */
  storageAvailable,
}: {
  view: ProviderView;
  hiddenIds: string[];
  storageAvailable: boolean;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const { setApiKey, logout, setHidden } = useProviderAuthActions();
  const [keyDraft, setKeyDraft] = useState("");
  const [savedTick, setSavedTick] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [confirmLogout, setConfirmLogout] = useState(false);

  const { provider, status, hidden } = view;
  const supportsApiKey = provider.auth.includes("api-key");
  const supportsOAuth = provider.auth.includes("oauth");
  const deletable = credentialDeletable(status);
  const readOnlyKeys = !storageAvailable;

  const statusKey =
    status.source === "safe-storage"
      ? status.type === "oauth"
        ? "oauth"
        : "safeStorage"
      : status.source === "env"
        ? "env"
        : status.source === "ambient"
          ? "ambient"
          : "none";

  const expiry = status.expiresAt
    ? t("providers.expiresAt", { time: new Date(status.expiresAt).toLocaleString() })
    : "";

  const runTest = async () => {
    setTest({ kind: "running" });
    const res =
      (await bridge?.providerConnectionTest?.(provider.id, provider.models[0]?.id)) ??
      ({ ok: false, error: "unsupported" } satisfies ProviderConnectionTestResult);
    setTest({ kind: "done", result: res });
  };

  const toggleHidden = () => {
    const next = hidden ? hiddenIds.filter((id) => id !== provider.id) : [...hiddenIds, provider.id];
    setHidden.mutate(next);
  };

  return (
    <div className="pw-prov-detail">
      <div className="pw-prov-detail-head">
        <span className="pw-prov-detail-title">{provider.name}</span>
        <span className={`pw-prov-status is-${statusKey}`}>{t(`providers.status.${statusKey}`)}</span>
        <span className="pw-ml-edit-spacer" />
        <button type="button" className="pw-mode-block-btn" onClick={toggleHidden}>
          {hidden ? <Icon.Eye size={12} /> : <Icon.EyeOff size={12} />}
          {hidden ? t("providers.unhide") : t("providers.hide")}
        </button>
      </div>

      <div className="pw-set-hint">
        {t(`providers.statusHint.${statusKey}`, {
          expiry,
          vars: (provider.envVars ?? []).join(", "),
        })}
      </div>
      {status.error ? <div className="pw-prov-alert is-warn">{t("providers.authError", { error: status.error })}</div> : null}

      {readOnlyKeys ? <div className="pw-prov-alert is-warn">{t("providers.storageUnavailable", { reason: "" })}</div> : null}

      {provider.auth.length === 0 ? <div className="pw-set-hint">{t("providers.authNoMethod")}</div> : null}

      {supportsOAuth ? (
        <div className="pw-prov-row">
          <button type="button" className="pw-mode-block-btn primary" onClick={() => setAuthOpen(true)}>
            {status.configured ? t("providers.loginAgain") : t("providers.login")}
          </button>
        </div>
      ) : null}

      {supportsApiKey ? (
        <div className="pw-prov-row">
          <label className="pw-set-field">
            <span className="pw-set-lbl">{t("providers.apiKey")}</span>
            <input
              className="pw-set-input"
              type="password"
              value={keyDraft}
              placeholder={t("providers.apiKeyPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              disabled={readOnlyKeys}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="pw-mode-block-btn primary"
            disabled={readOnlyKeys || !keyDraft.trim() || setApiKey.isPending}
            onClick={() => {
              setApiKey.mutate(
                { providerId: provider.id, apiKey: keyDraft.trim() },
                {
                  onSuccess: () => {
                    setKeyDraft(""); // 保存即清空草稿：明文不在 renderer 内存里多留一秒
                    setSavedTick(true);
                  },
                },
              );
            }}
          >
            {savedTick && !keyDraft ? t("providers.apiKeySaved") : t("providers.apiKeySave")}
          </button>
          <div className="pw-set-hint">{t("providers.apiKeyNeverShown")}</div>
        </div>
      ) : null}

      {status.configured ? (
        <div className="pw-prov-row">
          <button
            type="button"
            className={`pw-mode-block-btn ${confirmLogout ? "is-confirming" : ""}`}
            // ambient / env 来源的凭据不是 Cortex 存的，删不掉；禁用并用 title 说明去哪儿删。
            disabled={!deletable || logout.isPending}
            title={deletable ? undefined : t("providers.ambientReadOnly", { source: status.source })}
            onBlur={() => setConfirmLogout(false)}
            onClick={() => (confirmLogout ? logout.mutate(provider.id) : setConfirmLogout(true))}
          >
            <Icon.LogOut size={12} />
            {confirmLogout ? t("providers.logoutConfirm") : t("providers.logout")}
          </button>
          {!deletable ? (
            <div className="pw-set-hint">{t("providers.ambientReadOnly", { source: status.source })}</div>
          ) : null}
        </div>
      ) : null}

      <ConnectionTest
        state={test}
        setState={setTest}
        modelId={provider.models[0]?.id ?? ""}
        disabled={!bridge?.providerConnectionTest}
        onRun={runTest}
      />

      <details className="pw-prov-advanced">
        <summary>{t("providers.advanced")}</summary>
        <BaseUrlOverride
          providerId={provider.id}
          catalogBaseUrl={provider.baseUrl}
          override={status.baseUrlOverride}
          // 旧壳 / Web 端没有这个 IPC：降级成禁用 + 说明，而不是「能填但不生效」——
          // 后者会让用户以为配好了自建网关，实际请求还发往官方端点。
          supported={!!bridge?.providerAuthSetBaseUrl}
        />
      </details>

      <ProviderModelList models={provider.models} />

      {authOpen ? (
        <ProviderAuthDialog providerId={provider.id} providerName={provider.name} onClose={() => setAuthOpen(false)} />
      ) : null}
    </div>
  );
}

/**
 * 连接测试：**调用前必须过一道费用确认**。这不是礼貌，是钱——测试会真的向 Provider 发一次
 * 模型请求；用户点「测试」时未必意识到这一点，尤其在按次计费的 Provider 上。
 */
function ConnectionTest({
  state,
  setState,
  modelId,
  disabled,
  onRun,
}: {
  state: TestState;
  setState: (s: TestState) => void;
  modelId: string;
  disabled: boolean;
  onRun: () => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="pw-prov-row">
      {state.kind === "confirming" ? (
        <div className="pw-prov-alert is-warn" role="alertdialog" aria-label={t("providers.connectionTestCostTitle")}>
          <strong>{t("providers.connectionTestCostTitle")}</strong>
          <div>{t("providers.connectionTestCostBody", { model: modelId })}</div>
          <div className="pw-mode-block-actions">
            <button type="button" className="pw-mode-block-btn primary" autoFocus onClick={() => void onRun()}>
              {t("providers.connectionTestConfirm")}
            </button>
            <button type="button" className="pw-mode-block-btn" onClick={() => setState({ kind: "idle" })}>
              {t("providers.connectionTestCancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="pw-mode-block-btn"
          disabled={disabled || state.kind === "running"}
          onClick={() => setState({ kind: "confirming" })}
        >
          <Icon.Lightning size={12} />
          {state.kind === "running" ? t("providers.connectionTesting") : t("providers.connectionTestRun")}
        </button>
      )}
      {state.kind === "done" ? (
        <div className={`pw-prov-alert ${state.result.ok ? "is-ok" : "is-error"}`}>
          {state.result.ok
            ? t("providers.connectionTestOk", {
                model: state.result.modelId ?? modelId,
                latency: state.result.latencyMs ?? 0,
              })
            : t("providers.connectionTestFailed", { error: state.result.error ?? "" })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 高级：Base URL 覆盖（自建网关 / 代理端点）。
 *
 * 落盘在 main-owned 的 `provider-prefs.json`，主进程生成 pi extension 时用
 * `getBaseUrlOverride(id) ?? provider.baseUrl` 取值，所以填了是**真的**会作用到请求上。
 *
 * 三条边界：
 *   · 输入清空 = 传 `undefined` 清除覆盖、恢复 Catalog 内置端点（不是存一个空串）；
 *   · 桥不支持（Web 端 / 旧壳）→ 禁用 + 说明，绝不做成「能填但不生效」；
 *   · 草稿只在本地维护，保存后由 `status.baseUrlOverride` 回显——主进程才是真相。
 */
function BaseUrlOverride({
  providerId,
  catalogBaseUrl,
  override,
  supported,
}: {
  providerId: string;
  catalogBaseUrl?: string;
  override?: string;
  supported: boolean;
}) {
  const { t } = useTranslation("settings");
  const { setBaseUrl } = useProviderAuthActions();
  const [draft, setDraft] = useState(override ?? "");
  const [savedTick, setSavedTick] = useState(false);

  // 覆盖值由主进程回读（保存成功后 auth 快照失效重取），据此同步草稿；
  // 用户正在编辑时不覆盖他的输入 —— 只在「远端值变了且与草稿不同」时跟随。
  useEffect(() => {
    setDraft(override ?? "");
    setSavedTick(false);
  }, [override]);

  const trimmed = draft.trim();
  const dirty = trimmed !== (override ?? "");

  return (
    <>
      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("providers.baseUrlOverride")}</span>
        <input
          className="pw-set-input"
          value={draft}
          // placeholder 显示 Catalog 里的官方端点：让用户看清「留空会走哪儿」。
          placeholder={catalogBaseUrl || t("providers.baseUrlOverridePlaceholder")}
          spellCheck={false}
          disabled={!supported}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      {supported ? (
        <div className="pw-mode-block-actions">
          <button
            type="button"
            className="pw-mode-block-btn primary"
            disabled={!dirty || setBaseUrl.isPending}
            onClick={() =>
              setBaseUrl.mutate(
                // 空串 → undefined：语义是「清除覆盖」，而不是「把端点设成空」。
                { providerId, baseUrl: trimmed || undefined },
                { onSuccess: () => setSavedTick(true) },
              )
            }
          >
            {savedTick && !dirty ? t("providers.apiKeySaved") : t("providers.baseUrlOverrideSave")}
          </button>
          {override ? (
            <button
              type="button"
              className="pw-mode-block-btn"
              disabled={setBaseUrl.isPending}
              onClick={() => setBaseUrl.mutate({ providerId, baseUrl: undefined })}
            >
              {t("providers.baseUrlOverrideClear")}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="pw-set-hint">{t("providers.baseUrlOverrideUnavailable")}</div>
      )}
    </>
  );
}
