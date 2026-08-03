// 「接入聚合网关」向导（方案 §B3/§B4）：填地址 + Key → 自动拉模型 → 勾选启用，零手填。
//
// 与 CustomProviderForm 的分工：那个是「我知道自己有哪些模型、也知道它们的能力」的手工路径；
// 这个是 new-api / one-api 这类 OpenAI 兼容网关的顺路径——模型清单由网关的 `GET /v1/models`
// 给出，能力由主进程从随包 Catalog 解析。**本文件里没有任何产出能力数值的入口**
//（没有 contextWindow / maxTokens 输入框，没有视觉/推理 checkbox），这是能力红线的直接落实：
// 用户手填能力覆盖内置目录正是图片被静默丢弃的事故根因。
//
// 两条不可让步的顺序约束：
//   1. Key 必须**先**写进金库再 discover —— 主进程按 secretName 去金库取真值发探测请求，
//      顺序反了会拿 401 当成「网关不可达」，把用户引到错误的排查方向；
//   2. 探测失败当场报错、停在第一步 —— 绝不允许带着失败状态走到「保存」，否则会落一份
//      连不通的 Provider 进 provider-custom.json，聊天里再炸一次。
//
// 明文 Key 只存在于 React state：写进金库后不回显、保存成功即清空，任何时刻都不进 JSON。
//
// 编辑态（传入 `initial`）复用同一套 UI，但有三条**不可让步**的固定项，全部是「静默破坏用户
// 配置」级别的：供应商 id、Secret 名都锁死为原值（两者原本由名称派生，改名即漂移 →
// 落出一个新供应商 + 一个不存在的 Secret 引用，旧条目沦为孤儿），已保存的「参照」来源要原样
// 带回主进程重新生成（否则重新生成时目录仍认不出该模型，能力会被悄悄降级成保守兜底）。

