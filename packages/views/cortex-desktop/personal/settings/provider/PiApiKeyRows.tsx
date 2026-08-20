// 「API Key」分区的行式列表。原先内联在 PiProvidersSection，因该文件逼近行数上限而独立，
// 形态对齐同目录的 PiProviderCloudRows。
//
// ── 四条界面约定（都是从实际反馈倒推出来的） ────────────────────────────────
// ① **列骨架恒定**：已配置行与未配置行走同一套 grid（名称 / 中间态 / 操作），右侧操作区固定末列。
//    此前两种形态各自 flex 布局，按钮在不同行左右漂移，26 行看下来像被打乱的表格。
// ② **「配置」是唯一入口**：不管配没配过，行内都只有一个「配置」按钮（此前已配置行叫「更换」、
//    未配置行叫「配置」，同一件事两个名字）。点开一次给全两个字段：API Key 与 Base URL。
//    Base URL 不再单独占一个图标按钮 —— 那让「改地址」和「改密钥」看起来像两件不相干的事。
// ③ **空 = 不改动**：两个输入框都遵循同一条规则，留空就跳过该项，不会把已存的值清掉。
//    销毁是显式动作，各有自己的两步确认按钮（清除密钥 / 清除覆盖）。
// ④ **一行一个保存**：保存按钮只存在于展开区，且一次提交本行全部脏改动（见 useProviderRowSave）。

import { useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDesktopBridge } from "@cortex-work/core";
import { BaseUrlOverride, useBaseUrlDraft } from "./BaseUrlOverride";
import { ProviderTestControl } from "./ProviderTestControl";
import { HiddenToggle, ModelsPopover, authResetKey, useArmedConfirm } from "./PiProvidersSection";
import { useProviderRowSave } from "./useProviderRowSave";
import {
  authStatusKey,
  credentialDeletable,
  providerUsable,
  useProviderAuthActions,
  type ProviderView,
} from "./useProviderData";

/**
 * API Key 行。行内形态按状态区分，但操作入口统一：
 *   已配置   → 凭据来源徽标 + 测试 + 配置；
 *   未配置   → 配置；
 *   免认证（auth 为空）→ 「本地端点」说明 + 测试 + 配置（仍可能要改 Base URL）。
 */
