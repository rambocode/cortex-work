// 「云平台」分区：Bedrock / Azure / Cloudflare / Vertex 等多环境变量 Provider 的折叠行。
//
// 与普通 API Key 行的差异：这些平台的凭据往往不止一个 Key（Region / Account ID / gcloud
// ADC / AWS profile…），其中 Cortex 能代管的只有「API Key / Bearer Token」一项（走
// providerAuthSetApiKey 进 safeStorage）；其余字段一律来自宿主环境变量或云 SDK，
// Cortex 只能标注来源（envVars 列表），**不能**替用户写环境——做成「能填但不生效」的
// 表单是比缺功能更糟的欺骗。Azure 的 resource 端点用「Base URL 覆盖」表达（真实生效，
// 见 BaseUrlOverride 文件头）。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { ProviderTestControl } from "./ProviderTestControl";
import { BaseUrlOverride, useBaseUrlDraft } from "./BaseUrlOverride";
import { useProviderRowSave } from "./useProviderRowSave";
import { HiddenToggle, ModelsPopover, authResetKey, useArmedConfirm } from "./PiProvidersSection";
import {
  authStatusKey,
  credentialDeletable,
  providerUsable,
  useProviderAuthActions,
  type ProviderView,
} from "./useProviderData";
import { useDesktopBridge } from "@cortex-work/core";

export function PiProviderCloudRows({
  views,
  hiddenIds,
  storageAvailable,
}: {
  views: ProviderView[];
  hiddenIds: string[];
  storageAvailable: boolean;
}) {
  // 同一时刻最多展开一行（对齐原型交互）：点开另一行时收起当前行。
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="pw-pip-cloudlist">
      {views.map((v) => (
        <CloudRow
          key={v.provider.id}
          view={v}
          open={openId === v.provider.id}
          onToggle={() => setOpenId(openId === v.provider.id ? null : v.provider.id)}
          hiddenIds={hiddenIds}
          storageAvailable={storageAvailable}
        />
      ))}
    </div>
  );
}

