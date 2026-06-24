import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore, type ProviderProfile } from "@cortex-work/core";
import type {
  ImageGenSettings,
  MusicGenSettings,
  SpeechGenSettings,
  VideoGenSettings,
} from "@cortex-work/core/desktop/types";

import { BareSelect, SecretField, SettingCard, SRow, SwitchRow } from "./settingsControls";

// ── 常量：各模态支持的协议枚举 ──────────────────────────────────────────────
const IMAGE_PROTOCOLS = ["openai-images", "minimax-image"] as const;
const SPEECH_PROTOCOLS = ["openai-speech", "minimax-t2a", "mimo-tts"] as const;
const MUSIC_PROTOCOLS = ["minimax-music"] as const;
const VIDEO_PROTOCOLS = ["minimax-video"] as const;
const AUDIO_FORMATS = ["mp3", "wav", "flac"] as const;
const VIDEO_RESOLUTIONS = ["768P", "1080P"] as const;

// 「自定义」供应商占位 id；与 Kun 惯例对齐。
const CUSTOM_PROVIDER_ID = "custom";

// ── 辅助：判断供应商下拉值是否为「自定义」 ─────────────────────────────────
function isCustom(providerId: string): boolean {
  return !providerId || providerId === CUSTOM_PROVIDER_ID;
}

// ── 图片生成子区 ─────────────────────────────────────────────────────────────
function ImageSubsection({ providers }: { providers: ProviderProfile[] }) {
  const { t } = useTranslation("settings");
  const image = usePersonalStore((s) => s.mediaGenSettings.image);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);

  const update = (patch: Partial<ImageGenSettings>) => {
    setMediaGenSettings({ image: { ...image, ...patch } });
  };

  // 选已配置供应商时，隐藏 key/baseUrl，改显「使用 <供应商名> 的密钥」提示。
  const usingCustom = isCustom(image.providerId);
  const selectedProvider = usingCustom ? undefined : providers.find((p) => p.id === image.providerId);

  const imageProtocolLabel = (p: string): string => {
    if (p === "minimax-image") return t("mediaGen.image.protocolMiniMax");
    return t("mediaGen.image.protocolOpenAi");
  };

  return (
    <SettingCard title={t("mediaGen.image.cardTitle")}>
      <SwitchRow
        label={t("mediaGen.image.enableLabel")}
        desc={t("mediaGen.image.enableDesc")}
        value={image.enabled}
        onChange={(v) => update({ enabled: v })}
      />
      {image.enabled ? (
        <>
          {/* 供应商下拉：无已配置供应商时只剩「自定义」 */}
          <SRow label={t("mediaGen.providerLabel")} desc={t("mediaGen.providerDesc")} end>
            <BareSelect
              value={usingCustom ? CUSTOM_PROVIDER_ID : image.providerId}
              options={[
                ...providers.map((p) => ({ label: p.name, value: p.id })),
                { label: t("mediaGen.providerCustom"), value: CUSTOM_PROVIDER_ID },
              ]}
              onChange={(id) => {
                if (id === CUSTOM_PROVIDER_ID) {
                  // 切回自定义：保留自填值，不清空
                  update({ providerId: CUSTOM_PROVIDER_ID });
                } else {
                  // 切到已配置供应商：同步 protocol（未来可按供应商能力配置）
                  update({ providerId: id, protocol: "openai-images" });
                }
              }}
            />
          </SRow>

          {/* 已配置供应商：显示密钥提示，不回填、不泄露 */}
          {!usingCustom && selectedProvider ? (
            <div className="pw-srow-desc">
              {t("mediaGen.providerKeyHint", { name: selectedProvider.name })}
            </div>
          ) : null}

          {/* 自定义时：协议 / baseUrl / apiKey */}
          {usingCustom ? (
            <>
              <SRow label={t("mediaGen.protocolLabel")} end>
                <BareSelect
                  value={image.protocol}
                  options={IMAGE_PROTOCOLS.map((p) => ({ label: imageProtocolLabel(p), value: p }))}
                  onChange={(v) => update({ protocol: v as typeof IMAGE_PROTOCOLS[number] })}
                />
              </SRow>
              <div className="pw-sblock">
                <SRow label={t("mediaGen.baseUrlLabel")} end>
                  <input
                    className="pw-set-input"
                    type="url"
                    value={image.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                  />
                </SRow>
                <SecretField
                  label={t("mediaGen.apiKeyLabel")}
                  value={image.apiKey}
                  onChange={(v) => update({ apiKey: v })}
                />
              </div>
            </>
          ) : null}

          {/* 模型输入 */}
          <SRow label={t("mediaGen.modelLabel")} end>
            <input
              className="pw-set-input"
              type="text"
              value={image.model}
              placeholder={t("mediaGen.image.modelPlaceholder")}
              onChange={(e) => update({ model: e.target.value })}
            />
          </SRow>

          {/* 模态特有字段：默认图片尺寸 */}
          <SRow label={t("mediaGen.image.defaultSizeLabel")} end>
            <input
              className="pw-set-input"
              type="text"
              value={image.defaultSize}
              placeholder={t("mediaGen.image.defaultSizePlaceholder")}
              onChange={(e) => update({ defaultSize: e.target.value })}
            />
          </SRow>
        </>
      ) : null}
    </SettingCard>
  );
}

