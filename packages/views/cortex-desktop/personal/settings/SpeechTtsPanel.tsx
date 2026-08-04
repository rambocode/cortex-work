// 统一「语音」分区内的 TTS 设置面板。
// 从旧的 SettingsMenu 拆出时保持原有引擎配置、音色加载和试听行为不变，
// 以免分区迁移改变已保存的 ttsSettings 语义。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { speakText, stopSpeaking, useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { TtsEngineConfig, TtsVoiceOption } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { BareSelect, SRow, SwitchRow } from "./settingsControls";

const SPEECH_RATE_VALUES = ["0.8", "1", "1.2", "1.5"];

const FALLBACK_TTS_VOICES: TtsVoiceOption[] = [
  { id: "alloy" },
  { id: "ash" },
  { id: "ballad" },
  { id: "coral" },
  { id: "echo" },
  { id: "fable" },
  { id: "nova" },
  { id: "onyx" },
  { id: "sage" },
  { id: "shimmer" },
];

const TTS_LANGUAGES = [
  { label: "中文 zh", value: "zh" },
  { label: "中文 zh-CN", value: "zh-CN" },
  { label: "English en", value: "en" },
  { label: "日本語 ja", value: "ja" },
  { label: "한국어 ko", value: "ko" },
];

export function SpeechTtsPanel() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const tts = usePersonalStore((s) => s.ttsSettings);
  const setTts = usePersonalStore((s) => s.setTtsSettings);
  const engine = tts.engine;
  const setEngine = (next: TtsEngineConfig) => setTts({ engine: next });
  const [testing, setTesting] = useState(false);
  const [customVoices, setCustomVoices] = useState<TtsVoiceOption[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  // speechSynthesis 的音色列表会异步更新；中文音色优先，保持原设置页的选择顺序。
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => {
      const list = [...synth.getVoices()];
      list.sort((a, b) => Number(b.lang.startsWith("zh")) - Number(a.lang.startsWith("zh")));
      setVoices(list);
    };
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, []);
  const voiceOptions = useMemo(
    () => [
      { label: t("voice.voiceSystemDefault"), value: "" },
      ...voices.map((voice) => ({ label: `${voice.name}（${voice.lang}）`, value: voice.name })),
    ],
    [voices, t],
  );

  useEffect(() => {
    if (engine.kind !== "openai" || !bridge || !engine.baseUrl || !engine.model) {
      setCustomVoices([]);
      setLoadingVoices(false);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    bridge
      .listTtsVoices({ baseUrl: engine.baseUrl, apiKey: engine.apiKey, model: engine.model })
      .then((list) => {
        if (alive) setCustomVoices(list);
      })
      .catch(() => {
        if (alive) setCustomVoices([]);
      })
      .finally(() => {
        if (alive) setLoadingVoices(false);
      });
    return () => {
      alive = false;
    };
  }, [bridge, engine]);

  const customVoiceOptions = useMemo(() => {
    if (engine.kind !== "openai") return [];
    const source = customVoices.length > 0 ? customVoices : FALLBACK_TTS_VOICES;
    const seen = new Set<string>();
    const options: { label: string; value: string }[] = [];
    for (const voice of source) {
      if (!voice.id || seen.has(voice.id)) continue;
      seen.add(voice.id);
      const suffix = voice.locale ? ` · ${voice.locale}` : "";
      options.push({ value: voice.id, label: `${voice.label ?? voice.id}${suffix}` });
    }
    if (engine.voice && !seen.has(engine.voice)) options.unshift({ value: engine.voice, label: t("voice.voiceCurrent", { voice: engine.voice }) });
    return options;
  }, [customVoices, engine, t]);

  const test = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await speakText(bridge, tts, t("voice.testText"));
    } catch {
      // 原有行为：端点不可用时仅恢复按钮，避免把服务端细节暴露在设置页面。
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SwitchRow label={t("voice.autoSpeak")} desc={t("voice.autoSpeakDesc")} value={tts.autoSpeak} onChange={(value) => setTts({ autoSpeak: value })} />
      <SRow label={t("voice.engine")}>
        <SegmentedRadio
          value={engine.kind === "system" ? t("voice.engineSystem") : t("voice.engineCustom")}
          options={[t("voice.engineSystem"), t("voice.engineCustom")]}
          onChange={(value) =>
            setEngine(
              value === t("voice.engineSystem")
                ? { kind: "system" }
                : { kind: "openai", baseUrl: "http://localhost:8880", apiKey: "", model: "tts-1", voice: "alloy", language: "zh" },
            )
          }
        />
      </SRow>
      {engine.kind === "system" ? (
        <>
          <SRow label={t("voice.voiceLabel")} desc={t("voice.voiceSystemDesc")}>
            <BareSelect value={engine.voice ?? ""} options={voiceOptions} onChange={(value) => setEngine({ ...engine, voice: value || undefined })} />
          </SRow>
          <SRow label={t("voice.rate")}>
            <BareSelect
              value={String(engine.rate ?? 1)}
              options={SPEECH_RATE_VALUES.map((value) => ({ label: value === "1" ? t("voice.speechRateDefault") : `${value}×`, value }))}
              onChange={(value) => setEngine({ ...engine, rate: Number(value) })}
            />
          </SRow>
        </>
      ) : (
        <>
          <SRow label={t("voice.baseUrl")} desc={t("voice.baseUrlDesc")}>
            <input className="pw-set-input" value={engine.baseUrl} placeholder="http://localhost:8880" spellCheck={false} onChange={(event) => setEngine({ ...engine, baseUrl: event.target.value })} />
          </SRow>
          <SRow label={t("voice.modelName")}>
            <input className="pw-set-input" value={engine.model} placeholder="tts-1" spellCheck={false} onChange={(event) => setEngine({ ...engine, model: event.target.value })} />
          </SRow>
          <SRow label={t("voice.voiceLabel")} desc={loadingVoices ? t("voice.voiceLoading") : customVoices.length > 0 ? t("voice.voiceFromModel") : t("voice.voiceCommon")}>
            <BareSelect value={engine.voice} options={customVoiceOptions} onChange={(value) => setEngine({ ...engine, voice: value })} />
          </SRow>
          <SRow label={t("voice.customVoice")}>
            <input className="pw-set-input" value={engine.voice} placeholder="alloy" spellCheck={false} onChange={(event) => setEngine({ ...engine, voice: event.target.value })} />
          </SRow>
          <SRow label={t("voice.apiKey")} desc={t("voice.apiKeyOptional")}>
            <input className="pw-set-input" type="password" value={engine.apiKey ?? ""} onChange={(event) => setEngine({ ...engine, apiKey: event.target.value })} />
          </SRow>
          <SRow label={t("voice.language")}>
            <BareSelect value={engine.language ?? "zh"} options={TTS_LANGUAGES} onChange={(value) => setEngine({ ...engine, language: value })} />
          </SRow>
          <SRow label={t("voice.customLanguage")}>
            <input className="pw-set-input" value={engine.language ?? "zh"} placeholder="zh" spellCheck={false} onChange={(event) => setEngine({ ...engine, language: event.target.value || undefined })} />
          </SRow>
          <SRow label={t("voice.rate")}>
            <BareSelect
              value={String(engine.speed ?? 1)}
              options={SPEECH_RATE_VALUES.map((value) => ({ label: value === "1" ? t("voice.speechRateDefault") : `${value}×`, value }))}
              onChange={(value) => setEngine({ ...engine, speed: Number(value) })}
            />
          </SRow>
        </>
      )}
      <SRow label={t("voice.test")} end>
        <span style={{ display: "flex", gap: 8 }}>
          <button className="pw-tl-gen" disabled={testing} onClick={() => void test()}>
            <Icon.Mic size={12} />
            {testing ? t("voice.testPlaying") : t("voice.test")}
          </button>
          <button className="pw-tl-gen" onClick={() => stopSpeaking()}>
            <Icon.Stop size={12} />
            {t("voice.stop")}
          </button>
        </span>
      </SRow>
    </>
  );
}