import { useMemo, useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import type {
  CustomProviderDefinition,
  GatewayDiscoveredModel,
  GatewayModelSelection,
} from "@cortex-work/core/desktop/provider-catalog";
import { CapabilityBadges } from "./capabilityFormat";
import { GatewayReferencePicker, type ReferenceOption } from "./GatewayReferencePicker";
import { secretNameFor, slugifyProviderId } from "./customProviderRules";
import { parseReferenceSource, seedFromDefinition } from "./gatewayDefinition";
import { useCustomProviderActions, useGatewayActions, useProviderAuthActions } from "./useProviderData";

/**
 * 向导只开放两种 OpenAI 兼容协议：模型发现走的是 OpenAI 标准的 `GET /v1/models`，
 * 别的协议压根没有这个端点，列出来只会诱导用户走进死路（要接非 OpenAI 协议请走 JSON 高级入口）。
 */
const API_OPTIONS = [
  { id: "openai-completions", label: "OpenAI Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
] as const;

/** 向导两步：连接（填参数 + 探测）→ 选择（勾选启用 + 补参照）。 */
type Step = "connect" | "select";

/** 单条模型在向导里的用户选择。`reference` 只对 status="unknown" 有意义。 */
interface RowChoice {
  enabled: boolean;
  reference?: ReferenceOption;
}

/** 编辑态的初始勾选：已保存的模型**全部**预勾选——它们本来就是用户已经在用的。 */
function makeSeedChoices(seeded: GatewayDiscoveredModel[] | undefined): Record<string, RowChoice> {
  const out: Record<string, RowChoice> = {};
  for (const m of seeded ?? []) out[m.id] = { enabled: true };
  return out;
}

export function GatewayWizard({
  storageAvailable,
  /** 编辑已有的向导生成配置。缺省即新建态。 */
  initial,
  onClose,
  /** 「改用 JSON 粘贴」：极端网关（连参照都不适用）仍能走整段 JSON 的高级入口。 */
  onSwitchToJson: onAdvanced,
}: {
  storageAvailable: boolean;
  initial?: CustomProviderDefinition;
  onClose: () => void;
  onSwitchToJson: () => void;
}) {
  const { t } = useTranslation("settings");
  const { discover, build, supported } = useGatewayActions();
  const { save } = useCustomProviderActions();
  const { setSecrets } = useProviderAuthActions();

  // 编辑种子只在挂载时用于初始化下面的 state（`initial` 在一次编辑会话里是稳定的）。
  // 它同时也是「返回修改」的还原点，故除了初值之外还要在渲染期一直拿得到。
  const seed = useMemo(() => (initial ? seedFromDefinition(initial) : undefined), [initial]);
  const seedChoices = useMemo(() => makeSeedChoices(seed?.models), [seed]);

  // 有种子就直接进第二步：已保存的模型自己就是完整的候选集，不该为了「编辑一下名字」
  // 先逼用户联网探测一次（网关临时不可达时那等于把人锁在配置外面）。
  const [step, setStep] = useState<Step>(seed ? "select" : "connect");
  const [name, setName] = useState(seed?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(seed?.baseUrl ?? "");
  const [api, setApi] = useState<string>(seed?.api || API_OPTIONS[0].id);
  const [key, setKey] = useState("");
  /**
   * Key 已在金库里 —— 决定保存时要不要带 secretRefs、探测要不要带 secretName。
   * 编辑态初值取决于原配置**是否引用过** Secret：引用过就说明金库里已有，不该逼用户重填。
   */
  const [keyStored, setKeyStored] = useState(!!seed?.secretName);

  // 候选模型是**累积**的：刷新时新结果覆盖同 id 的能力数据，已启用但本次没返回的条目
  // 保留在列表里并标警示（方案 §B3.5：不静默移除）。
  const [models, setModels] = useState<GatewayDiscoveredModel[]>(seed?.models ?? []);
  /**
   * 最近一次探测实际返回的 id 集合，用来把「本次没返回」的条目标出来。
   * 编辑态用已保存的 id 种子化：还没探测过就不该给所有行挂「网关没返回」的警示。
   */
  const [presentIds, setPresentIds] = useState<string[]>(() => (seed?.models ?? []).map((m) => m.id));
  const [choices, setChoices] = useState<Record<string, RowChoice>>(seedChoices);
  /** 正在为哪条未识别模型挑参照（同一时刻只展开一个，避免整页被面板撑爆）。 */
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  /** 本次会话是否真的向网关探测过 —— 编辑态据此提示「当前列表来自已保存配置」。 */
  const [probed, setProbed] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ⚠️ 编辑态锁死 id 与 Secret 名（两者原本都由名称派生）：改名不得改动它们，
  // 否则保存会落出一个**新**供应商、并引用一个金库里不存在的 Secret，旧条目变成孤儿残留。
  const providerId = initial ? initial.id : slugifyProviderId(name);
  const secretName = initial ? (seed?.secretName ?? secretNameFor(initial.id)) : secretNameFor(providerId);
  const canConnect = !!name.trim() && /^https?:\/\//i.test(baseUrl.trim()) && !busy;

  const present = useMemo(() => new Set(presentIds), [presentIds]);
  const enabledIds = useMemo(
    () => models.filter((m) => choices[m.id]?.enabled).map((m) => m.id),
    [models, choices],
  );
  const missingIds = useMemo(
    () => enabledIds.filter((id) => !present.has(id)),
    [enabledIds, present],
  );

  /**
   * 合并一次探测结果：新数据覆盖同 id 的旧条目；旧条目只有在**已启用**时才保留
   *（未勾选的陈旧候选留着只是噪声，而已启用的消失了必须让用户看见）。
   */
  const mergeDiscovered = (fresh: GatewayDiscoveredModel[]) => {
    setModels((prev) => {
      const freshIds = new Set(fresh.map((m) => m.id));
      const kept = prev.filter((m) => !freshIds.has(m.id) && choices[m.id]?.enabled);
      return [...fresh, ...kept];
    });
    setPresentIds(fresh.map((m) => m.id));
  };

  /** 第一步的「连接」：先落金库、再探测。任一步失败都停在本步并报错。 */
  const doConnect = async () => {
    if (!canConnect) return;
    setError(null);
    setBusy(true);
    try {
      if (key.trim()) {
        const r = await setSecrets.mutateAsync({ [secretName]: key.trim() });
        if (!r.ok) {
          setError(r.error ?? t("providers.gateway.secretFailed"));
          return;
        }
        setKeyStored(true);
      }
      // 这次填了 Key(刚写进金库),或此前已经写过 —— 两种情况都要让主进程带着 Key 去探测,
      // 否则需要鉴权的网关会回 401,被用户读成「地址填错了」。
      const withSecret = !!key.trim() || keyStored;
      const res = await discover.mutateAsync({
        baseUrl: baseUrl.trim(),
        api,
        secretName: withSecret ? secretName : undefined,
      });
      if (!res.ok || !res.models) {
        setError(t("providers.gateway.discoverFailed", { error: res.error ?? "unknown" }));
        return;
      }
      // 编辑态的「连接」等同于刷新：合并而非替换，已启用但这次没返回的模型保留并标警示。
      // 直接替换会把用户已经在用的模型静默从配置里抹掉——那正是 §B3.5 禁止的形态。
      if (initial) {
        mergeDiscovered(res.models);
      } else {
        setModels(res.models);
        setPresentIds(res.models.map((m) => m.id));
        setChoices({});
      }
      setProbed(true);
      setStep("select");
    } finally {
      setBusy(false);
    }
  };

  /** 第二步的「刷新模型列表」：只更新候选集，用户已有的勾选与参照选择原样保留。 */
  const doRefresh = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await discover.mutateAsync({
        baseUrl: baseUrl.trim(),
        api,
        secretName: keyStored ? secretName : undefined,
      });
      if (!res.ok || !res.models) {
        setError(t("providers.gateway.discoverFailed", { error: res.error ?? "unknown" }));
        return;
      }
      mergeDiscovered(res.models);
      setProbed(true);
    } finally {
      setBusy(false);
    }
  };

  /** 保存：主进程生成 JSON（能力全在那边解析）→ 走与自定义 Provider 完全相同的落盘通道。 */
  const doSave = async () => {
    if (enabledIds.length === 0 || busy) return;
    setError(null);
    setBusy(true);
    try {
      const selections: GatewayModelSelection[] = enabledIds.map((id) => {
        const ref = choices[id]?.reference;
        if (ref) return { id, referenceProviderId: ref.providerId, referenceModelId: ref.modelId };
        // 编辑态：已保存的「参照」来源必须原样带回主进程。不带的话，重新生成时目录照样认不出
        // 这个模型 id，主进程会退到保守兜底——用户什么都没改，能力却被悄悄改小了。
        const saved = parseReferenceSource(models.find((m) => m.id === id)?.capabilitySource);
        return { id, referenceProviderId: saved?.providerId, referenceModelId: saved?.modelId };
      });
      const built = await build.mutateAsync({
        id: providerId,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        api,
        secretName: keyStored ? secretName : undefined,
        models: selections,
      });
      if (!built.ok || !built.json) {
        setError(t("providers.gateway.buildFailed", { error: built.error ?? "unknown" }));
        return;
      }
      const saved = await save.mutateAsync({
        id: providerId,
        json: built.json,
        secretRefs: keyStored ? [secretName] : [],
        updatedAt: Date.now(),
      });
      if (!saved.ok) {
        setError((saved as { error?: string }).error ?? t("providers.gateway.saveFailed"));
        return;
      }
      setKey(""); // 成功即清空明文草稿
      onClose();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 「返回修改」：连接参数一旦变了，探测结果与 Secret 名都可能失配，故整体作废重来。
   * 编辑态还原到**已保存的种子**而不是清空：用户点了返回又改主意时，原有的模型勾选不该凭空消失。
   */
  const backToConnect = () => {
    setStep("connect");
    setModels(seed?.models ?? []);
    setPresentIds((seed?.models ?? []).map((m) => m.id));
    setChoices(seedChoices);
    setPickingFor(null);
    setError(null);
  };

  return (
    <div className="pw-pip-form">
      <div className="pw-pip-form-head">
        <span className="pw-pip-form-title">
          {initial ? t("providers.gateway.editTitle") : t("providers.gateway.title")}
        </span>
        <span className="pw-pip-spacer" />
        <span className="pw-pip-caps-d">
          {initial ? t("providers.gateway.editDesc") : t("providers.gateway.desc")}
        </span>
      </div>

      {!supported ? <div className="pw-set-hint">{t("providers.gateway.unsupported")}</div> : null}

      {step === "connect" ? (
        <GatewayConnectStep
          name={name}
          baseUrl={baseUrl}
          api={api}
          apiKey={key}
          editing={!!initial}
          keyOnFile={keyStored}
          storageAvailable={storageAvailable}
          onName={setName}
          onBaseUrl={setBaseUrl}
          onApi={setApi}
          onKey={setKey}
        />
      ) : (
        <>
          <div className="pw-gw-summary">
            <span className="pw-gw-summary-name">{name.trim()}</span>
            <span className="pw-pip-baseurl">{baseUrl.trim()}</span>
            <span className="pw-prov-badge">{api}</span>
            <span className="pw-pip-spacer" />
            <button type="button" className="pw-pip-linkbtn" onClick={backToConnect}>
              {t("providers.gateway.back")}
            </button>
          </div>

          <div className="pw-pip-caps-h">
            <span className="pw-pip-caps-t">{t("providers.gateway.modelsTitle", { count: models.length })}</span>
            <span className="pw-pip-caps-d">{t("providers.gateway.capsReadonly")}</span>
          </div>

          {/* 编辑态且尚未探测：明说列表来自已保存配置，否则用户会以为这就是网关当前的真实清单。 */}
          {initial && !probed ? (
            <div className="pw-set-hint">{t("providers.gateway.editSeedHint")}</div>
          ) : null}

          {missingIds.length > 0 ? (
            <div className="pw-prov-alert is-warn">
              {t("providers.gateway.missingWarn", { names: missingIds.join("、") })}
            </div>
          ) : null}

          {models.length === 0 ? <div className="pw-set-hint">{t("providers.gateway.empty")}</div> : null}

          <div className="pw-gw-list">
            {models.map((m) => (
              <GatewayModelRow
                key={m.id}
                model={m}
                choice={choices[m.id]}
                missing={choices[m.id]?.enabled === true && !present.has(m.id)}
                picking={pickingFor === m.id}
                onToggle={(enabled) =>
                  setChoices((c) => ({ ...c, [m.id]: { ...c[m.id], enabled } }))
                }
                onStartPick={() => setPickingFor(m.id)}
                onCancelPick={() => setPickingFor(null)}
                onPick={(ref) => {
                  // 选中参照即视为用户完成了这条的补全,顺手勾上——少一次点击,语义也没有歧义。
                  setChoices((c) => ({ ...c, [m.id]: { enabled: true, reference: ref } }));
                  setPickingFor(null);
                }}
              />
            ))}
          </div>
        </>
      )}

      {key.trim() ? <div className="pw-set-hint">{t("providers.gateway.keyStored", { name: secretName })}</div> : null}
      {error ? <div className="pw-prov-alert is-error">{error}</div> : null}

      <div className="pw-pip-form-foot">
        {step === "connect" ? (
          <button type="button" className="pw-pip-primary" disabled={!canConnect} onClick={() => void doConnect()}>
            {busy ? t("providers.gateway.connecting") : t("providers.gateway.connect")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="pw-pip-primary"
              disabled={enabledIds.length === 0 || busy}
              onClick={() => void doSave()}
            >
              {busy ? t("providers.gateway.saving") : t("providers.gateway.save", { count: enabledIds.length })}
            </button>
            <button type="button" className="pw-pip-linkbtn" disabled={busy} onClick={() => void doRefresh()}>
              {t("providers.gateway.refresh")}
            </button>
          </>
        )}
        <button type="button" className="pw-pip-linkbtn" onClick={onClose}>
          {t("providers.connectionTestCancel")}
        </button>
        <button type="button" className="pw-pip-linkbtn" onClick={onAdvanced}>
          {t("providers.gateway.advanced")}
        </button>
      </div>
    </div>
  );
}

/** 第一步的表单字段。刻意与 CustomProviderForm 同构（同样的 pw-set-* 类与双列栅格）。 */
function GatewayConnectStep({
  name,
  baseUrl,
  api,
  apiKey,
  editing,
  keyOnFile,
  storageAvailable,
  onName,
  onBaseUrl,
  onApi,
  onKey,
}: {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  /** 编辑已有配置：名称只影响显示名，id 与 Secret 名都已锁死（见组件头部说明）。 */
  editing: boolean;
  /** 金库里已经有这个供应商的 Key —— 留空即沿用，不必重填。 */
  keyOnFile: boolean;
  storageAvailable: boolean;
  onName: (v: string) => void;
  onBaseUrl: (v: string) => void;
  onApi: (v: string) => void;
  onKey: (v: string) => void;
}) {
  const { t } = useTranslation("settings");
  // 定义里的协议可能不在向导的两个选项里（比如被 JSON 编辑器改过）。补一个同值 option，
  // 免得 select 渲染成空白后被 onChange 静默改写成 openai-completions。
  const apiKnown = API_OPTIONS.some((a) => a.id === api);
  return (
    <>
      <div className="pw-pip-form-grid">
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("providers.gateway.name")}</span>
          <input
            className="pw-set-input"
            value={name}
            placeholder={t("providers.gateway.namePh")}
            spellCheck={false}
            onChange={(e) => onName(e.target.value)}
          />
        </label>
        <label className="pw-set-field">
          <span className="pw-set-lbl">{t("providers.gateway.api")}</span>
          <select className="pw-set-input" value={api} onChange={(e) => onApi(e.target.value)}>
            {apiKnown ? null : <option value={api}>{api}</option>}
            {API_OPTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("providers.gateway.baseUrl")}</span>
        <input
          className="pw-set-input pw-pip-mono"
          value={baseUrl}
          placeholder={t("providers.gateway.baseUrlPh")}
          spellCheck={false}
          onChange={(e) => onBaseUrl(e.target.value)}
        />
      </label>

      <label className="pw-set-field">
        <span className="pw-set-lbl">
          {t("providers.apiKey")}{" "}
          <span className="pw-pip-optional">
            {editing && keyOnFile ? t("providers.gateway.keyKeep") : t("providers.gateway.keyOptional")}
          </span>
        </span>
        <input
          className="pw-set-input"
          type="password"
          value={apiKey}
          placeholder={editing && keyOnFile ? t("providers.gateway.keyKeepPh") : t("providers.gateway.keyPh")}
          autoComplete="off"
          spellCheck={false}
          disabled={!storageAvailable}
          onChange={(e) => onKey(e.target.value)}
        />
      </label>
    </>
  );
}

/**
 * 一条网关模型的选择行。
 *
 * known / unknown 的区别刻意做得很显眼：unknown **不能直接勾选**（checkbox 禁用），必须先选
 * 一条参照模型。这是「不猜能力」红线在交互上的落点——没有参照就没有确定的能力元数据，
 * 宁可让用户多点一次，也不能把 unknown 折算成 text-only 写进 pi。
 */
function GatewayModelRow({
  model,
  choice,
  missing,
  picking,
  onToggle,
  onStartPick,
  onCancelPick,
  onPick,
}: {
  model: GatewayDiscoveredModel;
  choice: RowChoice | undefined;
  /** 已启用但最近一次刷新没返回：标警示，不静默移除。 */
  missing: boolean;
  picking: boolean;
  onToggle: (enabled: boolean) => void;
  onStartPick: () => void;
  onCancelPick: () => void;
  onPick: (ref: ReferenceOption) => void;
}) {
  const { t } = useTranslation("settings");
  const known = model.status === "known";
  const reference = choice?.reference;
  // 展示用的能力来源：命中目录用目录条目，未识别则用用户选的参照模型——两者都是**确定**的元数据。
  // 两者都没有时不渲染徽标：那种情况下能力是主进程的保守兜底，摆一排徽标会让「保守默认」
  // 看起来像「查到的事实」，反而误导。下面那行文案会如实说明。
  const caps = known ? model.model : reference?.model;

  return (
    <div className={`pw-gw-row ${missing ? "is-missing" : ""}`}>
      <div className="pw-gw-row-main">
        <label className="pw-ml-check">
          {/* 未识别的模型**照样可勾选**：目录只是 pi 的内置快照，不是可用模型的全集。
              把它们锁死会让 new-api 上大量模型（Kimi、各家自研…）根本用不了。
              能力走主进程的保守兜底并如实标注，参照模型是「可选的更精确化」而非门槛。 */}
          <input
            type="checkbox"
            checked={choice?.enabled ?? false}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="pw-pip-mono">{model.id}</span>
        </label>
        <span className="pw-pip-spacer" />
        {caps ? <CapabilityBadges model={caps} compact /> : null}
      </div>

      <div className="pw-gw-row-meta">
        {known ? (
          <CapabilitySourceLabel source={model.capabilitySource} />
        ) : reference ? (
          <span className="pw-gw-source">
            {t("providers.gateway.sourceReference", {
              ref: `${reference.providerName}/${reference.modelId}`,
            })}
          </span>
        ) : (
          <span className="pw-gw-source is-unknown">{t("providers.gateway.fallbackHint")}</span>
        )}
        {known ? null : (
          <button type="button" className="pw-pip-linkbtn" onClick={picking ? onCancelPick : onStartPick}>
            {reference ? t("providers.gateway.changeReference") : t("providers.gateway.refineReference")}
          </button>
        )}
      </div>

      {missing ? <div className="pw-prov-alert is-warn">{t("providers.gateway.missingRow")}</div> : null}
      {picking ? <GatewayReferencePicker onPick={onPick} onCancel={onCancelPick} /> : null}
    </div>
  );
}

/**
 * 一条已确定能力的来源标注。
 *
 * 必须按 `reference:` 前缀分流：编辑态回显的 `capabilitySource` 来自已保存的定义，其中
 * 「用户当初指认的参照模型」写作 `reference:<provider>/<model>`。不分流的话它会被当成
 * 「随包目录命中」显示，等于把用户自己做的判断说成是系统查到的事实——来源标注唯一的价值
 * 就是可追溯，标错类别比不标更糟。
 * （`fallback` 不会走到这里：种子化时它已被降级成未识别行，见 gatewayDefinition.seedFromDefinition。）
 */
function CapabilitySourceLabel({ source }: { source: string | undefined }) {
  const { t } = useTranslation("settings");
  const reference = parseReferenceSource(source);
  if (reference) {
    return (
      <span className="pw-gw-source">
        {t("providers.gateway.sourceReference", { ref: `${reference.providerId}/${reference.modelId}` })}
      </span>
    );
  }
  return (
    <span className="pw-gw-source">
      {source ? t("providers.gateway.sourceCatalog", { ref: source }) : t("providers.gateway.sourceCatalogPlain")}
    </span>
  );
}
