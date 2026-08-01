// 媒体生成四张模态卡共享的行组件（对齐 Kun settings-section-media-generation 的六个
// render 函数模式）：ProviderRow / ProtocolRow / BaseUrlRow / ModelRow / FormatRow / TimeoutRow。
// 协议展示名一律走 protocolLabel 的 i18n 查表——修 Kun 音乐协议标签硬编码的已知 bug，勿回退成字面量。

import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalStore } from "@cortex-work/core";
import {
  mediaCapabilityOf,
  type MediaModality,
} from "@cortex-work/core/desktop/media-provider-directory";

import { BareSelect, SRow } from "../settingsControls";
import {
  CUSTOM_PROVIDER_ID,
  useMediaGenProviders,
} from "./useMediaGenProviders";

const AUDIO_FORMATS = ["mp3", "wav", "flac"] as const;

// 协议 → i18n key 查表（settings 命名空间）。新增协议必须同步补表，缺表会直接显示原始 id，
// 测试与 code review 都容易发现——刻意不做兜底翻译。
const PROTOCOL_LABEL_KEYS: Record<string, string> = {
  "openai-images": "mediaGen.image.protocolOpenAi",
  "minimax-image": "mediaGen.image.protocolMiniMax",
  "grok-imagine-image": "mediaGen.image.protocolGrok",
  "volcengine-ark-image": "mediaGen.image.protocolVolcengine",
  "openai-speech": "mediaGen.speech.protocolOpenAi",
  "minimax-t2a": "mediaGen.speech.protocolMiniMax",
  "mimo-tts": "mediaGen.speech.protocolMimo",
  "minimax-music": "mediaGen.music.protocolMiniMax",
  "minimax-video": "mediaGen.video.protocolMiniMax",
  "grok-imagine-video": "mediaGen.video.protocolGrok",
  "volcengine-ark-video": "mediaGen.video.protocolVolcengine",
};

/** 协议展示名：查 i18n 表，缺表回落原始 id（便于及时发现漏表）。*/
export function protocolLabel(t: (key: string) => string, protocol: string): string {
  const key = PROTOCOL_LABEL_KEYS[protocol];
  return key ? t(key) : protocol;
}

/**
 * 供应商下拉行 + 配置状态提示。
 *
 * 选目录供应商时写 providerId 并同步 protocol/model；**刻意不清空自填 baseUrl/apiKey**
 * （Kun 语音/音乐/视频侧切 provider 清空自填值是 bug，不搬）——自填值仅 custom 态
 * 可见/生效，保留它们让用户切回自定义时无损。model 则必须同步：主进程 resolve 以
 * settings.model 优先（settings.model || capability.models[0]），残留的自定义模型名
 * 会被误发给目录供应商，故切换时若当前值不在能力列表内改写为首个目录模型。
 */
