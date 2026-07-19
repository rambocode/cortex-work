// 供应商管理弹窗:由「Pi」设置分区的紧凑供应商列表/「供应商管理」按钮打开。
// 供应商即 pi 的供应商 —— 完整管理(模板添加 + 列表/详情双栏 + 连接测试)低频,
// 故收进弹窗;页内只留紧凑列表。增删改直接写 personal store,页内列表自动同步。
// ESC 处理:capture 阶段监听 + stopPropagation,避免连带触发设置整页的 ESC 返回。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { Toggle } from "@cortex-work/ui/controls/Toggle";
import {
  PROVIDER_PRESETS,
  providerFromPreset,
  useDesktopBridge,
  usePersonalStore,
  type DesktopBridge,
  type EndpointFormat,
  type ProviderModelOption,
  type ProviderProfile,
} from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { SecretField } from "./settingsControls";

// provider id slug 化:作为 pi provider 名,仅允许字母数字与 - _。
function slugify(s: string): string {
  const out = s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "provider";
}

// label 走 i18n（settings:providers.endpointFormat.*）,故 value→formatKey,渲染时翻译。
const ENDPOINT_FORMAT_OPTIONS: { formatKey: string; value: EndpointFormat }[] = [
  { formatKey: "providers.endpointFormat.chatCompletions", value: "chat_completions" },
  { formatKey: "providers.endpointFormat.responses", value: "responses" },
  { formatKey: "providers.endpointFormat.messages", value: "messages" },
  { formatKey: "providers.endpointFormat.custom", value: "custom" },
];

// 两段式删除确认（仿 ProjectMenu:首次点击进入确认态,再次点击执行,失焦撤销）。
function ConfirmDelete({ onConfirm, title }: { onConfirm: () => void; title?: string }) {
  const { t } = useTranslation("settings");
  const [confirming, setConfirming] = useState(false);
  return (
    <button
      className={`pw-pi-channel-del ${confirming ? "is-confirming" : ""}`}
      title={title}
      onClick={() => (confirming ? onConfirm() : setConfirming(true))}
      onBlur={() => setConfirming(false)}
    >
      {confirming ? t("providers.confirmDelete") : <Icon.Trash size={14} />}
    </button>
  );
}

// 供应商详情表单（右栏），含连接测试四态（idle / 测试中 / 成功+回填 / 失败）。
type ProbeState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; models: string[] }
  | { kind: "err"; error: string };

// 单个模型的内联编辑行（添加/编辑共用）：id + 显示名 + 保存/取消。
// 上下文输入解析："128K" / "1M" / "128000" → token 数；非法 → undefined。
function parseContextInput(s: string): number | undefined {
  const m = s.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([KM]?)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const mult = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  return Math.round(n * mult);
}
// token 数 → 紧凑展示："1M" / "128K" / "512"。
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1_000) return `${+(tokens / 1_000).toFixed(tokens % 1_000 ? 1 : 0)}K`;
  return String(tokens);
}