// ── 语音合成子区 ─────────────────────────────────────────────────────────────
function SpeechSubsection({ providers }: { providers: ProviderProfile[] }) {
  const { t } = useTranslation("settings");
  const speech = usePersonalStore((s) => s.mediaGenSettings.speech);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);

  const update = (patch: Partial<SpeechGenSettings>) => {
    setMediaGenSettings({ speech: { ...speech, ...patch } });
  };

  const usingCustom = isCustom(speech.providerId);
  const selectedProvider = usingCustom ? undefined : providers.find((p) => p.id === speech.providerId);

  const speechProtocolLabel = (p: string): string => {
    if (p === "minimax-t2a") return t("mediaGen.speech.protocolMiniMax");
    if (p === "mimo-tts") return t("mediaGen.speech.protocolMimo");
    return t("mediaGen.speech.protocolOpenAi");
  };

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
          <SRow label={t("mediaGen.providerLabel")} desc={t("mediaGen.providerDesc")} end>
            <BareSelect
              value={usingCustom ? CUSTOM_PROVIDER_ID : speech.providerId}
              options={[
                ...providers.map((p) => ({ label: p.name, value: p.id })),
                { label: t("mediaGen.providerCustom"), value: CUSTOM_PROVIDER_ID },
              ]}
              onChange={(id) => {
                if (id === CUSTOM_PROVIDER_ID) {
                  update({ providerId: CUSTOM_PROVIDER_ID });
                } else {
                  update({ providerId: id, protocol: "openai-speech" });
                }
              }}
            />
          </SRow>

          {!usingCustom && selectedProvider ? (
            <div className="pw-srow-desc">
              {t("mediaGen.providerKeyHint", { name: selectedProvider.name })}
            </div>
          ) : null}

          {usingCustom ? (
            <>
              <SRow label={t("mediaGen.protocolLabel")} end>
                <BareSelect
                  value={speech.protocol}
                  options={SPEECH_PROTOCOLS.map((p) => ({ label: speechProtocolLabel(p), value: p }))}
                  onChange={(v) => update({ protocol: v as typeof SPEECH_PROTOCOLS[number] })}
                />
              </SRow>
              <div className="pw-sblock">
                <SRow label={t("mediaGen.baseUrlLabel")} end>
                  <input
                    className="pw-set-input"
                    type="url"
                    value={speech.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                  />
                </SRow>
                <SecretField
                  label={t("mediaGen.apiKeyLabel")}
                  value={speech.apiKey}
                  onChange={(v) => update({ apiKey: v })}
                />
              </div>
            </>
          ) : null}

          <SRow label={t("mediaGen.modelLabel")} end>
            <input
              className="pw-set-input"
              type="text"
              value={speech.model}
              placeholder={t("mediaGen.speech.modelPlaceholder")}
              onChange={(e) => update({ model: e.target.value })}
            />
          </SRow>

          {/* 模态特有字段：voice / format */}
          <SRow label={t("mediaGen.speech.voiceLabel")} end>
            <input
              className="pw-set-input"
              type="text"
              value={speech.voice}
              placeholder={t("mediaGen.speech.voicePlaceholder")}
              onChange={(e) => update({ voice: e.target.value })}
            />
          </SRow>
          <SRow label={t("mediaGen.speech.formatLabel")} end>
            <BareSelect
              value={speech.format}
              options={AUDIO_FORMATS.map((f) => ({ label: f, value: f }))}
              onChange={(v) => update({ format: v })}
            />
          </SRow>
        </>
      ) : null}
    </SettingCard>
  );
}

