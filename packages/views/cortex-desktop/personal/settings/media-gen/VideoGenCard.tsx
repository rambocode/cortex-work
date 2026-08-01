// 视频生成模态卡：供应商继承 + 按协议动态的分辨率/时长档位。
//
// 协议档位表（来源：Kun settings-section-media-generation.tsx 实测档位，
// 上下限与 core normalize 钳制一致，修 Kun「UI 上限大于钳制上限静默截断」的错位 bug）：
//   · minimax-video    —— 分辨率 768P/1080P；时长 number 1–30s（回落默认 1080P）
//   · grok-imagine-video —— 分辨率 480P/720P；时长 **select** 6s/10s（回落默认 720P/6s）
//   · volcengine-ark-video —— 分辨率 480P/720P/1080P/4K；时长 number 4–15s（回落默认 720P）
// 切协议后当前值不在新档位 → 显示该协议默认（effective 值，Kun 同款做法），用户改动才写回。

import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import type { VideoGenProtocol, VideoGenSettings } from "@cortex-work/core/desktop/types";
import {
  MAX_TIMEOUT_MS_BY_MODALITY,
  MIN_TIMEOUT_MS,
} from "@cortex-work/core/desktop/media-gen-types";
import { mediaCustomSecretName } from "@cortex-work/core/desktop/media-provider-directory";

import { SettingCard, SRow, SwitchRow, BareSelect } from "../settingsControls";
import { BaseUrlRow, ModelRow, ProtocolRow, ProviderRow, TimeoutRow } from "./MediaGenRows";
import { MediaSecretKeyField } from "./MediaSecretKeyField";
import { useMediaGenProviders } from "./useMediaGenProviders";

const VIDEO_PROTOCOLS: readonly VideoGenProtocol[] = [
  "minimax-video",
  "grok-imagine-video",
  "volcengine-ark-video",
];

const MINIMAX_RESOLUTIONS = ["768P", "1080P"] as const;
const GROK_RESOLUTIONS = ["480P", "720P"] as const;
const GROK_DURATIONS = [6, 10] as const;
const VOLCENGINE_RESOLUTIONS = ["480P", "720P", "1080P", "4K"] as const;

