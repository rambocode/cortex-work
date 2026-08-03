// 「添加自定义供应商」的预制表单（对齐原型）：预设 chips（Ollama / LM Studio / vLLM /
// new-api 中转）+ 名称 / API 协议 / Base URL / API Key(可选) / 模型 ID，外加一行**显式的
// 模型能力声明**（上下文窗口 / 最大输出 / 图片 / 推理）。
//
// 与能力红线的关系（为什么表单比原型多一行）：主进程校验 models[] 的
// input/reasoning/contextWindow/maxTokens 缺一即拒绝保存，且 Cortex 绝不替用户猜默认值
//（事故根因，见 custom-providers.ts 文件头）。因此这些值必须由用户在表单里**亲手声明**，
// 应用到本次列出的全部模型。cost 固定全 0：本地不做计费，是「确定的取值」而非能力猜测
//（与 agents/pi-providers.ts 的既有先例同源）。
//
// API Key 永不内嵌明文：表单生成 `${secret:NAME}` 引用写进 JSON，真值先经
// providerAuthSetSecrets 进 safeStorage（顺序不能反——主进程保存时会拒绝未定义的引用）。

import { useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import type { CustomProviderDefinition } from "@cortex-work/core/desktop/provider-catalog";
import { secretNameFor, slugifyProviderId } from "./customProviderRules";
import { useCustomProviderActions, useProviderAuthActions } from "./useProviderData";

/** 原型里的四个预设：一键填充名称 / Base URL / 协议。api 均为 OpenAI 兼容。 */
const PRESETS = [
  { key: "ollama", name: "Ollama", base: "http://localhost:11434/v1", local: true },
  { key: "lmstudio", name: "LM Studio", base: "http://localhost:1234/v1", local: true },
  { key: "vllm", name: "vLLM", base: "http://localhost:8000/v1", local: true },
  { key: "relay", name: "new-api", base: "https://your-relay.example.com/v1", local: false },
] as const;

/** 表单开放的协议子集（都在主进程 KNOWN_APIS 白名单内）；更冷门的协议走 JSON 模式。 */
const API_OPTIONS = [
  { id: "openai-completions", label: "OpenAI Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
] as const;

export function CustomProviderForm({
  storageAvailable,
  onClose,
  /** 「改用 JSON 粘贴」：把当前表单内容生成的 JSON 草稿带进编辑器，避免重填。 */
  onSwitchToJson,
}: {
  storageAvailable: boolean;
  onClose: () => void;
  onSwitchToJson: (draft?: CustomProviderDefinition) => void;
}) {
  const { t } = useTranslation("settings");
  const { save } = useCustomProviderActions();
  const { setSecrets } = useProviderAuthActions();

  const [preset, setPreset] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [api, setApi] = useState<string>("openai-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  // 能力声明:数字字段以字符串持有草稿(允许中间态为空),保存前统一解析校验。
  const [ctxText, setCtxText] = useState("");
  const [maxTokText, setMaxTokText] = useState("");
  const [image, setImage] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const modelIds = modelsText
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ctx = Number(ctxText);
  const maxTok = Number(maxTokText);
  const canSave =
    !!name.trim() &&
    /^https?:\/\//i.test(baseUrl.trim()) &&
    modelIds.length > 0 &&
    Number.isFinite(ctx) &&
    ctx > 0 &&
    Number.isFinite(maxTok) &&
    maxTok > 0 &&
    !saving;

  const slug = slugifyProviderId(name);
  const secretName = secretNameFor(slug);

  /** 由表单状态生成完整 Pi Provider JSON（能力字段全部来自用户声明，cost 固定全 0）。 */
  const buildJson = (): string => {
    const models = modelIds.map((id) => ({
      id,
      name: id,
      api,
      reasoning,
      input: image ? ["text", "image"] : ["text"],
      contextWindow: ctx,
      maxTokens: maxTok,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    return JSON.stringify(
      {
        name: name.trim(),
        api,
        baseUrl: baseUrl.trim(),
        // 明文永不进 JSON:落盘的是 ${secret:NAME} 引用,真值单独进系统密钥库。
        ...(key.trim() ? { apiKey: `\${secret:${secretName}}` } : {}),
        models,
      },
      null,
      2,
    );
  };

  const doSave = async () => {
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      // Secret 必须先于保存写入金库:主进程校验会拒绝「未定义的 Secret 引用」。
      if (key.trim()) {
        const r = await setSecrets.mutateAsync({ [secretName]: key.trim() });
        if (!r.ok) {
          setError(r.error ?? t("providers.form.secretFailed"));
          return;
        }
      }
      const r = await save.mutateAsync({
        id: slug,
        json: buildJson(),
        secretRefs: key.trim() ? [secretName] : [],
        updatedAt: Date.now(),
      });
      if (r.ok) {
        setKey(""); // 成功即清空明文草稿
        onClose();
      } else {
        setError((r as { error?: string }).error ?? t("providers.form.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  /** 切到 JSON 模式:有内容就带草稿过去(secretRefs 由编辑器重扫,这里不预填)。 */
  const switchToJson = () => {
    const dirty = name.trim() || baseUrl.trim() || modelIds.length > 0;
    onSwitchToJson(
      dirty ? { id: slug, json: buildJson(), secretRefs: [], updatedAt: 0 } : undefined,
    );
  };

  return (
    <div className="pw-pip-form">
      <div className="pw-pip-form-head">
        <span className="pw-pip-form-title">{t("providers.form.title")}</span>
        <span className="pw-pip-spacer" />
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`pw-pip-chip ${preset === p.key ? "is-active" : ""}`}
            onClick={() => {
              setPreset(p.key);
              // 名称仅在用户还没自己填过时跟随预设(与原型一致:本地服务加「本地」前缀)。
              setName((cur) => cur.trim() ? cur : p.local ? t("providers.form.localName", { name: p.name }) : p.name);
              setBaseUrl(p.base);
              setApi("openai-completions");
            }}
          >
            {p.key === "relay" ? t("providers.form.presetRelay") : p.name}
          </button>
        ))}
      </div>

      <div className="pw-pip-form-grid">
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("providers.form.name")}</span>
          <input
            className="pw-set-input"
            value={name}
            placeholder={t("providers.form.namePh")}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("providers.form.api")}</span>
          <select className="pw-set-input" value={api} onChange={(e) => setApi(e.target.value)}>
            {API_OPTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("providers.form.baseUrl")}</span>
        <input
          className="pw-set-input pw-pip-mono"
          value={baseUrl}
          placeholder={PRESETS[0].base}
          spellCheck={false}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>

      <div className="pw-pip-form-grid">
        <label className="pw-set-field">
          <span className="pw-set-lbl">
            {t("providers.apiKey")} <span className="pw-pip-optional">{t("providers.form.keyOptional")}</span>
          </span>
          <input
            className="pw-set-input"
            type="password"
            value={key}
            placeholder={t("providers.form.keyPh")}
            autoComplete="off"
            spellCheck={false}
            disabled={!storageAvailable}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label className="pw-set-field">
          <span className="pw-set-lbl">
            {t("providers.form.models")} <span className="pw-pip-optional">{t("providers.form.modelsHint")}</span>
          </span>
          <input
            className="pw-set-input pw-pip-mono"
            value={modelsText}
            placeholder={t("providers.form.modelsPh")}
            spellCheck={false}
            onChange={(e) => setModelsText(e.target.value)}
          />
        </label>
      </div>

      {/* 能力声明:主进程缺一即拒,Cortex 不猜——值应用于本次列出的全部模型。 */}
      <div className="pw-pip-caps">
        <div className="pw-pip-caps-h">
          <span className="pw-pip-caps-t">{t("providers.form.caps")}</span>
          <span className="pw-pip-caps-d">{t("providers.form.capsDesc")}</span>
        </div>
        <div className="pw-pip-caps-row">
          <label className="pw-set-field">
            <span className="pw-set-lbl">{t("providers.form.contextWindow")}</span>
            <input
              className="pw-set-input"
              inputMode="numeric"
              value={ctxText}
              placeholder="131072"
              onChange={(e) => setCtxText(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <label className="pw-set-field">
            <span className="pw-set-lbl">{t("providers.form.maxTokens")}</span>
            <input
              className="pw-set-input"
              inputMode="numeric"
              value={maxTokText}
              placeholder="8192"
              onChange={(e) => setMaxTokText(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </label>
          <label className="pw-ml-check">
            <input type="checkbox" checked={image} onChange={(e) => setImage(e.target.checked)} />
            {t("providers.form.image")}
          </label>
          <label className="pw-ml-check">
            <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
            {t("providers.form.reasoning")}
          </label>
        </div>
      </div>

      {key.trim() ? <div className="pw-set-hint">{t("providers.form.keyStored", { name: secretName })}</div> : null}
      {error ? <div className="pw-prov-alert is-error">{error}</div> : null}

      <div className="pw-pip-form-foot">
        <button type="button" className="pw-pip-primary" disabled={!canSave} onClick={() => void doSave()}>
          {saving ? t("providers.custom.validating") : t("providers.form.save")}
        </button>
        <button type="button" className="pw-pip-linkbtn" onClick={onClose}>
          {t("providers.connectionTestCancel")}
        </button>
        <button type="button" className="pw-pip-linkbtn" onClick={switchToJson}>
          {t("providers.form.jsonMode")}
        </button>
        <span className="pw-pip-spacer" />
        <span className="pw-pip-caps-d">{t("providers.form.savedHint")}</span>
      </div>
    </div>
  );
}