// ── 音乐生成子区 ─────────────────────────────────────────────────────────────
function MusicSubsection({ providers }: { providers: ProviderProfile[] }) {
  const { t } = useTranslation("settings");
  const music = usePersonalStore((s) => s.mediaGenSettings.music);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);

  const update = (patch: Partial<MusicGenSettings>) => {
    setMediaGenSettings({ music: { ...music, ...patch } });
  };

  const usingCustom = isCustom(music.providerId);
  const selectedProvider = usingCustom ? undefined : providers.find((p) => p.id === music.providerId);

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
          <SRow label={t("mediaGen.providerLabel")} desc={t("mediaGen.providerDesc")} end>
            <BareSelect
              value={usingCustom ? CUSTOM_PROVIDER_ID : music.providerId}
              options={[
                ...providers.map((p) => ({ label: p.name, value: p.id })),
                { label: t("mediaGen.providerCustom"), value: CUSTOM_PROVIDER_ID },
              ]}
              onChange={(id) => {
                if (id === CUSTOM_PROVIDER_ID) {
                  update({ providerId: CUSTOM_PROVIDER_ID });
                } else {
                  update({ providerId: id, protocol: "minimax-music" });
                }
              }}
            />
          </SRow>

          {!usingCustom && selectedProvider ? (
            <div className="pw-srow-desc">
              {t("mediaGen.providerKeyHint", { name: selectedProvider.name })}
            </div>
          ) : null}

          {usingCustom ? (
            <>
              <SRow label={t("mediaGen.protocolLabel")} end>
                <BareSelect
                  value={music.protocol}
                  options={MUSIC_PROTOCOLS.map((p) => ({ label: t("mediaGen.music.protocolMiniMax"), value: p }))}
                  onChange={(v) => update({ protocol: v as typeof MUSIC_PROTOCOLS[number] })}
                />
              </SRow>
              <div className="pw-sblock">
                <SRow label={t("mediaGen.baseUrlLabel")} end>
                  <input
                    className="pw-set-input"
                    type="url"
                    value={music.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                  />
                </SRow>
                <SecretField
                  label={t("mediaGen.apiKeyLabel")}
                  value={music.apiKey}
                  onChange={(v) => update({ apiKey: v })}
                />
              </div>
            </>
          ) : null}

          <SRow label={t("mediaGen.modelLabel")} end>
            <input
              className="pw-set-input"
              type="text"
              value={music.model}
              placeholder={t("mediaGen.music.modelPlaceholder")}
              onChange={(e) => update({ model: e.target.value })}
            />
          </SRow>

          {/* 模态特有字段：format */}
          <SRow label={t("mediaGen.music.formatLabel")} end>
            <BareSelect
              value={music.format}
              options={AUDIO_FORMATS.map((f) => ({ label: f, value: f }))}
              onChange={(v) => update({ format: v })}
            />
          </SRow>
        </>
      ) : null}
    </SettingCard>
  );
}