export function ProviderRow({
  modality,
  providerId,
  model,
  update,
}: {
  modality: MediaModality;
  providerId: string;
  model: string;
  /** protocol 由 capability 同步而来，模态卡侧收窄为各自的协议枚举（值必合法）。*/
  update: (patch: { providerId: string; protocol?: string; model?: string }) => void;
}) {
  const { t } = useTranslation("settings");
  const { options, resolve, authFor, authUnsupported } = useMediaGenProviders(modality);
  const openSettings = usePersonalStore((s) => s.openSettings);

  const resolved = resolve(providerId);
  const usingDirectory = !!resolved?.capability;

  const handleChange = (id: string) => {
    if (id === CUSTOM_PROVIDER_ID) {
      // 切回自定义：只改 providerId，自填 protocol/baseUrl/apiKey/model 原样保留。
      update({ providerId: CUSTOM_PROVIDER_ID });
      return;
    }
    const next = resolve(id);
    const capability = next ? mediaCapabilityOf(next.entry, modality) : undefined;
    if (!capability) return; // 下拉候选保证有能力，此处只是类型收窄
    update({
      providerId: id,
      protocol: capability.protocol,
      model: capability.models.includes(model) ? model : capability.models[0],
    });
  };

  return (
    <>
      <SRow label={t("mediaGen.providerLabel")} desc={t("mediaGen.providerDesc")} end>
        <BareSelect
          value={usingDirectory && resolved ? resolved.entry.id : CUSTOM_PROVIDER_ID}
          options={options}
          onChange={handleChange}
        />
      </SRow>

      {/* catalog 型的密钥状态提示：桥不可用时状态未知，不渲染以免误导。
          standalone 型（volcengine）不在此提示——模态卡内联 MediaSecretKeyField。 */}
      {usingDirectory && resolved && resolved.entry.kind === "catalog" && !authUnsupported
        ? (() => {
            const auth = authFor(resolved.entry);
            if (auth.configured && auth.oauth) {
              return (
                <div className="pw-prov-alert is-warn" role="status">
                  {t("mediaGen.providerOauthUnsupported")}
                </div>
              );
            }
            if (auth.configured) {
              return (
                <div className="pw-srow-desc">
                  {t("mediaGen.providerKeyManagedHint", { name: resolved.entry.name })}
                </div>
              );
            }
            return (
              <div className="pw-prov-alert is-warn" role="status">
                {t("mediaGen.providerNotConfigured", { name: resolved.entry.name })}
                <div>
                  {/* 跳到 设置→Pi（Provider 管理已并入 Pi 分区），经既有 settingsTab 导航。 */}
                  <button type="button" className="pw-mode-block-btn" onClick={() => openSettings("pi")}>
                    {t("mediaGen.providerConfigureAction")}
                  </button>
                </div>
              </div>
            );
          })()
        : null}
    </>
  );
}

/** 协议下拉行（仅 custom 态渲染）；label 走 protocolLabel 查表。*/
export function ProtocolRow({
  protocols,
  value,
  onChange,
}: {
  protocols: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SRow label={t("mediaGen.protocolLabel")} end>
      <BareSelect
        value={value}
        options={protocols.map((p) => ({ label: protocolLabel(t, p), value: p }))}
        onChange={onChange}
      />
    </SRow>
  );
}

/** API 地址输入行（仅 custom 态渲染）。*/
export function BaseUrlRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation("settings");
  return (
    <SRow label={t("mediaGen.baseUrlLabel")} end>
      <input
        className="pw-set-input"
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </SRow>
  );
}

/**
 * 模型行：目录态 = capability.models 下拉（当前值不在列表内时显示首个目录模型，
 * 与 ProviderRow 切换时的回写规则一致）；custom 态 = 自由输入。
 */
export function ModelRow({
  usingDirectory,
  models,
  model,
  placeholder,
  onChange,
}: {
  usingDirectory: boolean;
  models: readonly string[];
  model: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SRow label={t("mediaGen.modelLabel")} end>
      {usingDirectory ? (
        <BareSelect
          value={models.includes(model) ? model : (models[0] ?? "")}
          options={models.map((m) => ({ label: m, value: m }))}
          onChange={onChange}
        />
      ) : (
        <input
          className="pw-set-input"
          type="text"
          value={model}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </SRow>
  );
}

/** 音频输出格式行（speech/music 共用）。*/
export function FormatRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <SRow label={label} end>
      <BareSelect
        value={value}
        options={AUDIO_FORMATS.map((f) => ({ label: f, value: f }))}
        onChange={onChange}
      />
    </SRow>
  );
}

/**
 * 超时行。min/max 必须来自 MIN_TIMEOUT_MS / MAX_TIMEOUT_MS_BY_MODALITY（core 钳制表），
 * 与 normalize / resolve 三处一致——不复刻 Kun「UI 上限大于钳制上限导致静默截断」的 bug。
 */
export function TimeoutRow({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SRow label={t("mediaGen.timeoutLabel")} end>
      <input
        className="pw-set-input"
        type="number"
        min={min}
        max={max}
        step={10_000}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </SRow>
  );
}
