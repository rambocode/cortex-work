// 统一「语音」分区内的 TTS 设置面板。
// 从旧的 SettingsMenu 拆出时保持原有引擎配置、音色加载和试听行为不变，
// 以免分区迁移改变已保存的 ttsSettings 语义。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { speakText, stopSpeaking, useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { DEFAULT_EDGE_TTS_VOICE, type TtsEngineConfig, type TtsVoiceOption } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { BareSelect, SRow, SwitchRow } from "./settingsControls";

const SPEECH_RATE_VALUES = ["0.8", "1", "1.2", "1.5"];
const ENGINE_OPTIONS = [
  { kind: "edge", labelKey: "voice.engineEdge" },
  { kind: "system", labelKey: "voice.engineSystem" },
  { kind: "openai", labelKey: "voice.engineCustom" },
] as const;

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

const FALLBACK_EDGE_VOICES: TtsVoiceOption[] = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓", locale: "zh-CN" },
  { id: "zh-CN-YunxiNeural", label: "云希", locale: "zh-CN" },
  { id: "zh-CN-YunjianNeural", label: "云健", locale: "zh-CN" },
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
  const [edgeVoices, setEdgeVoices] = useState<TtsVoiceOption[]>([]);
  const [showAllEdgeLocales, setShowAllEdgeLocales] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const engineLabels = ENGINE_OPTIONS.map((option) => t(option.labelKey));

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

  useEffect(() => {
    if (engine.kind !== "edge" || !bridge?.listEdgeTtsVoices) return;
    let alive = true;
    bridge.listEdgeTtsVoices().then((list) => alive && setEdgeVoices(list)).catch(() => alive && setEdgeVoices([]));
    return () => { alive = false; };
  }, [bridge, engine.kind]);

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

  // 微软返回 300+ 个音色，铺进原生 <select> 会把中文音色淹掉；默认只列中文，
  // 需要外语音色时由「显示全部语言」放开（当前已选中的音色永远保留在列表里）。
  const edgeVoiceOptions = useMemo(() => {
    if (engine.kind !== "edge") return [];
    const all = edgeVoices.length > 0 ? edgeVoices : FALLBACK_EDGE_VOICES;
    const source = showAllEdgeLocales ? all : all.filter((voice) => voice.locale?.startsWith("zh"));
    const options = source.map((voice) => ({ value: voice.id, label: `${voice.label ?? voice.id}${voice.locale ? ` · ${voice.locale}` : ""}` }));
    if (!options.some((option) => option.value === engine.voice)) options.unshift({ value: engine.voice, label: t("voice.voiceCurrent", { voice: engine.voice }) });
    return options;
  }, [edgeVoices, engine, showAllEdgeLocales, t]);

  const test = async () => {
    if (testing) return;
    setTesting(true);
    setTestError(null);
    try {
      await speakText(bridge, tts, t("voice.testText"));
    } catch (error) {
      // 只给用户一句可行动的话；端点地址、HTTP 码、微软的英文提示等只进控制台。
      console.warn("[tts] 试听失败", error);
      setTestError(t("voice.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SwitchRow label={t("voice.autoSpeak")} desc={t("voice.autoSpeakDesc")} value={tts.autoSpeak} onChange={(value) => setTts({ autoSpeak: value })} />
      <SRow label={t("voice.engine")}>
        <SegmentedRadio
          value={engineLabels[ENGINE_OPTIONS.findIndex((option) => option.kind === engine.kind)]!}
          options={engineLabels}
          onChange={(value) => {
            const kind = ENGINE_OPTIONS[engineLabels.indexOf(value)]?.kind;
            if (!kind) return;
            if (kind === "edge") setEngine({ kind, voice: DEFAULT_EDGE_TTS_VOICE });
            else if (kind === "system") setEngine({ kind });
            else setEngine({ kind, baseUrl: "http://localhost:8880", apiKey: "", model: "tts-1", voice: "alloy", language: "zh" });
          }}
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
      ) : engine.kind === "edge" ? (
        <>
          <SRow label={t("voice.voiceLabel")} desc={t("voice.voiceEdgeDesc")}>
            <BareSelect value={engine.voice} options={edgeVoiceOptions} onChange={(value) => setEngine({ ...engine, voice: value })} />
          </SRow>
          <SwitchRow label={t("voice.showAllLocales")} desc={t("voice.showAllLocalesDesc")} value={showAllEdgeLocales} onChange={setShowAllEdgeLocales} />
          <SRow label={t("voice.rate")}>
            <BareSelect value={String(engine.rate ?? 1)} options={SPEECH_RATE_VALUES.map((value) => ({ label: value === "1" ? t("voice.speechRateDefault") : `${value}×`, value }))} onChange={(value) => setEngine({ ...engine, rate: Number(value) })} />
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
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="pw-tl-gen" disabled={testing} onClick={() => void test()}>
            <Icon.Mic size={12} />
            {testing ? t("voice.testPlaying") : t("voice.test")}
          </button>
          <button className="pw-tl-gen" onClick={() => stopSpeaking()}>
            <Icon.Stop size={12} />
            {t("voice.stop")}
          </button>
          {testError ? <span role="alert" style={{ color: "var(--danger, #d44)", fontSize: 12 }}>{testError || t("voice.testFailed")}</span> : null}
        </span>
      </SRow>
    </>
  );
}
