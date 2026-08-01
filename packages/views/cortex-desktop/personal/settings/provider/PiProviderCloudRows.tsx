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
import { BaseUrlOverride } from "./BaseUrlOverride";
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
  const { setApiKey, logout } = useProviderAuthActions();
  const [draft, setDraft] = useState("");

  const { provider, status } = view;
  const on = providerUsable(view);
  const statusKey = authStatusKey(status);
  const deletable = credentialDeletable(status);
  const confirmReplace = useArmedConfirm(authResetKey(status));
  const expiry = status.expiresAt ? t("providers.expiresAt", { time: new Date(status.expiresAt).toLocaleString() }) : "";

  const saveKey = () => {
    const key = draft.trim();
    if (!key) return;
    // 保存即清空草稿：明文不在 renderer 内存里多留一秒。
    setApiKey.mutate({ providerId: provider.id, apiKey: key }, { onSuccess: () => setDraft("") });
  };

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

          {provider.auth.includes("api-key") ? (
            <div className="pw-pip-cloud-keyrow">
              {status.configured ? (
                <>
                  <span className={`pw-prov-status is-${statusKey}`}>{t(`providers.status.${statusKey}`)}</span>
                  <button
                    type="button"
                    className={`pw-pip-linkbtn ${confirmReplace.armed ? "is-confirming" : ""}`}
                    // env / ambient 凭据由宿主环境提供，Cortex 只能读不能删。
                    disabled={!deletable || logout.isPending}
                    title={deletable ? undefined : t("providers.ambientReadOnly", { source: status.source })}
                    onBlur={confirmReplace.disarm}
                    onClick={() => (confirmReplace.armed ? logout.mutate(provider.id) : confirmReplace.arm())}
                  >
                    {confirmReplace.armed ? t("providers.inline.replaceConfirm") : t("providers.inline.replace")}
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="pw-set-input pw-pip-keyinput"
                    type="password"
                    value={draft}
                    placeholder={provider.envVars?.[0] ?? t("providers.apiKeyPlaceholder")}
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
            </div>
          ) : null}
          {status.configured && !deletable ? (
            <div className="pw-set-hint">{t("providers.ambientReadOnly", { source: status.source })}</div>
          ) : null}

          {/* Azure resource / 自建网关端点走 Base URL 覆盖（落 provider-prefs.json，真实生效）。 */}
          <BaseUrlOverride
            providerId={provider.id}
            catalogBaseUrl={provider.baseUrl}
            override={status.baseUrlOverride}
            supported={!!bridge?.providerAuthSetBaseUrl}
          />

          <div className="pw-pip-cloud-foot">
            <ProviderTestControl providerId={provider.id} modelId={provider.models[0]?.id ?? ""} />
            <span className="pw-pip-spacer" />
            <ModelsPopover view={view} />
            <HiddenToggle view={view} hiddenIds={hiddenIds} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
