// 设置页「设计」分区：设计→代码、画布默认值、设计工作目录、设计系统偏好、设计 Agent。
// 数据落 personal store 的 designSettings 切片(写入即归一化,随 PersistedState 落盘);
// 字段语义与 Kun DesignSettingsV1 一一对应,设计回合的 prompt 组装读取这些值。
import { useTranslation } from "react-i18next";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { DESIGN_SYSTEM_PRESETS } from "@cortex-work/core/design/compat/app-settings";
import type {
  DesignBackgroundSetting,
  DesignCanvasViewSetting,
  DesignSystemPreset,
  DesignViewportSetting,
} from "@cortex-work/core/desktop/design-types";
import { SettingCard, SBlock, SwitchRow, BareSelect } from "./settingsControls";

export function DesignSettingsSection() {
  const { t } = useTranslation("settings");
  const settings = usePersonalStore((s) => s.designSettings);
  const setDesignSettings = usePersonalStore((s) => s.setDesignSettings);
  const bridge = useDesktopBridge();

  return (
    <>
      <div className="pw-dlg-title">{t("design.title")}</div>
      <div className="pw-dlg-desc">{t("design.desc")}</div>

      <SettingCard title={t("design.codeCard")}>
        <SBlock label={t("design.stackHint")} desc={t("design.stackHintDesc")}>
          <input
            className="pw-input"
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
      </SettingCard>

      <SettingCard title={t("design.canvasCard")}>
        <SBlock label={t("design.defaultViewport")}>
          <BareSelect
            value={settings.defaultViewport}
            onChange={(v) => setDesignSettings({ defaultViewport: v as DesignViewportSetting })}
            options={[
              { value: "desktop", label: t("design.viewportDesktop") },
              { value: "tablet", label: t("design.viewportTablet") },
              { value: "mobile", label: t("design.viewportMobile") },
            ]}
          />
        </SBlock>
        <SBlock label={t("design.defaultCanvasView")}>
          <BareSelect
            value={settings.defaultCanvasView}
            onChange={(v) => setDesignSettings({ defaultCanvasView: v as DesignCanvasViewSetting })}
            options={[
              { value: "preview", label: t("design.viewPreview") },
              { value: "code", label: t("design.viewCode") },
            ]}
          />
        </SBlock>
        <SBlock label={t("design.canvasBackground")}>
          <BareSelect
            value={settings.canvasBackground}
            onChange={(v) => setDesignSettings({ canvasBackground: v as DesignBackgroundSetting })}
            options={[
              { value: "light", label: t("design.bgLight") },
              { value: "dark", label: t("design.bgDark") },
            ]}
          />
        </SBlock>
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
      </SettingCard>

      <SettingCard title={t("design.workspaceCard")}>
        <SBlock label={t("design.workspaceRoot")} desc={t("design.workspaceRootDesc")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="pw-input"
              style={{ flex: 1 }}
              value={settings.defaultWorkspaceRoot}
              onChange={(e) => setDesignSettings({ defaultWorkspaceRoot: e.target.value })}
            />
            <button
              className="pw-btn"
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
              className="pw-btn"
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
        </SBlock>
      </SettingCard>

      <SettingCard title={t("design.systemCard")}>
        <SBlock label={t("design.brandColor")} desc={t("design.brandColorDesc")}>
          <input
            className="pw-input"
            value={settings.brandColor}
            placeholder="#3B82D8"
            onChange={(e) => setDesignSettings({ brandColor: e.target.value })}
          />
        </SBlock>
        <SBlock label={t("design.tone")} desc={t("design.toneDesc")}>
          <input
            className="pw-input"
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
            options={DESIGN_SYSTEM_PRESETS.map((p) => ({ value: p, label: p }))}
          />
        </SBlock>
        <SBlock label={t("design.guidelines")} desc={t("design.guidelinesDesc")}>
          <textarea
            className="pw-input"
            rows={3}
            value={settings.designGuidelines}
            onChange={(e) => setDesignSettings({ designGuidelines: e.target.value })}
          />
        </SBlock>
      </SettingCard>

      <SettingCard title={t("design.agentCard")}>
        <SBlock label={t("design.model")} desc={t("design.modelDesc")}>
          <input
            className="pw-input"
            value={settings.model}
            onChange={(e) => setDesignSettings({ model: e.target.value })}
          />
        </SBlock>
        <SBlock label={t("design.generationPrompt")} desc={t("design.generationPromptDesc")}>
          <textarea
            className="pw-input"
            rows={4}
            value={settings.generationPrompt}
            onChange={(e) => setDesignSettings({ generationPrompt: e.target.value })}
          />
        </SBlock>
      </SettingCard>
    </>
  );
}