// ── 视频生成子区 ─────────────────────────────────────────────────────────────
function VideoSubsection({ providers }: { providers: ProviderProfile[] }) {
  const { t } = useTranslation("settings");
  const video = usePersonalStore((s) => s.mediaGenSettings.video);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);

  const update = (patch: Partial<VideoGenSettings>) => {
    setMediaGenSettings({ video: { ...video, ...patch } });
  };

  const usingCustom = isCustom(video.providerId);
  const selectedProvider = usingCustom ? undefined : providers.find((p) => p.id === video.providerId);

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
          <SRow label={t("mediaGen.providerLabel")} desc={t("mediaGen.providerDesc")} end>
            <BareSelect
              value={usingCustom ? CUSTOM_PROVIDER_ID : video.providerId}
              options={[
                ...providers.map((p) => ({ label: p.name, value: p.id })),
                { label: t("mediaGen.providerCustom"), value: CUSTOM_PROVIDER_ID },
              ]}
              onChange={(id) => {
                if (id === CUSTOM_PROVIDER_ID) {
                  update({ providerId: CUSTOM_PROVIDER_ID });
                } else {
                  update({ providerId: id, protocol: "minimax-video" });
                }
              }}
            />
          </SRow>

          {!usingCustom && selectedProvider ? (
            <div className="pw-srow-desc">
              {t("mediaGen.providerKeyHint", { name: selectedProvider.name })}
            </div>
          ) : null}

          {usingCustom ? (
            <>
              <SRow label={t("mediaGen.protocolLabel")} end>
                <BareSelect
                  value={video.protocol}
                  options={VIDEO_PROTOCOLS.map((p) => ({ label: t("mediaGen.video.protocolMiniMax"), value: p }))}
                  onChange={(v) => update({ protocol: v as typeof VIDEO_PROTOCOLS[number] })}
                />
              </SRow>
              <div className="pw-sblock">
                <SRow label={t("mediaGen.baseUrlLabel")} end>
                  <input
                    className="pw-set-input"
                    type="url"
                    value={video.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                  />
                </SRow>
                <SecretField
                  label={t("mediaGen.apiKeyLabel")}
                  value={video.apiKey}
                  onChange={(v) => update({ apiKey: v })}
                />
              </div>
            </>
          ) : null}

          <SRow label={t("mediaGen.modelLabel")} end>
            <input
              className="pw-set-input"
              type="text"
              value={video.model}
              placeholder={t("mediaGen.video.modelPlaceholder")}
              onChange={(e) => update({ model: e.target.value })}
            />
          </SRow>

          {/* 模态特有字段：时长 / 分辨率 / 轮询间隔 */}
          <SRow label={t("mediaGen.video.durationLabel")} end>
            <input
              className="pw-set-input"
              type="number"
              min={1}
              max={60}
              step={1}
              value={video.defaultDuration}
              onChange={(e) => update({ defaultDuration: Number(e.target.value) })}
            />
          </SRow>
          <SRow label={t("mediaGen.video.resolutionLabel")} end>
            <BareSelect
              value={video.defaultResolution}
              options={VIDEO_RESOLUTIONS.map((r) => ({ label: r, value: r }))}
              onChange={(v) => update({ defaultResolution: v })}
            />
          </SRow>
          <SRow label={t("mediaGen.video.pollIntervalLabel")} end>
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

// ── 主 Section 组件 ───────────────────────────────────────────────────────────
// 读 providerSettings.providers，过滤出「已配置（enabled=true, apiKey 不为空或 baseUrl 不为空）」的供应商，
// 供四个子区的供应商下拉复用。当前 cortex-work ProviderProfile 无模态能力字段，
// 故直接把所有 enabled 供应商展示在所有模态下拉——用户自行选择匹配的供应商。
export function MediaGenSettingsSection() {
  const { t } = useTranslation("settings");
  const providerSettings = usePersonalStore((s) => s.providerSettings);

  // 只显示 enabled 且有 apiKey 或 baseUrl 的供应商，避免展示空壳
  const configuredProviders = (providerSettings?.providers ?? []).filter(
    (p) => p.enabled && (p.apiKey?.trim() || p.baseUrl?.trim()),
  );

  return (
    <>
      {/* 总览说明卡 */}
      <SettingCard title={t("mediaGen.overviewCard")}>
        <div className="pw-srow-desc">{t("mediaGen.overviewDesc")}</div>
      </SettingCard>

      {/* 图片生成 */}
      <ImageSubsection providers={configuredProviders} />

      {/* 语音合成 */}
      <SpeechSubsection providers={configuredProviders} />

      {/* 音乐生成 */}
      <MusicSubsection providers={configuredProviders} />

      {/* 视频生成 */}
      <VideoSubsection providers={configuredProviders} />
    </>
  );
}
