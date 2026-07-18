import { useState } from "react";

import { DEFAULT_BROWSER_CONTROL, useCortexUIStore, useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { BrowserControlSettings } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { normalizeOrigin } from "@cortex-work/core/personal/browserOrigin";

import { BareSelect, SettingCard, SRow, SwitchRow } from "./settingsControls";

// 浏览器设置页（应用 → 浏览器,对标 Codex 布局,诚实对齐 cortex 能力）。
// 五分区:总开关 / General(本地URL打开目标 / 清除数据 / 批注截图)/ 权限(导航授权范围)/
// 网站权限(预授权 origin 白名单)/ 开发者模式(完整 CDP)。读写 generalSettings.browserControl;
// 控件只写 store + 调 DesktopBridge,主进程在会话装配 / 工具调用时读这些字段（views 不碰 Node）。
// 桌面专属:Web(bridge=null)无主进程消费方,整区不渲染。
export function BrowserSettingsSection() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const pushToast = useCortexUIStore((s) => s.pushToast);
  const general = usePersonalStore((s) => s.generalSettings);
  const setBrowserControl = usePersonalStore((s) => s.setBrowserControl);
  const addApprovedOrigin = usePersonalStore((s) => s.addApprovedOrigin);
  const removeApprovedOrigin = usePersonalStore((s) => s.removeApprovedOrigin);
  const bc: BrowserControlSettings = general.browserControl ?? DEFAULT_BROWSER_CONTROL;

  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cdpConfirm, setCdpConfirm] = useState(false);
  const [originInput, setOriginInput] = useState("");
  const [originError, setOriginError] = useState("");

  // 清除数据需主进程能力:Web(无 bridge)隐藏该按钮,其余设置照常(写 store,主进程消费)。
  const canClearData = typeof bridge?.browserClearData === "function";

  // 破坏性操作:二次确认后再调 IPC;调用期 disabled 防重复点。
  const clearData = (): void => {
    setClearConfirm(false);
    setClearing(true);
    void bridge?.browserClearData?.().then(
      () => {
        pushToast(t("browser.clearDataOk"));
        setClearing(false);
      },
      () => {
        pushToast(t("browser.clearDataFail"), { kind: "error" });
        setClearing(false);
      },
    );
  };

  // 仅接受归一后的 http(s) origin（共享 normalizeOrigin,口径同 url-gate）；重复给提示不写。
  const addOrigin = (): void => {
    const origin = normalizeOrigin(originInput);
    if (!origin) {
      setOriginError(t("browser.sitesInvalid"));
      return;
    }
    if (bc.approvedOrigins.includes(origin)) {
      setOriginError(t("browser.sitesDuplicate"));
      return;
    }
    addApprovedOrigin(origin);
    setOriginInput("");
    setOriginError("");
  };

  return (
    <>
      {/* 总开关 */}
      <SettingCard title={t("browser.title")}>
        <SwitchRow
          label={t("browser.enableLabel")}
          desc={t("browser.enableDesc")}
          value={bc.enabled}
          onChange={(v) => setBrowserControl({ enabled: v })}
        />
      </SettingCard>

      {/* 关时整组置灰但可见(fieldset disabled:子控件不可聚焦/不可改);提示如何解锁。 */}
      <fieldset className="pw-bc-sub" disabled={!bc.enabled} aria-describedby="pw-bc-disabled-hint">
        {!bc.enabled ? (
          <div id="pw-bc-disabled-hint" className="pw-scard-empty">
            {t("browser.disabledHint")}
          </div>
        ) : null}

        {/* General */}
        <SettingCard title={t("browser.generalCard")}>
          <SRow label={t("browser.localUrlLabel")} desc={t("browser.localUrlDesc")} end>
            <BareSelect
              value={bc.localUrlOpenTarget}
              options={[
                { label: t("browser.localUrlInternal"), value: "internal" },
                { label: t("browser.localUrlSystem"), value: "system" },
              ]}
              onChange={(v) => setBrowserControl({ localUrlOpenTarget: v as "internal" | "system" })}
            />
          </SRow>
          <div className="pw-srow-desc">{t("browser.localUrlHint")}</div>

          {canClearData ? (
            <>
              <SRow label={t("browser.clearDataLabel")} desc={t("browser.clearDataDesc")} end>
                <button type="button" className="pw-btn" disabled={clearing} onClick={() => setClearConfirm(true)}>
                  {clearing ? t("browser.clearDataBusy") : t("browser.clearDataBtn")}
                </button>
              </SRow>
              {clearConfirm ? (
                <div className="pw-srow-desc pw-bc-risk">
                  {t("browser.clearDataConfirm")}
                  <button type="button" className="pw-btn" onClick={clearData}>
                    {t("browser.clearDataConfirmBtn")}
                  </button>
                  <button type="button" className="pw-btn-sm" onClick={() => setClearConfirm(false)}>
                    {t("browser.cancel")}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          <SRow label={t("browser.screenshotLabel")} desc={t("browser.screenshotDesc")} end>
            <BareSelect
              value={bc.annotateScreenshotMode}
              options={[
                { label: t("browser.screenshotAlways"), value: "always" },
                { label: t("browser.screenshotAsk"), value: "ask" },
                { label: t("browser.screenshotNever"), value: "never" },
              ]}
              onChange={(v) => setBrowserControl({ annotateScreenshotMode: v as "always" | "ask" | "never" })}
            />
          </SRow>
          <div className="pw-srow-desc">{t("browser.screenshotHint")}</div>
        </SettingCard>

        {/* 权限:导航授权范围(取代 Codex 事中审批——cortex 无事中回路,用预授权严格度) */}
        <SettingCard title={t("browser.permsCard")}>
          <SRow label={t("browser.approvalLabel")} desc={t("browser.approvalDesc")} end>
            <BareSelect
              value={bc.navigationApproval}
              options={[
                { label: t("browser.approvalNone"), value: "none" },
                { label: t("browser.approvalNonLocal"), value: "nonLocalOnly" },
                { label: t("browser.approvalAll"), value: "all" },
              ]}
              onChange={(v) => setBrowserControl({ navigationApproval: v as "none" | "nonLocalOnly" | "all" })}
            />
          </SRow>
          <div className="pw-srow-desc">{t("browser.approvalHint")}</div>
        </SettingCard>

        {/* 网站权限:预授权 origin 白名单(cortex 当前的站点级能力,复用 approvedOrigins) */}
        <SettingCard title={t("browser.sitesCard")}>
          <div className="pw-srow-desc">{t("browser.sitesDesc")}</div>
          {bc.approvedOrigins.length === 0 ? (
            <div className="pw-scard-empty">{t("browser.sitesEmpty")}</div>
          ) : (
            <div className="pw-bc-list">
              {bc.approvedOrigins.map((o) => (
                <div key={o} className="pw-mcp-item">
                  <span>{o}</span>
                  <button type="button" className="pw-btn-sm" onClick={() => removeApprovedOrigin(o)}>
                    {t("browser.sitesRemove")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="pw-bc-add">
            <input
              type="text"
              value={originInput}
              placeholder={t("browser.sitesPlaceholder")}
              aria-label={t("browser.sitesAdd")}
              onChange={(e) => {
                setOriginInput(e.target.value);
                setOriginError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") addOrigin();
              }}
            />
            <button type="button" className="pw-btn" onClick={addOrigin}>
              {t("browser.sitesAdd")}
            </button>
          </div>
          {originError ? <div className="pw-srow-desc pw-bc-risk">{originError}</div> : null}
        </SettingCard>

        {/* 开发者模式:完整 CDP(风险升高,启用前二段确认) */}
        <SettingCard title={t("browser.devCard")}>
          <SRow label={t("browser.cdpLabel")} desc={t("browser.cdpDesc")} end>
            <span className="pw-bc-risk pw-bc-risk-tag">{t("browser.cdpRisk")}</span>
            <button
              type="button"
              className="twk-toggle"
              data-on={bc.cdpEnabled ? "1" : "0"}
              role="switch"
              aria-checked={bc.cdpEnabled}
              aria-label={t("browser.cdpLabel")}
              onClick={() => {
                if (bc.cdpEnabled) {
                  setBrowserControl({ cdpEnabled: false });
                  setCdpConfirm(false);
                } else {
                  setCdpConfirm(true); // 启用前先确认
                }
              }}
            >
              <i />
            </button>
          </SRow>
          {cdpConfirm && !bc.cdpEnabled ? (
            <div className="pw-srow-desc pw-bc-risk">
              {t("browser.cdpConfirm")}
              <button
                type="button"
                className="pw-btn"
                onClick={() => {
                  setBrowserControl({ cdpEnabled: true });
                  setCdpConfirm(false);
                }}
              >
                {t("browser.cdpConfirmBtn")}
              </button>
            </div>
          ) : null}
        </SettingCard>
      </fieldset>
    </>
  );
}
