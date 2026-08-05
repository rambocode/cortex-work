// 统一语音设置：TTS/ASR 引擎继续使用既有独立配置，
// 此处只承载麦克风、语音聊天和系统级听写的交互设置。

import { useEffect, useMemo, useState } from "react";
import { HotkeyCapture } from "@cortex-work/ui/controls/HotkeyCapture";
import { useCortexUIStore, useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { VoiceSettings } from "@cortex-work/core";
import { DEFAULT_POLISH_PROMPT, DEFAULT_VOICE_CHAT_PROMPT } from "@cortex-work/core/desktop/types";
import { useTranslation } from "@cortex-work/core/i18n";
import { detectIsMac } from "../shared/platform";
import { SBlock, SRow, SettingCard, SwitchRow } from "./settingsControls";
import { ModelRefField } from "./provider/ModelRefField";
import { SpeechDictationDictionary } from "./SpeechDictationDictionary";
import { SpeechTtsPanel } from "./SpeechTtsPanel";
import { SttSettingsSection } from "./SttSettingsSection";

interface MicrophoneOption {
  label: string;
  value: string;
}

/**
 * 首次打开设置时请求一次麦克风权限，随后再枚举设备。
 * 浏览器在未授权时会刻意隐藏标签；仍保留序号兜底，使用户能选择设备而非得到空白列表。
 */
async function listMicrophones(): Promise<MicrophoneOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia?.({ audio: true });
    stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // 权限拒绝不阻断设置页；系统默认设备仍是安全可用的回退。
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  let unnamed = 0;
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => {
      unnamed += device.label ? 0 : 1;
      return {
        value: device.deviceId,
        label: device.label || `麦克风 ${unnamed}`,
      };
    });
}