function ModelEditRow({
  initial,
  onSave,
  onCancel,
}: {
  initial: ProviderModelOption;
  onSave: (m: ProviderModelOption) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("settings");
  const [id, setId] = useState(initial.id);
  const [label, setLabel] = useState(initial.label ?? "");
  const [ctx, setCtx] = useState(initial.contextTokens ? formatContext(initial.contextTokens) : "");
  const [reasoning, setReasoning] = useState(initial.reasoning ?? false);
  const [vision, setVision] = useState(initial.vision ?? false);
  const save = () => {
    const trimmed = id.trim();
    if (!trimmed) return;
    const m: ProviderModelOption = { id: trimmed };
    if (label.trim()) m.label = label.trim();
    const ctxNum = parseContextInput(ctx);
    if (ctxNum) m.contextTokens = ctxNum;
    if (reasoning) m.reasoning = true;
    if (vision) m.vision = true;
    onSave(m);
  };
  return (
    <div className="pw-ml-edit">
      <div className="pw-ml-edit-row">
        <input
          className="pw-set-input"
          value={id}
          placeholder={t("providers.models.idPlaceholder")}
          spellCheck={false}
          autoFocus
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
        <input
          className="pw-set-input"
          value={label}
          placeholder={t("providers.models.labelPlaceholder")}
          spellCheck={false}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
      </div>
      <div className="pw-ml-edit-row">
        <input
          className="pw-set-input pw-ml-ctx"
          value={ctx}
          placeholder={t("providers.models.contextPlaceholder")}
          spellCheck={false}
          onChange={(e) => setCtx(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? save() : undefined)}
        />
        <label className="pw-ml-check">
          <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
          {t("providers.models.reasoning")}
        </label>
        <label className="pw-ml-check">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
          {t("providers.models.vision")}
        </label>
        <span className="pw-ml-edit-spacer" />
        <button className="btn pw-pi-add-btn" disabled={!id.trim()} onClick={save}>
          {t("providers.models.save")}
        </button>
        <button className="pw-ml-cancel" onClick={onCancel}>
          {t("providers.models.cancel")}
        </button>
      </div>
    </div>
  );
}

// kun 风格模型列表：每个模型一张卡（id + 能力徽标 + 编辑/删除）,顶部「从 API 拉取」,底部「添加模型」。
function ProviderModels({
  models,
  onChange,
  bridge,
  baseUrl,
  apiKey,
  endpointFormat,
}: {
  models: ProviderModelOption[];
  onChange: (models: ProviderModelOption[]) => void;
  bridge: DesktopBridge | null;
  baseUrl: string;
  apiKey?: string;
  endpointFormat: EndpointFormat;
}) {
  const { t } = useTranslation("settings");
  // editIdx：正在编辑的下标;models.length 表示新增;null 表示无编辑。
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  useEffect(() => {
    setProbe({ kind: "idle" });
  }, [baseUrl, apiKey, endpointFormat]);

  const canProbe = !!bridge?.probeProvider && endpointFormat !== "custom" && !!baseUrl.trim();

  const runProbe = async () => {
    if (!bridge?.probeProvider || probe.kind === "testing") return;
    setProbe({ kind: "testing" });
    try {
      const res = await bridge.probeProvider({ baseUrl, apiKey, endpointFormat });
      setProbe(res.ok ? { kind: "ok", models: res.models ?? [] } : { kind: "err", error: res.error ?? t("providers.models.connectFailed") });
    } catch (e) {
      setProbe({ kind: "err", error: e instanceof Error ? e.message : String(e) });
    }
  };
  // 拉取应用：保留已有显示名,按拉取结果重排（新 id 无显示名）。
  const applyFetched = (ids: string[]) => {
    const existing = new Map(models.map((m) => [m.id, m]));
    onChange(ids.map((id) => existing.get(id) ?? { id }));
    setProbe({ kind: "idle" });
  };

  const saveModel = (m: ProviderModelOption) => {
    const next = [...models];
    if (editIdx === models.length) next.push(m);
    else if (editIdx !== null) next[editIdx] = m;
    onChange(next);
    setEditIdx(null);
  };
  const removeModel = (i: number) => {
    onChange(models.filter((_, j) => j !== i));
    if (editIdx === i) setEditIdx(null);
  };

  return (
    <div className="pw-ml">
      <div className="pw-ml-head">
        <span className="pw-ml-title">{t("providers.models.listTitle", { count: models.length })}</span>
        <button
          className="pw-tl-gen"
          disabled={!canProbe || probe.kind === "testing"}
          onClick={() => void runProbe()}
          title={endpointFormat === "custom" ? t("providers.models.customNoProbe") : undefined}
        >
          <Icon.Retry size={12} />
          {probe.kind === "testing" ? t("providers.models.fetchProbing") : t("providers.models.fetch")}
        </button>
      </div>
      <div className="pw-set-hint">{t("providers.models.hint")}</div>

      {probe.kind === "ok" ? (
        <div className="pw-ml-probe pw-ml-probe-ok">
          {t("providers.models.probeOk", { count: probe.models.length })}
          {probe.models.length > 0 ? (
            <button className="pw-prov-probe-apply" onClick={() => applyFetched(probe.models)}>
              {t("providers.models.apply")}
            </button>
          ) : null}
        </div>
      ) : null}
      {probe.kind === "err" ? <div className="pw-ml-probe pw-ml-probe-err">{probe.error}</div> : null}

      {models.length === 0 && editIdx === null ? (
        <div className="pw-set-hint">{t("providers.models.emptyHint")}</div>
      ) : null}

      {models.map((m, i) =>
        editIdx === i ? (
          <ModelEditRow key={i} initial={m} onSave={saveModel} onCancel={() => setEditIdx(null)} />
        ) : (
          <div key={i} className="pw-ml-card">
            <div className="pw-ml-card-main">
              <span className="pw-ml-id">{m.id}</span>
              <span className="pw-ml-badges">
                <span className="pw-ml-badge">{t("providers.models.badgeText")}</span>
                {m.contextTokens ? <span className="pw-ml-badge">{t("providers.models.badgeContext", { value: formatContext(m.contextTokens) })}</span> : null}
                {m.reasoning ? <span className="pw-ml-badge">{t("providers.models.badgeReasoning")}</span> : null}
                {m.vision ? <span className="pw-ml-badge">{t("providers.models.badgeVision")}</span> : null}
                {m.label && m.label !== m.id ? <span className="pw-ml-badge is-name">{m.label}</span> : null}
              </span>
            </div>
            <div className="pw-ml-actions">
              <button title={t("providers.models.edit")} onClick={() => setEditIdx(i)}>
                <Icon.Edit size={14} />
              </button>
              <button title={t("providers.models.delete")} onClick={() => removeModel(i)}>
                <Icon.Trash size={14} />
              </button>
            </div>
          </div>
        ),
      )}

      {editIdx === models.length ? (
        <ModelEditRow initial={{ id: "" }} onSave={saveModel} onCancel={() => setEditIdx(null)} />
      ) : (
        <button className="pw-ml-add" onClick={() => setEditIdx(models.length)}>
          <Icon.Plus size={13} />
          {t("providers.models.addModel")}
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "password";
}) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <input
        className="pw-set-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="pw-set-field">
      <span className="pw-set-lbl">{label}</span>
      <select className="pw-set-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProviderDetail({
  provider,
  onPatch,
  onRemove,
}: {
  provider: ProviderProfile;
  onPatch: (patch: Partial<ProviderProfile>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  return (
    <div className="pw-prov-detail">
      <div className="pw-pi-channel-head">
        <input
          className="pw-set-input"
          value={provider.name}
          placeholder={t("providers.namePlaceholder")}
          spellCheck={false}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <Toggle label={t("providers.enable")} value={provider.enabled} onChange={(v) => onPatch({ enabled: v })} />
        <ConfirmDelete onConfirm={onRemove} title={t("providers.deleteProvider")} />
      </div>
      <Select
        label={t("providers.protocolType")}
        value={provider.endpointFormat}
        options={ENDPOINT_FORMAT_OPTIONS.map((o) => ({ label: t(o.formatKey), value: o.value }))}
        onChange={(v) => onPatch({ endpointFormat: v as EndpointFormat })}
      />
      <Field
        label={t("providers.baseUrl")}
        value={provider.baseUrl}
        placeholder={t("providers.baseUrlPlaceholder")}
        onChange={(v) => onPatch({ baseUrl: v })}
      />
      <SecretField
        label={t("providers.apiKey")}
        value={provider.apiKey ?? ""}
        placeholder={t("providers.apiKeyPlaceholder")}
        onChange={(v) => onPatch({ apiKey: v || undefined })}
      />
      <ProviderModels
        models={provider.models}
        onChange={(models) => onPatch({ models })}
        bridge={bridge}
        baseUrl={provider.baseUrl}
        apiKey={provider.apiKey}
        endpointFormat={provider.endpointFormat}
      />
    </div>
  );
}

// 供应商管理弹窗:模板添加 + 列表/详情双栏(原「供应商」tab 全部能力)。
export function ProviderManagerModal({
  initialSelectedId,
  onClose,
}: {
  initialSelectedId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const addProvider = usePersonalStore((s) => s.addProvider);
  const updateProvider = usePersonalStore((s) => s.updateProvider);
  const removeProvider = usePersonalStore((s) => s.removeProvider);
  const providers = providerSettings.providers;
  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId ?? providers[0]?.id);
  const [tmplKey, setTmplKey] = useState(PROVIDER_PRESETS[0]?.templateKey ?? "deepseek");

  const selected = providers.find((p) => p.id === selectedId) ?? providers[0];

  // ESC 关闭弹窗但不连带关设置整页:capture 阶段 stopPropagation(设置页是 window
  // bubble 监听);输入框内的 ESC 放行(设置页有 isTypingTarget 守卫,同样不会误关)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (typing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const addFromTemplate = () => {
    const preset = PROVIDER_PRESETS.find((x) => x.templateKey === tmplKey);
    if (!preset) return;
    const base = slugify(preset.templateKey === "custom" ? "custom-provider" : preset.templateKey);
    const existing = new Set(providers.map((p) => p.id));
    let id = base;
    let n = 1;
    while (existing.has(id)) id = `${base}-${++n}`;
    addProvider(providerFromPreset(preset, id));
    setSelectedId(id);
  };

  return (
    <div className="pw-prov-modal-mask" onClick={onClose}>
      <div
        className="pw-prov-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("providers.manage")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pw-prov-modal-head">
          <span className="pw-prov-modal-title">{t("providers.manage")}</span>
          <button className="pw-prov-modal-close" aria-label={t("providers.manageClose")} onClick={onClose}>
            <Icon.X size={15} />
          </button>
        </div>
        <div className="pw-prov-modal-body">
          <div className="pw-pi-add">
            <Select
              label={t("providers.addFromTemplate")}
              value={tmplKey}
              options={PROVIDER_PRESETS.map((preset) => ({ label: t(preset.nameKey), value: preset.templateKey }))}
              onChange={setTmplKey}
            />
            <button className="btn pw-pi-add-btn" onClick={addFromTemplate}>
              {t("providers.addProvider")}
            </button>
          </div>

          {providers.length === 0 ? (
            <div className="pw-set-hint">{t("providers.empty")}</div>
          ) : (
            <div className="pw-prov-split">
              <div className="pw-prov-list">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    className={`pw-prov-item ${p.id === selected?.id ? "is-active" : ""}`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span className="pw-prov-item-name">{p.name || p.id}</span>
                    <span className="pw-prov-item-meta">
                      {providerSettings.defaultProviderId === p.id ? (
                        <span className="pw-prov-badge is-default">{t("providers.badgeDefault")}</span>
                      ) : null}
                      {p.enabled ? null : <span className="pw-prov-badge">{t("providers.badgeDisabled")}</span>}
                      <span className="pw-prov-badge">{t("providers.badgeModels", { count: p.models.length })}</span>
                    </span>
                  </button>
                ))}
              </div>
              {selected ? (
                <ProviderDetail
                  key={selected.id}
                  provider={selected}
                  onPatch={(patch) => updateProvider(selected.id, patch)}
                  onRemove={() => {
                    removeProvider(selected.id);
                    setSelectedId(undefined);
                  }}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
