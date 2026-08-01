// 音乐生成模态卡：供应商继承 + format 模态特有字段。

import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import type { MusicGenProtocol, MusicGenSettings } from "@cortex-work/core/desktop/types";
import {
  MAX_TIMEOUT_MS_BY_MODALITY,
  MIN_TIMEOUT_MS,
} from "@cortex-work/core/desktop/media-gen-types";
import { mediaCustomSecretName } from "@cortex-work/core/desktop/media-provider-directory";

import { SettingCard, SwitchRow } from "../settingsControls";
import { BaseUrlRow, FormatRow, ModelRow, ProtocolRow, ProviderRow, TimeoutRow } from "./MediaGenRows";
import { MediaSecretKeyField } from "./MediaSecretKeyField";
import { useMediaGenProviders } from "./useMediaGenProviders";

const MUSIC_PROTOCOLS: readonly MusicGenProtocol[] = ["minimax-music"];

export function MusicGenCard() {
  const { t } = useTranslation("settings");
  const music = usePersonalStore((s) => s.mediaGenSettings.music);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);
  const { resolve } = useMediaGenProviders("music");

  const update = (patch: Partial<MusicGenSettings>) => {
    setMediaGenSettings({ music: { ...music, ...patch } });
  };

  const resolved = resolve(music.providerId);
  const usingDirectory = !!resolved?.capability;

  return (
    <SettingCard title={t("mediaGen.music.cardTitle")}>
      <SwitchRow
        label={t("mediaGen.music.enableLabel")}
        desc={t("mediaGen.music.enableDesc")}
        value={music.enabled}
        onChange={(v) => update({ enabled: v })}
      />
      {music.enabled ? (
        <>
          <ProviderRow
            modality="music"
            providerId={music.providerId}
            model={music.model}
            update={(patch) => update(patch as Partial<MusicGenSettings>)}
          />

          {!usingDirectory ? (
            <>
              <ProtocolRow
                protocols={MUSIC_PROTOCOLS}
                value={music.protocol}
                onChange={(v) => update({ protocol: v as MusicGenProtocol })}
              />
              <BaseUrlRow value={music.baseUrl} onChange={(v) => update({ baseUrl: v })} />
              <MediaSecretKeyField
                secretName={mediaCustomSecretName("music")}
                value={music.apiKey}
                onChange={(v) => update({ apiKey: v })}
              />
            </>
          ) : null}

          {/* music 模态目前无 standalone 供应商；保留判断防目录扩充后遗漏内联密钥入口 */}
          {usingDirectory && resolved && resolved.entry.kind === "standalone" && resolved.entry.secretName ? (
            <MediaSecretKeyField
              secretName={resolved.entry.secretName}
              value={music.apiKey}
              onChange={(v) => update({ apiKey: v })}
            />
          ) : null}

          <ModelRow
            usingDirectory={usingDirectory}
            models={resolved?.capability?.models ?? []}
            model={music.model}
            placeholder={t("mediaGen.music.modelPlaceholder")}
            onChange={(v) => update({ model: v })}
          />
          <FormatRow
            label={t("mediaGen.music.formatLabel")}
            value={music.format}
            onChange={(v) => update({ format: v })}
          />
          <TimeoutRow
            value={music.timeoutMs}
            min={MIN_TIMEOUT_MS}
            max={MAX_TIMEOUT_MS_BY_MODALITY.music}
            onChange={(v) => update({ timeoutMs: v })}
          />
        </>
      ) : null}
    </SettingCard>
  );
}
