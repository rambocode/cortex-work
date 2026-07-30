// 设置页「设计」分区：设计→代码、画布默认值、设计工作目录、设计系统偏好、设计 Agent。
// 数据落 personal store 的 designSettings 切片(写入即归一化,随 PersistedState 落盘);
// 字段语义与 Kun DesignSettingsV1 一一对应,设计回合的 prompt 组装读取这些值。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { DESIGN_SYSTEM_PRESETS } from "@cortex-work/core/design/compat/app-settings";
import type {
  DesignBackgroundSetting,
  DesignCanvasViewSetting,
  DesignSystemPreset,
  DesignViewportSetting,
} from "@cortex-work/core/desktop/design-types";
import { SBlock, SwitchRow, BareSelect } from "./settingsControls";

const BRAND_COLOR_PLACEHOLDER = "#3B82D8";

function DesignCard({
  title,
  icon,
  className = "",
  children,
}: {
  title: string;
  icon: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`pw-scard pw-design-card ${className}`.trim()}>
      <h2 className="pw-scard-t pw-design-card-title">
        <span className="pw-design-card-icon" aria-hidden="true">
          {icon}
        </span>
        <span>{title}</span>
      </h2>
      <div className="pw-design-card-body">{children}</div>
    </section>
  );
}

export function DesignSettingsSection() {
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.designSettings);
  const setDesignSettings = usePersonalStore((s) => s.setDesignSettings);
  const bridge = useDesktopBridge();
  const viewportOptions = [
    { value: "desktop", label: t("design.viewportDesktop") },
    { value: "tablet", label: t("design.viewportTablet") },
    { value: "mobile", label: t("design.viewportMobile") },
  ];
  const viewOptions = [
    { value: "preview", label: t("design.viewPreview") },
    { value: "code", label: t("design.viewCode") },
  ];
  const backgroundOptions = [
    { value: "light", label: t("design.bgLight") },
    { value: "dark", label: t("design.bgDark") },
  ];
  const currentViewport = viewportOptions.find((option) => option.value === settings.defaultViewport)?.label;
  const currentView = viewOptions.find((option) => option.value === settings.defaultCanvasView)?.label;

  return (
    <div className="pw-design-settings">
      <div className="pw-design-heading">
        <div className="pw-dlg-title">{t("design.title")}</div>
        <div className="pw-dlg-desc">{t("design.desc")}</div>
      </div>

      <div className="pw-design-summary" aria-label={t("design.title")}>
        <div className="pw-design-summary-item">
          <span>{t("design.defaultViewport")}</span>
          <strong>{currentViewport}</strong>
        </div>
        <div className="pw-design-summary-item">
          <span>{t("design.defaultCanvasView")}</span>
          <strong>{currentView}</strong>
        </div>
        <div className="pw-design-summary-item">
          <span>{t("design.preset")}</span>
          <strong>{settings.designSystemPreset}</strong>
        </div>
      </div>

      <div className="pw-design-grid">
        <DesignCard title={t("design.codeCard")} icon={<Icon.Code size={15} />} className="pw-design-card--code">
          <SBlock label={t("design.stackHint")} desc={t("design.stackHintDesc")}>
            <input
              className="pw-set-input"
              value={settings.implementStackHint}
              placeholder={t("design.stackHintPlaceholder")}
              onChange={(e) => setDesignSettings({ implementStackHint: e.target.value })}
            />
          </SBlock>
          <SwitchRow
            label={t("design.injectIntoCode")}
            desc={t("design.injectIntoCodeDesc")}
            value={settings.injectIntoCode}
            onChange={(v) => setDesignSettings({ injectIntoCode: v })}
          />
          <SwitchRow
            label={t("design.publishDesignSystem")}
            desc={t("design.publishDesignSystemDesc")}
            value={settings.publishDesignSystem}
            onChange={(v) => setDesignSettings({ publishDesignSystem: v })}
          />
        </DesignCard>

        <DesignCard title={t("design.canvasCard")} icon={<Icon.Eye size={15} />} className="pw-design-card--canvas">
          <div className="pw-design-fields">
            <div className="pw-design-field">
              <SBlock label={t("design.defaultViewport")}>
                <BareSelect
                  value={settings.defaultViewport}
                  onChange={(v) => setDesignSettings({ defaultViewport: v as DesignViewportSetting })}
                  options={viewportOptions}
                />
              </SBlock>
            </div>
            <div className="pw-design-field">
              <SBlock label={t("design.defaultCanvasView")}>
                <BareSelect
                  value={settings.defaultCanvasView}
                  onChange={(v) => setDesignSettings({ defaultCanvasView: v as DesignCanvasViewSetting })}
                  options={viewOptions}
                />
              </SBlock>
            </div>
            <div className="pw-design-field pw-design-field--wide">
              <SBlock label={t("design.canvasBackground")}>
                <BareSelect
                  value={settings.canvasBackground}
                  onChange={(v) => setDesignSettings({ canvasBackground: v as DesignBackgroundSetting })}
                  options={backgroundOptions}
                />
              </SBlock>
            </div>
          </div>
          <SwitchRow
            label={t("design.liveRefresh")}
            desc={t("design.liveRefreshDesc")}
            value={settings.liveRefresh}
            onChange={(v) => setDesignSettings({ liveRefresh: v })}
          />
          <SwitchRow
            label={t("design.deviceFrame")}
            desc={t("design.deviceFrameDesc")}
            value={settings.deviceFrame}
            onChange={(v) => setDesignSettings({ deviceFrame: v })}
          />
        </DesignCard>

        <DesignCard
          title={t("design.workspaceCard")}
          icon={<Icon.Folder size={15} />}
          className="pw-design-card--workspace"
        >
          <SBlock label={t("design.workspaceRoot")} desc={t("design.workspaceRootDesc")}>
            <div className="pw-design-workspace-control">
              <input
                className="pw-set-input"
                value={settings.defaultWorkspaceRoot}
                onChange={(e) => setDesignSettings({ defaultWorkspaceRoot: e.target.value })}
              />
              <div className="pw-design-workspace-actions">
                <button
                  className="pw-btn pw-design-action pw-design-action--primary"
                  disabled={!bridge}
                  onClick={() => {
                    void bridge?.pickDirectory().then((dir) => {
                      if (dir) setDesignSettings({ defaultWorkspaceRoot: dir });
                    });
                  }}
                >
                  {t("design.pickDir")}
                </button>
                <button
                  className="pw-btn pw-design-action"
                  disabled={!bridge?.designWorkspaceRoot}
                  onClick={() => {
                    void bridge?.designWorkspaceRoot?.().then((dir) => {
                      setDesignSettings({ defaultWorkspaceRoot: dir });
                    });
                  }}
                >
                  {t("design.resetDir")}
                </button>
              </div>
            </div>
          </SBlock>
        </DesignCard>

        <DesignCard
          title={t("design.systemCard")}
          icon={<Icon.Palette size={15} />}
          className="pw-design-card--system"
        >
          <SBlock label={t("design.brandColor")} desc={t("design.brandColorDesc")}>
            <input
              className="pw-set-input"
              value={settings.brandColor}
              placeholder={BRAND_COLOR_PLACEHOLDER}
              onChange={(e) => setDesignSettings({ brandColor: e.target.value })}
            />
          </SBlock>
          <SBlock label={t("design.tone")} desc={t("design.toneDesc")}>
            <input
              className="pw-set-input"
              value={settings.tone.join(", ")}
              onChange={(e) =>
                setDesignSettings({
                  tone: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                })
              }
            />
          </SBlock>
          <SBlock label={t("design.preset")}>
            <BareSelect
              value={settings.designSystemPreset}
              onChange={(v) => setDesignSettings({ designSystemPreset: v as DesignSystemPreset })}
              options={DESIGN_SYSTEM_PRESETS.map((preset) => ({ value: preset, label: preset }))}
            />
          </SBlock>
          <SBlock label={t("design.guidelines")} desc={t("design.guidelinesDesc")}>
            <textarea
              className="pw-set-input pw-design-textarea"
              rows={3}
              value={settings.designGuidelines}
              onChange={(e) => setDesignSettings({ designGuidelines: e.target.value })}
            />
          </SBlock>
        </DesignCard>

        <DesignCard title={t("design.agentCard")} icon={<Icon.Bot size={15} />} className="pw-design-card--agent">
          <SBlock label={t("design.model")} desc={t("design.modelDesc")}>
            <input
              className="pw-set-input"
              value={settings.model}
              onChange={(e) => setDesignSettings({ model: e.target.value })}
            />
          </SBlock>
          <SBlock label={t("design.generationPrompt")} desc={t("design.generationPromptDesc")}>
            <textarea
              className="pw-set-input pw-design-textarea"
              rows={4}
              value={settings.generationPrompt}
              onChange={(e) => setDesignSettings({ generationPrompt: e.target.value })}
            />
          </SBlock>
        </DesignCard>
      </div>
    </div>
  );
}