export function ApiKeyRow({
  view,
  hiddenIds,
  storageAvailable,
}: {
  view: ProviderView;
  hiddenIds: string[];
  storageAvailable: boolean;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const { logout } = useProviderAuthActions();

  const { provider, status } = view;
  const on = providerUsable(view);
  const noAuth = provider.auth.length === 0;
  const statusKey = authStatusKey(status);
  const deletable = credentialDeletable(status);
  const confirmClearKey = useArmedConfirm(authResetKey(status));

  // 已设过覆盖的行默认展开配置区 —— 否则「这个供应商没走官方端点」这件事在界面上完全不可见。
  const [editing, setEditing] = useState(!!status.baseUrlOverride);
  const baseUrl = useBaseUrlDraft(provider.id, status.baseUrlOverride);
  const rowSave = useProviderRowSave(provider.id, baseUrl);
  // 免认证的本地端点没有密钥可填，配置区只给 Base URL。
  const canEditKey = !noAuth;

  const testContext = {
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    baseUrlOverride: status.baseUrlOverride,
    authSource: status.source,
    authType: status.type,
  };

  return (
    <div className={`pw-pip-row ${on ? "is-on" : ""}`}>
      {/* 独立的 grid 变体：网关 / 自定义分区仍用 flex 版 .pw-pip-row-main（子元素数量不同，套 grid 会错列）。 */}
      <div className="pw-pip-row-main pw-pip-row-grid">
        <div className="pw-pip-row-info">
          <span className={`pw-pip-dot ${on ? "is-on" : ""}`} />
          <span className="pw-pip-row-name">{provider.name}</span>
          <ModelsPopover view={view} />
        </div>

        {/* 中间列：状态。Base URL 覆盖收进配置区后，这里的徽标是它在行上的唯一线索。 */}
        <div className="pw-pip-row-mid">
          {noAuth && !status.configured ? (
            <span className="pw-pip-row-hint">{t("providers.authNoMethod")}</span>
          ) : status.configured ? (
            <span className={`pw-prov-status is-${statusKey}`}>{t(`providers.status.${statusKey}`)}</span>
          ) : null}
          {status.baseUrlOverride ? (
            <span className="pw-prov-badge" title={status.baseUrlOverride}>
              {t("providers.inline.baseUrlSet")}
            </span>
          ) : null}
        </div>

        {/* 操作列：宽度自适应但恒在末列，各行按钮因此竖直对齐。 */}
        <div className="pw-pip-row-actions">
          {status.configured || noAuth ? (
            <ProviderTestControl
              providerId={provider.id}
              modelId={provider.models[0]?.id ?? ""}
              modelIds={provider.models.map((m) => m.id)}
              context={testContext}
            />
          ) : null}
          <button
            type="button"
            className={`pw-pip-ghost ${editing ? "is-on" : ""}`}
            aria-expanded={editing}
            disabled={!storageAvailable && canEditKey}
            onClick={() => setEditing((v) => !v)}
          >
            {t("providers.inline.configure")}
          </button>
          <span className="pw-pip-iconset">
            <HiddenToggle view={view} hiddenIds={hiddenIds} />
          </span>
        </div>
      </div>

      {/* 配置区：一次给全两个字段 + 本行唯一的保存按钮。 */}
      {editing ? (
        <div className="pw-pip-row-expand">
          {canEditKey ? (
            <label className="pw-set-field">
              <span className="pw-set-lbl">{t("providers.apiKey")}</span>
              <input
                className="pw-set-input"
                type="password"
                value={rowSave.keyDraft}
                // 已配置时明说「留空不改」：密钥保存后不再回显，空输入框很容易被读成「已被清空」。
                placeholder={status.configured ? t("providers.apiKeyKeepPlaceholder") : t("providers.apiKeyPlaceholder")}
                aria-label={`${provider.name} ${t("providers.apiKey")}`}
                spellCheck={false}
                autoComplete="off"
                autoFocus
                disabled={!storageAvailable}
                onChange={(e) => rowSave.setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && rowSave.canSave) rowSave.save();
                }}
              />
            </label>
          ) : null}

          <BaseUrlOverride
            catalogBaseUrl={provider.baseUrl}
            supported={!!bridge?.providerAuthSetBaseUrl}
            draft={baseUrl}
          />

          <div className="pw-pip-row-expand-foot">
            <button
              type="button"
              className={`pw-pip-primary ${rowSave.canSave ? "" : "is-idle"}`}
              disabled={!rowSave.canSave}
              onClick={rowSave.save}
            >
              {t("providers.inline.save")}
            </button>
            <button type="button" className="pw-pip-linkbtn" onClick={() => setEditing(false)}>
              {t("providers.inline.cancel")}
            </button>
            <span className="pw-pip-spacer" />
            {/* 销毁类动作靠右，与「保存」拉开距离，避免手滑。留空只是不改动，清除必须显式点。 */}
            {status.baseUrlOverride && bridge?.providerAuthSetBaseUrl ? (
              <button type="button" className="pw-pip-linkbtn" disabled={baseUrl.pending} onClick={baseUrl.clear}>
                {t("providers.baseUrlOverrideClear")}
              </button>
            ) : null}
            {status.configured ? (
              <button
                type="button"
                className={`pw-pip-linkbtn is-danger ${confirmClearKey.armed ? "is-confirming" : ""}`}
                // env / ambient 凭据由宿主环境提供，Cortex 只能读不能删——禁用并在 title 说明。
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
        </div>
      ) : null}

      {status.error ? <div className="pw-prov-alert is-warn">{t("providers.authError", { error: status.error })}</div> : null}
      {!deletable && status.configured ? (
        <div className="pw-set-hint">{t("providers.ambientReadOnly", { source: status.source })}</div>
      ) : null}
    </div>
  );
}
