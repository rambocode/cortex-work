// 统一语音设置：TTS/ASR 引擎继续使用既有独立配置，
// 此处只承载麦克风、语音聊天和系统级听写的交互设置。

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { HotkeyCapture } from "@cortex-work/ui/controls/HotkeyCapture";
import { useCortexUIStore, useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { VoiceSettings } from "@cortex-work/core";
import { DEFAULT_POLISH_PROMPT, DEFAULT_VOICE_CHAT_PROMPT } from "@cortex-work/core/desktop/types";
import { useTranslation } from "@cortex-work/core/i18n";
import { detectIsMac } from "../shared/platform";
import { SBlock, SRow, SwitchRow } from "./settingsControls";
import { ModelRefField } from "./provider/ModelRefField";
import { SpeechDictationDictionary } from "./SpeechDictationDictionary";
import { SpeechTtsPanel } from "./SpeechTtsPanel";
import { SttSettingsSection } from "./SttSettingsSection";

interface MicrophoneOption {
  label: string;
  value: string;
}

// 语音分区专属卡片：在通用 .pw-scard 基础上加标题图标 chip，
// 呼应 Dimension 风格参考（克制版，见 SpeechSettingsSection 顶部改动说明）。
function SpeechCard({
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
    <section className={`pw-scard pw-speech-card ${className}`.trim()}>
      <h2 className="pw-scard-t pw-speech-card-title">
        <span className="pw-speech-card-icon" aria-hidden="true">
          {icon}
        </span>
        <span>{title}</span>
      </h2>
      <div className="pw-speech-card-body">{children}</div>
    </section>
  );
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
    <div className="pw-speech-settings">
      <div className="pw-dlg-title">{t("speech.title")}</div>
      <div className="pw-dlg-desc">{t("speech.desc")}</div>

      <SpeechCard title={t("speech.generalCard")} icon={<Icon.Mic size={15} />}>
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
      </SpeechCard>

      <SpeechCard title={t("speech.chatCard")} icon={<Icon.Comment size={15} />} className="pw-speech-card--chat">
        <SpeechTtsPanel />
        {/* 语音助手不再有专用模型:轮次走主窗口会话发送管线,模型/Agent 跟随会话本身。 */}
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
        <SRow label={t("speech.intentMode")} desc={t("speech.intentModeDesc")}>
          <select
            className="pw-set-input"
            value={voice.intentMode}
            aria-label={t("speech.intentMode")}
            onChange={(event) => setVoiceSettings({
              intentMode: event.target.value as VoiceSettings["intentMode"],
            })}
          >
            <option value="function_call">{t("speech.intentModeFunctionCall")}</option>
            <option value="intent_llm">{t("speech.intentModeLlm")}</option>
            <option value="nointent">{t("speech.intentModeOff")}</option>
          </select>
        </SRow>
        {/* 拼音容错 fast-path 独立于三模式：与精确命令同位执行（见主进程 voice-intent/fuzzy.ts）。 */}
        <SwitchRow
          label={t("speech.commandFuzzyMatch")}
          desc={t("speech.commandFuzzyMatchDesc")}
          value={voice.commandFuzzyMatch}
          onChange={(commandFuzzyMatch) => setVoiceSettings({ commandFuzzyMatch })}
        />
        {/* 句级流式朗读：关闭 = 回退「整轮结束后朗读」旧路径（排障用）。 */}
        <SwitchRow
          label={t("speech.chatStreamTts")}
          desc={t("speech.chatStreamTtsDesc")}
          value={voice.chatStreamTts}
          onChange={(chatStreamTts) => setVoiceSettings({ chatStreamTts })}
        />
        {voice.intentMode === "intent_llm" ? (
          <>
            <ModelRefField
              label={t("speech.intentModel")}
              value={
                voice.intentProviderId && voice.intentModelId
                  ? { providerId: voice.intentProviderId, modelId: voice.intentModelId }
                  : undefined
              }
              onChange={(ref) => setVoiceSettings({
                intentProviderId: ref.providerId,
                intentModelId: ref.modelId,
              })}
              hint={t("speech.intentModelHint")}
            />
            {voice.intentProviderId && voice.intentModelId ? (
              <button
                className="btn pw-pi-add-btn"
                type="button"
                onClick={() => setVoiceSettings({ intentProviderId: "", intentModelId: "" })}
              >
                {t("speech.intentModelFollowDefault")}
              </button>
            ) : null}
          </>
        ) : null}
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
            {/* 唤醒词(端侧 KWS):持久化在 voiceSettings.wakeWord,运行时经桥热应用
                (开 → 主进程拉起常驻 kws 隐藏窗口;关 → 销毁)。默认关,隐私敏感。 */}
            {bridge?.wakeWordConfigure ? (
              <>
                <SwitchRow
                  label={t("speech.wakeWord")}
                  desc={t("speech.wakeWordDesc")}
                  value={voice.wakeWord.enabled}
                  onChange={(enabled) => {
                    const wakeWord = { ...voice.wakeWord, enabled };
                    setVoiceSettings({ wakeWord });
                    void bridge.wakeWordConfigure?.(wakeWord);
                  }}
                />
                {voice.wakeWord.enabled ? (
                  <SRow label={t("speech.wakeWordSensitivity")} desc={t("speech.wakeWordSensitivityDesc")}>
                    <select
                      className="pw-set-input"
                      value={voice.wakeWord.sensitivity}
                      aria-label={t("speech.wakeWordSensitivity")}
                      onChange={(event) => {
                        const sensitivity = event.target.value as VoiceSettings["wakeWord"]["sensitivity"];
                        const wakeWord = { ...voice.wakeWord, sensitivity };
                        setVoiceSettings({ wakeWord });
                        void bridge.wakeWordConfigure?.(wakeWord);
                      }}
                    >
                      <option value="low">{t("speech.wakeWordSensitivityLow")}</option>
                      <option value="medium">{t("speech.wakeWordSensitivityMedium")}</option>
                      <option value="high">{t("speech.wakeWordSensitivityHigh")}</option>
                    </select>
                  </SRow>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </SpeechCard>

      {isMac ? (
        <SpeechCard title={t("speech.dictationCard")} icon={<Icon.Type size={15} />}>
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
        </SpeechCard>
      ) : null}

      <SpeechCard title={t("speech.polishCard")} icon={<Icon.Sparkle size={15} />}>
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
      </SpeechCard>

      <section aria-label={t("speech.modelsCard")}>
        <div className="pw-speech-heading">
          <span className="pw-speech-card-icon" aria-hidden="true">
            <Icon.Bot size={15} />
          </span>
          <div>
            <div className="pw-dlg-title">{t("speech.modelsCard")}</div>
            <div className="pw-dlg-desc">{t("speech.modelsDesc")}</div>
          </div>
        </div>
        <SttSettingsSection />
      </section>
    </div>
  );
}
