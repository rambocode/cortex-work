// 图片生成模态卡（对齐 Kun settings-section-image-generation.tsx 的交互，修其已知 bug）。
// 动态选项规则见各常量注释；分辨率/画质档位与 core normalize 的合法域完全一致。

import { useEffect, useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import type { ImageGenProtocol, ImageGenSettings } from "@cortex-work/core/desktop/types";
import {
  MAX_TIMEOUT_MS_BY_MODALITY,
  MIN_TIMEOUT_MS,
} from "@cortex-work/core/desktop/media-gen-types";
import { mediaCustomSecretName } from "@cortex-work/core/desktop/media-provider-directory";

import { SettingCard, SRow, SwitchRow, BareSelect } from "../settingsControls";
import { BaseUrlRow, ModelRow, ProtocolRow, ProviderRow, TimeoutRow } from "./MediaGenRows";
import { MediaSecretKeyField } from "./MediaSecretKeyField";
import { useMediaGenProviders } from "./useMediaGenProviders";

const IMAGE_PROTOCOLS: readonly ImageGenProtocol[] = [
  "openai-images",
  "minimax-image",
  "grok-imagine-image",
  "volcengine-ark-image",
];

const IMAGE_QUALITIES = ["auto", "low", "medium", "high"] as const;

// 分辨率档位按协议分叉（Kun 火山特化）：volcengine Seedream 只接受 2K/3K/4K，
// 其余协议 auto/1K/2K。当前值不在档位内时显示档位首项（effective 值），不静默写回。
const VOLCENGINE_IMAGE_RESOLUTIONS = ["2K", "3K", "4K"] as const;
const DEFAULT_IMAGE_RESOLUTIONS = ["auto", "1K", "2K"] as const;

// defaultSize 合法形状，与 core normalizeMediaGenSettings 的 DEFAULT_SIZE_RE 一致。
const DEFAULT_SIZE_RE = /^\d{2,5}x\d{2,5}$/;

export function ImageGenCard() {
  const { t } = useTranslation("settings");
  const image = usePersonalStore((s) => s.mediaGenSettings.image);
  const setMediaGenSettings = usePersonalStore((s) => s.setMediaGenSettings);
  const { resolve } = useMediaGenProviders("image");

  const update = (patch: Partial<ImageGenSettings>) => {
    setMediaGenSettings({ image: { ...image, ...patch } });
  };

  const resolved = resolve(image.providerId);
  const usingDirectory = !!resolved?.capability;
  // 生效协议：目录态以 capability 为准（settings.protocol 已由 ProviderRow 同步，但显示以目录为唯一真相）。
  const effectiveProtocol = resolved?.capability?.protocol ?? image.protocol;
  const isVolcengine = effectiveProtocol === "volcengine-ark-image";
  const resolutionOptions: readonly string[] = isVolcengine
    ? VOLCENGINE_IMAGE_RESOLUTIONS
    : DEFAULT_IMAGE_RESOLUTIONS;
  const effectiveResolution = resolutionOptions.includes(image.defaultResolution)
    ? image.defaultResolution
    : (resolutionOptions[0] ?? "auto");

  // defaultSize 即时校验：非法值只留在本地草稿（红框提示），不写入 store——
  // store 里永远是空串或合法 "WxH"，与 normalize 的置空规则互为兜底。
  const [sizeDraft, setSizeDraft] = useState(image.defaultSize);
  useEffect(() => {
    setSizeDraft(image.defaultSize);
  }, [image.defaultSize]);
  const sizeTrimmed = sizeDraft.trim();
  const sizeValid = sizeTrimmed === "" || DEFAULT_SIZE_RE.test(sizeTrimmed);
  const handleSizeChange = (v: string) => {
    setSizeDraft(v);
    const trimmed = v.trim();
    if (trimmed === "" || DEFAULT_SIZE_RE.test(trimmed)) update({ defaultSize: trimmed });
  };

  const qualityLabel = (q: string): string => {
    if (q === "low") return t("mediaGen.image.qualityLow");
    if (q === "medium") return t("mediaGen.image.qualityMedium");
    if (q === "high") return t("mediaGen.image.qualityHigh");
    return t("mediaGen.image.qualityAuto");
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
          <ProviderRow
            modality="image"
            providerId={image.providerId}
            model={image.model}
            label={t("mediaGen.image.providerLabel")}
            desc={t("mediaGen.image.providerDesc")}
            customLabel={t("mediaGen.image.providerCustom")}
            // ProviderRow 只会回传目录 capability 的协议值，此处收窄为图片协议枚举是安全的。
            update={(patch) => update(patch as Partial<ImageGenSettings>)}
          />

          {/* 自定义态：协议 / baseUrl / 金库密钥三行（目录态隐藏，密钥走 Provider 设置或内联 Secret） */}
          {!usingDirectory ? (
            <>
              <ProtocolRow
                protocols={IMAGE_PROTOCOLS}
                value={image.protocol}
                label={t("mediaGen.image.protocolLabel")}
                desc={t("mediaGen.image.protocolDesc")}
                onChange={(v) => update({ protocol: v as ImageGenProtocol })}
              />
              <BaseUrlRow
                value={image.baseUrl}
                desc={t("mediaGen.image.baseUrlDesc")}
                placeholder={t("mediaGen.image.baseUrlPlaceholder")}
                onChange={(v) => update({ baseUrl: v })}
              />
              <MediaSecretKeyField
                secretName={mediaCustomSecretName("image")}
                value={image.apiKey}
                desc={t("mediaGen.image.apiKeyDesc")}
                onChange={(v) => update({ apiKey: v })}
              />
            </>
          ) : null}

          {/* standalone 型（volcengine）：key 不在 pi Provider Catalog 里，内联输入进金库命名 Secret */}
          {usingDirectory && resolved && resolved.entry.kind === "standalone" && resolved.entry.secretName ? (
            <MediaSecretKeyField
              secretName={resolved.entry.secretName}
              value={image.apiKey}
              onChange={(v) => update({ apiKey: v })}
            />
          ) : null}

          <ModelRow
            usingDirectory={usingDirectory}
            models={resolved?.capability?.models ?? []}
            model={image.model}
            label={t("mediaGen.image.modelLabel")}
            desc={t("mediaGen.image.modelDesc")}
            placeholder={t("mediaGen.image.modelPlaceholder")}
            onChange={(v) => update({ model: v })}
          />

          {/* 模型选择建议（Kun imageGenModelQualityHint 的提示框） */}
          <div className="pw-mediagen-hint">{t("mediaGen.image.modelQualityHint")}</div>

          {/* 画质档位：与分辨率相互独立，"auto" 由供应商决定 */}
          <SRow label={t("mediaGen.image.qualityLabel")} desc={t("mediaGen.image.qualityDesc")} end>
            <BareSelect
              value={image.quality}
              options={IMAGE_QUALITIES.map((q) => ({ label: qualityLabel(q), value: q }))}
              onChange={(v) => update({ quality: v as ImageGenSettings["quality"] })}
            />
          </SRow>

          {/* 默认分辨率：档位随协议切换，当前值不在新档位时显示档位首项 */}
          <SRow label={t("mediaGen.image.resolutionLabel")} desc={t("mediaGen.image.resolutionDesc")} end>
            <BareSelect
              value={effectiveResolution}
              options={resolutionOptions.map((r) => ({
                label: r === "auto" ? t("mediaGen.image.resolutionAuto") : r,
                value: r,
              }))}
              onChange={(v) => update({ defaultResolution: v as ImageGenSettings["defaultResolution"] })}
            />
          </SRow>

          {/* 默认尺寸（优先级高于 defaultResolution，MCP 层执行）；非法输入红框不写入 */}
          <SRow label={t("mediaGen.image.defaultSizeLabel")} desc={t("mediaGen.image.defaultSizeDesc")} end>
            <input
              className="pw-set-input"
              type="text"
              value={sizeDraft}
              placeholder={t("mediaGen.image.defaultSizePlaceholder")}
              aria-invalid={!sizeValid}
              style={!sizeValid ? { borderColor: "#d9534f" } : undefined}
              onChange={(e) => handleSizeChange(e.target.value)}
            />
            {!sizeValid ? (
              <span className="pw-srow-desc" role="alert">
                {t("mediaGen.image.defaultSizeInvalid")}
              </span>
            ) : null}
          </SRow>

          <TimeoutRow
            value={image.timeoutMs}
            min={MIN_TIMEOUT_MS}
            max={MAX_TIMEOUT_MS_BY_MODALITY.image}
            desc={t("mediaGen.image.timeoutDesc")}
            onChange={(v) => update({ timeoutMs: v })}
          />
        </>
      ) : null}
    </SettingCard>
  );
}