export function VideoGenCard() {
  const { t } = useTranslation("settings");
  const video = usePersonalStore((s) => s.mediaGenSettings.video);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);
  const { resolve } = useMediaGenProviders("video");

  const update = (patch: Partial<VideoGenSettings>) => {
    setMediaGenSettings({ video: { ...video, ...patch } });
  };

  const resolved = resolve(video.providerId);
  const usingDirectory = !!resolved?.capability;
  const effectiveProtocol = resolved?.capability?.protocol ?? video.protocol;
  const isGrok = effectiveProtocol === "grok-imagine-video";
  const isVolcengine = effectiveProtocol === "volcengine-ark-video";

  const resolutionOptions: readonly string[] = isGrok
    ? GROK_RESOLUTIONS
    : isVolcengine
      ? VOLCENGINE_RESOLUTIONS
      : MINIMAX_RESOLUTIONS;
  // 回落默认：grok/volcengine → 720P，minimax → 1080P。
  const fallbackResolution = isGrok || isVolcengine ? "720P" : "1080P";
  const effectiveResolution = resolutionOptions.includes(video.defaultResolution)
    ? video.defaultResolution
    : fallbackResolution;

  // 时长上下限随协议：grok 只有 6/10 两档（select）；volcengine 4–15；minimax 1–30。
  const durationMin = isVolcengine ? 4 : 1;
  const durationMax = isVolcengine ? 15 : 30;
  const effectiveDuration = isGrok
    ? (GROK_DURATIONS as readonly number[]).includes(video.defaultDuration)
      ? video.defaultDuration
      : GROK_DURATIONS[0]
    : Math.min(durationMax, Math.max(durationMin, video.defaultDuration));

  return (
    <SettingCard title={t("mediaGen.video.cardTitle")}>
      <SwitchRow
        label={t("mediaGen.video.enableLabel")}
        desc={t("mediaGen.video.enableDesc")}
        value={video.enabled}
        onChange={(v) => update({ enabled: v })}
      />
      {video.enabled ? (
        <>
          <ProviderRow
            modality="video"
            providerId={video.providerId}
            model={video.model}
            label={t("mediaGen.video.providerLabel")}
            desc={t("mediaGen.video.providerDesc")}
            customLabel={t("mediaGen.video.providerCustom")}
            update={(patch) => update(patch as Partial<VideoGenSettings>)}
          />

          {!usingDirectory ? (
            <>
              <ProtocolRow
                protocols={VIDEO_PROTOCOLS}
                value={video.protocol}
                label={t("mediaGen.video.protocolLabel")}
                desc={t("mediaGen.video.protocolDesc")}
                onChange={(v) => update({ protocol: v as VideoGenProtocol })}
              />
              <BaseUrlRow
                value={video.baseUrl}
                desc={t("mediaGen.video.baseUrlDesc")}
                placeholder={t("mediaGen.video.baseUrlPlaceholder")}
                onChange={(v) => update({ baseUrl: v })}
              />
              <MediaSecretKeyField
                secretName={mediaCustomSecretName("video")}
                value={video.apiKey}
                desc={t("mediaGen.video.apiKeyDesc")}
                onChange={(v) => update({ apiKey: v })}
              />
            </>
          ) : null}

          {/* standalone 型（volcengine）：key 内联输入进金库命名 Secret */}
          {usingDirectory && resolved && resolved.entry.kind === "standalone" && resolved.entry.secretName ? (
            <MediaSecretKeyField
              secretName={resolved.entry.secretName}
              value={video.apiKey}
              onChange={(v) => update({ apiKey: v })}
            />
          ) : null}

          <ModelRow
            usingDirectory={usingDirectory}
            models={resolved?.capability?.models ?? []}
            model={video.model}
            label={t("mediaGen.video.modelLabel")}
            desc={t("mediaGen.video.modelDesc")}
            placeholder={t("mediaGen.video.modelPlaceholder")}
            onChange={(v) => update({ model: v })}
          />

          {/* 默认时长：grok 是固定两档 select，其余协议 number 输入（上下限随协议） */}
          <SRow label={t("mediaGen.video.durationLabel")} desc={t("mediaGen.video.durationDesc")} end>
            {isGrok ? (
              <BareSelect
                value={String(effectiveDuration)}
                options={GROK_DURATIONS.map((d) => ({
                  label: t("mediaGen.video.durationSelectOption", { seconds: d }),
                  value: String(d),
                }))}
                onChange={(v) => update({ defaultDuration: Number(v) })}
              />
            ) : (
              <input
                className="pw-set-input"
                type="number"
                min={durationMin}
                max={durationMax}
                step={1}
                value={effectiveDuration}
                onChange={(e) => update({ defaultDuration: Number(e.target.value) })}
              />
            )}
          </SRow>

          {/* 默认分辨率：档位随协议，当前值不在新档位时显示该协议默认 */}
          <SRow label={t("mediaGen.video.resolutionLabel")} desc={t("mediaGen.video.resolutionDesc")} end>
            <BareSelect
              value={effectiveResolution}
              options={resolutionOptions.map((r) => ({ label: r, value: r }))}
              onChange={(v) => update({ defaultResolution: v })}
            />
          </SRow>

          <TimeoutRow
            value={video.timeoutMs}
            min={MIN_TIMEOUT_MS}
            max={MAX_TIMEOUT_MS_BY_MODALITY.video}
            desc={t("mediaGen.video.timeoutDesc")}
            onChange={(v) => update({ timeoutMs: v })}
          />
          <SRow label={t("mediaGen.video.pollIntervalLabel")} desc={t("mediaGen.video.pollIntervalDesc")} end>
            <input
              className="pw-set-input"
              type="number"
              min={1000}
              max={120000}
              step={1000}
              value={video.pollIntervalMs}
              onChange={(e) => update({ pollIntervalMs: Number(e.target.value) })}
            />
          </SRow>
        </>
      ) : null}
    </SettingCard>
  );
}