function CloudRow({
  view,
  open,
  onToggle,
  hiddenIds,
  storageAvailable,
}: {
  view: ProviderView;
  open: boolean;
  onToggle: () => void;
  hiddenIds: string[];
  storageAvailable: boolean;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const { logout } = useProviderAuthActions();

  const { provider, status } = view;
  const on = providerUsable(view);
  const statusKey = authStatusKey(status);
  const deletable = credentialDeletable(status);
  const confirmClearKey = useArmedConfirm(authResetKey(status));
  const expiry = status.expiresAt ? t("providers.expiresAt", { time: new Date(status.expiresAt).toLocaleString() }) : "";
  // 密钥与 Base URL 覆盖共用一个保存按钮（见 useProviderRowSave）：
  // 云平台展开体里两者恒同屏，各带一个「保存」时用户无从判断哪个提交了什么。
  const baseUrl = useBaseUrlDraft(provider.id, status.baseUrlOverride);
  const rowSave = useProviderRowSave(provider.id, baseUrl);

  return (
    <div className={`pw-pip-cloud ${open ? "is-open" : ""}`}>
      <button type="button" className="pw-pip-cloud-head" aria-expanded={open} onClick={onToggle}>
        <span className={`pw-pip-dot ${on ? "is-on" : ""}`} />
        <span className="pw-pip-row-name">{provider.name}</span>
        <span className="pw-prov-badge">{t("providers.badgeModels", { count: provider.models.length })}</span>
        <span className="pw-pip-spacer" />
        <span className={`pw-pip-cloud-state ${on ? "is-on" : ""}`}>
          {on ? t("providers.inline.configured") : t("providers.inline.notConfigured")}
        </span>
        <span className={`pw-pip-chev ${open ? "is-open" : ""}`}>
          <Icon.ChevronRight size={12} />
        </span>
      </button>

      {open ? (
        <div className="pw-pip-cloud-body">
          {/* 凭据来源说明：env / ambient 的字段清单（Region、Account、ADC…）都在这里标注。 */}
          <div className="pw-set-hint">
            {t(`providers.statusHint.${statusKey}`, { expiry, vars: (provider.envVars ?? []).join(", ") })}
          </div>
          {status.error ? (
            <div className="pw-prov-alert is-warn">{t("providers.authError", { error: status.error })}</div>
          ) : null}

          {/* 已配置时也照样给输入框（留空即不改动），与 API Key 行的「配置」面板同一套规则：
              此前已配置分支只给一个「更换」，想换个 Key 得先删再填，多一道无谓的破坏性操作。 */}
          {provider.auth.includes("api-key") ? (
            <>
              {status.configured ? (
                <span className={`pw-prov-status is-${statusKey}`}>{t(`providers.status.${statusKey}`)}</span>
              ) : null}
              <label className="pw-set-field">
                <span className="pw-set-lbl">{t("providers.apiKey")}</span>
                <input
                  className="pw-set-input"
                  type="password"
                  value={rowSave.keyDraft}
                  placeholder={
                    status.configured
                      ? t("providers.apiKeyKeepPlaceholder")
                      : (provider.envVars?.[0] ?? t("providers.apiKeyPlaceholder"))
                  }
                  aria-label={`${provider.name} ${t("providers.apiKey")}`}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!storageAvailable}
                  onChange={(e) => rowSave.setKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && rowSave.canSave) rowSave.save();
                  }}
                />
              </label>
            </>
          ) : null}
          {status.configured && !deletable ? (
            <div className="pw-set-hint">{t("providers.ambientReadOnly", { source: status.source })}</div>
          ) : null}

          {/* Azure resource / 自建网关端点走 Base URL 覆盖（落 provider-prefs.json，真实生效）。 */}
          <BaseUrlOverride
            catalogBaseUrl={provider.baseUrl}
            supported={!!bridge?.providerAuthSetBaseUrl}
            draft={baseUrl}
          />

          {/* 本行唯一的保存按钮：一次提交密钥与地址两处脏改动；销毁类动作靠右另放。 */}
          <div className="pw-pip-row-expand-foot">
            <button
              type="button"
              className={`pw-pip-primary ${rowSave.canSave ? "" : "is-idle"}`}
              disabled={!rowSave.canSave}
              onClick={rowSave.save}
            >
              {t("providers.inline.save")}
            </button>
            <span className="pw-pip-spacer" />
            {status.baseUrlOverride && bridge?.providerAuthSetBaseUrl ? (
              <button type="button" className="pw-pip-linkbtn" disabled={baseUrl.pending} onClick={baseUrl.clear}>
                {t("providers.baseUrlOverrideClear")}
              </button>
            ) : null}
            {status.configured ? (
              <button
                type="button"
                className={`pw-pip-linkbtn is-danger ${confirmClearKey.armed ? "is-confirming" : ""}`}
                // env / ambient 凭据由宿主环境提供，Cortex 只能读不能删。
                disabled={!deletable || logout.isPending}
                title={deletable ? undefined : t("providers.ambientReadOnly", { source: status.source })}
                onBlur={confirmClearKey.disarm}
                onClick={() => (confirmClearKey.armed ? logout.mutate(provider.id) : confirmClearKey.arm())}
              >
                {confirmClearKey.armed ? t("providers.inline.clearKeyConfirm") : t("providers.inline.clearKey")}
              </button>
            ) : null}
            {rowSave.error ? <span className="pw-pip-row-error">{rowSave.error}</span> : null}
          </div>

          <div className="pw-pip-cloud-foot">
            <ProviderTestControl
              providerId={provider.id}
              modelId={provider.models[0]?.id ?? ""}
              context={{
                providerName: provider.name,
                baseUrl: provider.baseUrl,
                baseUrlOverride: status.baseUrlOverride,
                authSource: status.source,
                authType: status.type,
              }}
            />
            <span className="pw-pip-spacer" />
            <ModelsPopover view={view} />
            <HiddenToggle view={view} hiddenIds={hiddenIds} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
