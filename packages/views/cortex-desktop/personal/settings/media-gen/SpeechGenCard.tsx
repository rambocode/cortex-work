// 语音合成（TTS）模态卡：供应商继承 + voice/format 模态特有字段。

import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import type { SpeechGenProtocol, SpeechGenSettings } from "@cortex-work/core/desktop/types";
import {
  MAX_TIMEOUT_MS_BY_MODALITY,
  MIN_TIMEOUT_MS,
} from "@cortex-work/core/desktop/media-gen-types";
import { mediaCustomSecretName } from "@cortex-work/core/desktop/media-provider-directory";

import { SettingCard, SRow, SwitchRow } from "../settingsControls";
import { BaseUrlRow, FormatRow, ModelRow, ProtocolRow, ProviderRow, TimeoutRow } from "./MediaGenRows";
import { MediaSecretKeyField } from "./MediaSecretKeyField";
import { useMediaGenProviders } from "./useMediaGenProviders";

const SPEECH_PROTOCOLS: readonly SpeechGenProtocol[] = ["openai-speech", "minimax-t2a", "mimo-tts"];

export function SpeechGenCard() {
  const { t } = useTranslation("settings");
  const speech = usePersonalStore((s) => s.mediaGenSettings.speech);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);
  const { resolve } = useMediaGenProviders("speech");

  const update = (patch: Partial<SpeechGenSettings>) => {
    setMediaGenSettings({ speech: { ...speech, ...patch } });
  };

  const resolved = resolve(speech.providerId);
  const usingDirectory = !!resolved?.capability;

  return (
    <SettingCard title={t("mediaGen.speech.cardTitle")}>
      <SwitchRow
        label={t("mediaGen.speech.enableLabel")}
        desc={t("mediaGen.speech.enableDesc")}
        value={speech.enabled}
        onChange={(v) => update({ enabled: v })}
      />
      {speech.enabled ? (
        <>
          <ProviderRow
            modality="speech"
            providerId={speech.providerId}
            model={speech.model}
            update={(patch) => update(patch as Partial<SpeechGenSettings>)}
          />

          {!usingDirectory ? (
            <>
              <ProtocolRow
                protocols={SPEECH_PROTOCOLS}
                value={speech.protocol}
                onChange={(v) => update({ protocol: v as SpeechGenProtocol })}
              />
              <BaseUrlRow value={speech.baseUrl} onChange={(v) => update({ baseUrl: v })} />
              <MediaSecretKeyField
                secretName={mediaCustomSecretName("speech")}
                value={speech.apiKey}
                onChange={(v) => update({ apiKey: v })}
              />
            </>
          ) : null}

          {/* speech 模态目前无 standalone 供应商；保留判断防目录扩充后遗漏内联密钥入口 */}
          {usingDirectory && resolved && resolved.entry.kind === "standalone" && resolved.entry.secretName ? (
            <MediaSecretKeyField
              secretName={resolved.entry.secretName}
              value={speech.apiKey}
              onChange={(v) => update({ apiKey: v })}
            />
          ) : null}

          <ModelRow
            usingDirectory={usingDirectory}
            models={resolved?.capability?.models ?? []}
            model={speech.model}
            placeholder={t("mediaGen.speech.modelPlaceholder")}
            onChange={(v) => update({ model: v })}
          />

          <SRow label={t("mediaGen.speech.voiceLabel")} end>
            <input
              className="pw-set-input"
              type="text"
              value={speech.voice}
              placeholder={t("mediaGen.speech.voicePlaceholder")}
              onChange={(e) => update({ voice: e.target.value })}
            />
          </SRow>
          <FormatRow
            label={t("mediaGen.speech.formatLabel")}
            value={speech.format}
            onChange={(v) => update({ format: v })}
          />
          <TimeoutRow
            value={speech.timeoutMs}
            min={MIN_TIMEOUT_MS}
            max={MAX_TIMEOUT_MS_BY_MODALITY.speech}
            onChange={(v) => update({ timeoutMs: v })}
          />
        </>
      ) : null}
    </SettingCard>
  );
}