export function SpeechSettingsSection() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const pushToast = useCortexUIStore((state) => state.pushToast);
  const voice = usePersonalStore((state) => state.voiceSettings);
  const setVoiceSettings = usePersonalStore((state) => state.setVoiceSettings);
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const isMac = useMemo(() => detectIsMac(), []);

  useEffect(() => {
    let active = true;
    void listMicrophones()
      .then((devices) => {
        if (active) setMicrophones(devices);
      })
      .catch(() => {
        // enumerateDevices 在部分旧 WebView 里会拒绝；保留系统默认项即可。
      });
    return () => {
      active = false;
    };
  }, []);

  const microphoneOptions = [
    { value: "", label: t("speech.microphoneDefault") },
    ...microphones,
  ];

  // 三项快捷键由 main 原子校验与重绑。先乐观写入是为了让录制控件立即反馈；任一键
  // 被拒时必须整体回滚，避免设置页面显示的组合与系统实际注册的组合不一致。
  const applyHotkey = async (
    field: keyof Pick<VoiceSettings, "chatHotkey" | "dictationHoldHotkey" | "dictationToggleHotkey">,
    value: string,
  ) => {
    const previous = {
      chatHotkey: voice.chatHotkey,
      dictationHoldHotkey: voice.dictationHoldHotkey,
      dictationToggleHotkey: voice.dictationToggleHotkey,
    };
    const next = { ...previous, [field]: value };
    setVoiceSettings(next);
    try {
      const result = await bridge?.setVoiceHotkeys?.(next);
      if (!result || Object.values(result).every((entry) => entry.ok)) return;
      setVoiceSettings(previous);
      const failure = Object.values(result).find((entry) => !entry.ok);
      pushToast(failure?.toast ?? t("speech.hotkeyFailed"), { kind: "error" });
    } catch {
      setVoiceSettings(previous);
      pushToast(t("speech.hotkeyFailed"), { kind: "error" });
    }
  };

  return (
    <>
      <div className="pw-dlg-title">{t("speech.title")}</div>
      <div className="pw-dlg-desc">{t("speech.desc")}</div>

      <SettingCard title={t("speech.generalCard")}>
        <SRow label={t("speech.microphone")} desc={t("speech.microphoneDesc")}>
          <select
            className="pw-set-input"
            value={voice.micDeviceId}
            aria-label={t("speech.microphone")}
            onChange={(event) => setVoiceSettings({ micDeviceId: event.target.value })}
          >
            {microphoneOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </SRow>
      </SettingCard>

      <SettingCard title={t("speech.chatCard")}>
        <SpeechTtsPanel />
        <ModelRefField
          label={t("speech.chatModel")}
          value={
            voice.chatProviderId && voice.chatModelId
              ? { providerId: voice.chatProviderId, modelId: voice.chatModelId }
              : undefined
          }
          onChange={(ref) => setVoiceSettings({ chatProviderId: ref.providerId, chatModelId: ref.modelId })}
          hint={t("speech.chatModelHint")}
        />
        {voice.chatProviderId && voice.chatModelId ? (
          <button
            className="btn pw-pi-add-btn"
            type="button"
            onClick={() => setVoiceSettings({ chatProviderId: "", chatModelId: "" })}
          >
            {t("speech.chatModelFollowLast")}
          </button>
        ) : null}
        <SBlock label={t("speech.chatPrompt")} desc={t("speech.chatPromptDesc")}>
          <textarea
            className="pw-set-input"
            rows={4}
            value={voice.chatPrompt}
            placeholder={DEFAULT_VOICE_CHAT_PROMPT}
            spellCheck={false}
            onChange={(event) => setVoiceSettings({ chatPrompt: event.target.value })}
          />
          {voice.chatPrompt.trim() ? (
            <button className="btn pw-pi-add-btn" type="button" onClick={() => setVoiceSettings({ chatPrompt: "" })}>
              {t("speech.chatPromptReset")}
            </button>
          ) : null}
        </SBlock>
        {isMac ? (
          <>
            <SRow label={t("speech.chatHotkey")} desc={t("speech.chatHotkeyDesc")}>
              <div className="pw-hotkey-control">
                <HotkeyCapture value={voice.chatHotkey} placeholder={t("speech.hotkeyUnset")} isMac onChange={(chatHotkey) => void applyHotkey("chatHotkey", chatHotkey)} />
                {voice.chatHotkey ? (
                  <button className="btn pw-pi-add-btn" type="button" onClick={() => void applyHotkey("chatHotkey", "")}>
                    {t("speech.hotkeyClear")}
                  </button>
                ) : null}
              </div>
            </SRow>
            <SwitchRow label={t("speech.chatScreenContext")} desc={t("speech.chatScreenContextDesc")} value={voice.chatScreenContext} onChange={(chatScreenContext) => setVoiceSettings({ chatScreenContext })} />
          </>
        ) : null}
      </SettingCard>

      {isMac ? (
        <SettingCard title={t("speech.dictationCard")}>
          <SRow label={t("speech.dictationHoldHotkey")} desc={t("speech.dictationHoldHotkeyDesc")}>
            <div className="pw-hotkey-control">
              <HotkeyCapture value={voice.dictationHoldHotkey} placeholder={t("speech.hotkeyUnset")} isMac onChange={(dictationHoldHotkey) => void applyHotkey("dictationHoldHotkey", dictationHoldHotkey)} />
              {voice.dictationHoldHotkey ? (
                <button className="btn pw-pi-add-btn" type="button" onClick={() => void applyHotkey("dictationHoldHotkey", "")}>
                  {t("speech.hotkeyClear")}
                </button>
              ) : null}
            </div>
          </SRow>
          <SRow label={t("speech.dictationToggleHotkey")} desc={t("speech.dictationToggleHotkeyDesc")}>
            <div className="pw-hotkey-control">
              <HotkeyCapture value={voice.dictationToggleHotkey} placeholder={t("speech.hotkeyUnset")} isMac onChange={(dictationToggleHotkey) => void applyHotkey("dictationToggleHotkey", dictationToggleHotkey)} />
              {voice.dictationToggleHotkey ? (
                <button className="btn pw-pi-add-btn" type="button" onClick={() => void applyHotkey("dictationToggleHotkey", "")}>
                  {t("speech.hotkeyClear")}
                </button>
              ) : null}
            </div>
          </SRow>
          <SwitchRow label={t("speech.dictationBarAlwaysVisible")} desc={t("speech.dictationBarAlwaysVisibleDesc")} value={voice.dictationBarAlwaysVisible} onChange={(dictationBarAlwaysVisible) => setVoiceSettings({ dictationBarAlwaysVisible })} />
          <SRow label={t("speech.dictionary")} desc={t("speech.dictionaryRowDesc")}>
            <SpeechDictationDictionary entries={voice.dictationDictionary} onChange={(dictationDictionary) => setVoiceSettings({ dictationDictionary })} />
          </SRow>
        </SettingCard>
      ) : null}

      <SettingCard title={t("speech.polishCard")}>
        <SwitchRow
          label={t("speech.polishEnable")}
          desc={t("speech.polishEnableDesc")}
          value={voice.transcriptPolish}
          onChange={(transcriptPolish) => setVoiceSettings({ transcriptPolish })}
        />
        {voice.transcriptPolish ? (
          <>
            <ModelRefField
              label={t("speech.polishModel")}
              value={
                voice.polishProviderId && voice.polishModelId
                  ? { providerId: voice.polishProviderId, modelId: voice.polishModelId }
                  : undefined
              }
              onChange={(ref) => setVoiceSettings({ polishProviderId: ref.providerId, polishModelId: ref.modelId })}
              hint={t("speech.polishModelHint")}
            />
            {voice.polishProviderId && voice.polishModelId ? (
              <button
                className="btn pw-pi-add-btn"
                type="button"
                onClick={() => setVoiceSettings({ polishProviderId: "", polishModelId: "" })}
              >
                {t("speech.polishModelFollowDefault")}
              </button>
            ) : null}
            <SBlock label={t("speech.polishPrompt")} desc={t("speech.polishPromptDesc")}>
              <textarea
                className="pw-set-input"
                rows={4}
                value={voice.polishPrompt}
                placeholder={DEFAULT_POLISH_PROMPT}
                spellCheck={false}
                onChange={(event) => setVoiceSettings({ polishPrompt: event.target.value })}
              />
              {voice.polishPrompt.trim() ? (
                <button className="btn pw-pi-add-btn" type="button" onClick={() => setVoiceSettings({ polishPrompt: "" })}>
                  {t("speech.polishPromptReset")}
                </button>
              ) : null}
            </SBlock>
          </>
        ) : null}
      </SettingCard>

      <section aria-label={t("speech.modelsCard")}>
        <div className="pw-dlg-title">{t("speech.modelsCard")}</div>
        <div className="pw-dlg-desc">{t("speech.modelsDesc")}</div>
        <SttSettingsSection />
      </section>
    </>
  );
}
