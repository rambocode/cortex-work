// 自定义 Provider 编辑器：完整 Pi Provider JSON + 行级校验 + 独立 Secret 编辑器。
//
// 为什么存的是**整段 JSON** 而不是拆成表单字段：拆字段就必须为没填的字段选默认值，
// 而「Cortex 替用户猜 `input:["text"]` / `contextWindow:131072`」正是本次事故的根因。
// 用户提供什么就注册什么，缺字段 = 配置不完整 → 拒绝保存，不兜底。
//
// Secret 分离：敏感 Header 一律写 `${secret:NAME}`，明文经 providerAuthSetSecrets 单独进
// safeStorage。保存时两道硬门：① JSON 里不得有疑似明文密钥；② 不得有未定义的 Secret 引用。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDesktopBridge } from "@cortex-work/core";
import type { CustomProviderDefinition, CustomProviderValidation } from "@cortex-work/core/desktop/provider-catalog";
import {
  extractSecretRefs,
  findInlineSecrets,
  slugifyProviderId,
  undefinedSecretRefs,
} from "./customProviderRules";
import { useCustomProviderActions, useProviderAuthActions } from "./useProviderData";

interface SecretDraft {
  name: string;
  value: string;
}

export function CustomProviderPanel({
  items,
  storageAvailable,
}: {
  items: CustomProviderDefinition[];
  storageAvailable: boolean;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const { save, remove } = useCustomProviderActions();
  const { setSecrets } = useProviderAuthActions();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [idDraft, setIdDraft] = useState("");
  const [json, setJson] = useState("");
  const [validation, setValidation] = useState<CustomProviderValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [secrets, setSecretDrafts] = useState<SecretDraft[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refs = extractSecretRefs(json);
  const inline = findInlineSecrets(json);
  const missing = undefinedSecretRefs(json, secrets.map((s) => s.name));
  // 三道门全绿才允许保存：schema 合法 ∧ 无内嵌明文 ∧ 无未定义引用。
  const canSave = !!json.trim() && !!idDraft.trim() && validation?.ok === true && inline.length === 0 && missing.length === 0;

  const openEditor = (def?: CustomProviderDefinition) => {
    setEditingId(def?.id ?? "");
    setIdDraft(def?.id ?? "");
    setJson(def?.json ?? "");
    setValidation(null);
    setSecretDrafts((def?.secretRefs ?? []).map((name) => ({ name, value: "" })));
  };

  const validate = async () => {
    if (!bridge?.providerCustomValidate) {
      setValidation({ ok: false, errors: [{ message: t("providers.custom.validateUnavailable") }] });
      return;
    }
    setValidating(true);
    try {
      setValidation(await bridge.providerCustomValidate(json));
    } finally {
      setValidating(false);
    }
  };

  const doSave = () => {
    const id = slugifyProviderId(idDraft);
    // Secret 明文只走 providerAuthSetSecrets（safeStorage），绝不随 definition 落盘。
    const filled = secrets.filter((s) => s.name.trim() && s.value);
    if (filled.length) {
      setSecrets.mutate(Object.fromEntries(filled.map((s) => [s.name.trim(), s.value])));
    }
    save.mutate(
      { id, json, secretRefs: refs, updatedAt: Date.now() },
      {
        onSuccess: (r) => {
          if (r.ok) setEditingId(null);
        },
      },
    );
  };

  if (editingId === null) {
    return (
      <div className="pw-prov-custom">
        <div className="pw-set-hint">{t("providers.custom.hint")}</div>
        {items.length === 0 ? <div className="pw-set-hint">{t("providers.custom.empty")}</div> : null}
        {items.map((def) => (
          <div key={def.id} className="pw-ml-card">
            <div className="pw-ml-card-main">
              <span className="pw-ml-id">{def.id}</span>
              {def.secretRefs.length ? (
                <span className="pw-ml-sub">{t("providers.custom.refsFound", { names: def.secretRefs.join(", ") })}</span>
              ) : null}
            </div>
            <div className="pw-ml-actions">
              <button title={t("providers.custom.save")} onClick={() => openEditor(def)}>
                <Icon.Edit size={14} />
              </button>
              <button
                className={confirmDeleteId === def.id ? "is-confirming" : ""}
                title={t("providers.custom.delete")}
                onBlur={() => setConfirmDeleteId(null)}
                onClick={() => (confirmDeleteId === def.id ? remove.mutate(def.id) : setConfirmDeleteId(def.id))}
              >
                {confirmDeleteId === def.id ? t("providers.custom.deleteConfirm") : <Icon.Trash size={14} />}
              </button>
            </div>
          </div>
        ))}
        <button className="pw-ml-add" onClick={() => openEditor()}>
          <Icon.Plus size={13} />
          {t("providers.custom.add")}
        </button>
      </div>
    );
  }

  return (
    <div className="pw-prov-custom">
      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("providers.custom.idLabel")}</span>
        <input
          className="pw-set-input"
          value={idDraft}
          placeholder={t("providers.custom.idPlaceholder")}
          spellCheck={false}
          onChange={(e) => setIdDraft(e.target.value)}
        />
      </label>

      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("providers.custom.jsonLabel")}</span>
        <textarea
          className="pw-set-input pw-prov-json"
          value={json}
          rows={16}
          spellCheck={false}
          onChange={(e) => {
            setJson(e.target.value);
            setValidation(null); // 内容一变即作废上一次校验结果，避免拿旧结论放行保存
          }}
        />
      </label>

      <div className="pw-mode-block-actions">
        <button type="button" className="pw-mode-block-btn" disabled={validating} onClick={() => void validate()}>
          {validating ? t("providers.custom.validating") : t("providers.custom.validate")}
        </button>
      </div>

      {validation?.ok ? <div className="pw-prov-alert is-ok">{t("providers.custom.valid")}</div> : null}
      {validation && !validation.ok ? (
        <div className="pw-prov-alert is-error">
          <strong>{t("providers.custom.invalid", { count: validation.errors.length })}</strong>
          <ul className="pw-prov-errors">
            {validation.errors.map((e, i) => (
              <li key={i}>
                {e.line
                  ? t("providers.custom.errorAtLine", { line: e.line, message: e.message })
                  : t("providers.custom.errorNoLine", { message: e.message })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inline.length ? (
        <div className="pw-prov-alert is-error">
          <ul className="pw-prov-errors">
            {inline.map((e, i) => (
              <li key={i}>
                {t("providers.custom.errorAtLine", {
                  line: e.line ?? 0,
                  message: t("providers.custom.inlineSecret", { field: e.message }),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <SecretEditor
        drafts={secrets}
        refs={refs}
        missing={missing}
        disabled={!storageAvailable}
        onChange={setSecretDrafts}
      />

      <div className="pw-mode-block-actions">
        <button type="button" className="pw-mode-block-btn primary" disabled={!canSave} onClick={doSave}>
          {t("providers.custom.save")}
        </button>
        <button type="button" className="pw-mode-block-btn" onClick={() => setEditingId(null)}>
          {t("providers.connectionTestCancel")}
        </button>
      </div>
    </div>
  );
}

/** 独立的 Secret 编辑器：只写不读（值保存后不回显，与 API Key 同规则）。 */
function SecretEditor({
  drafts,
  refs,
  missing,
  disabled,
  onChange,
}: {
  drafts: SecretDraft[];
  refs: string[];
  missing: string[];
  disabled: boolean;
  onChange: (next: SecretDraft[]) => void;
}) {
  const { t } = useTranslation("settings");
  const patch = (i: number, p: Partial<SecretDraft>) =>
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...p } : d)));

  return (
    <div className="pw-prov-secrets">
      <div className="pw-ml-title">{t("providers.custom.secretsTitle")}</div>
      <div className="pw-set-hint">{t("providers.custom.secretsHint")}</div>
      {refs.length ? <div className="pw-set-hint">{t("providers.custom.refsFound", { names: refs.join(", ") })}</div> : null}
      {missing.length ? (
        <div className="pw-prov-alert is-error">{t("providers.custom.undefinedRefs", { names: missing.join(", ") })}</div>
      ) : null}
      {drafts.length === 0 ? <div className="pw-set-hint">{t("providers.custom.secretEmpty")}</div> : null}
      {drafts.map((d, i) => (
        <div key={i} className="pw-ml-edit-row">
          <input
            className="pw-set-input"
            value={d.name}
            placeholder={t("providers.custom.secretName")}
            aria-label={t("providers.custom.secretName")}
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => patch(i, { name: e.target.value })}
          />
          <input
            className="pw-set-input"
            type="password"
            value={d.value}
            placeholder={t("providers.custom.secretValue")}
            aria-label={t("providers.custom.secretValue")}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => patch(i, { value: e.target.value })}
          />
          <button
            className="pw-ml-cancel"
            disabled={disabled}
            onClick={() => onChange(drafts.filter((_, j) => j !== i))}
          >
            <Icon.Trash size={13} />
          </button>
        </div>
      ))}
      <button className="pw-ml-add" disabled={disabled} onClick={() => onChange([...drafts, { name: "", value: "" }])}>
        <Icon.Plus size={13} />
        {t("providers.custom.secretAdd")}
      </button>
    </div>
  );
}
