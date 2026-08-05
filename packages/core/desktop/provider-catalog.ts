// Pi Provider Catalog / 认证状态 / Model Gateway 的**共享类型契约**（renderer + core 侧）。
//
// 为什么单独成文件：这三组类型是「主进程 ↔ preload ↔ core ↔ views」四层共用的跨进程契约，
// 与 personal-workspace 持久化状态（types.ts）职责不同——Catalog 是构建期从
// `@earendil-works/pi-ai` 生成的**只读**系统元数据，凭据状态永不含明文，Gateway 是文本补全的
// 唯一出口。主进程侧有一份逐字镜像：`apps/desktop/src/main/providers/contract.ts`，
// 两份必须同步修改（main 刻意不依赖 core 包，见 main/ipc/types.ts 文件头）。
//
// 设计红线（改动前先读 docs/2026-07-30-pi-provider-capability-fix-plan.md）：
//   1. 模型能力（input/reasoning/contextWindow/...）来自 Pi 内置目录，**对用户只读**，
//      不存在「用户勾选视觉/推理」的字段——那正是本次事故的根因。
//   2. 任何凭据明文（apiKey / OAuth token / refresh token / Secret 值）**不得**出现在本文件
//      定义的任何类型里；renderer 只能拿到 configured/type/source/error。
//   3. `input` 缺失与 `input: ["text"]` 语义不同：前者是「目录未知」，后者是「明确不支持图片」。
//      自定义 Provider 未提供能力时必须走 unknown 分支拒绝注册，不得兜底成 text-only。

// ── Catalog（构建期从 pi-ai builtinProviders() 生成，随应用打包） ───────────────

/** 模型支持的输入模态。与 pi `Model.input` 逐字对齐。 */
export type ModelInputKind = "text" | "image";

/**
 * Catalog 中的单个模型：pi `Model` 的原始元数据子集（只保留 Cortex 需要透出的字段）。
 * 字段语义与 `@earendil-works/pi-ai` 的 `Model` 完全一致，不做任何 Cortex 侧再解释。
 */
export interface CatalogModel {
  id: string;
  name: string;
  /** 传输协议（pi `KnownApi` 10 种 + 开放字符串），如 openai-completions / anthropic-messages。 */
  api: string;
  /** 支持的输入模态。含 "image" 才允许发图片——Composer 与主进程双端据此阻断。 */
  input: ModelInputKind[];
  reasoning: boolean;
  /** 推理档位映射（low/medium/high → provider 私有值）。Cortex 不建模，只原样透传与展示。 */
  thinkingLevelMap?: Record<string, string>;
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** provider/API 特定兼容行为。结构由 pi 定义，Cortex 只原样搬运，禁止跨 api 复制。 */
  compat?: unknown;
}

/** Provider 支持的认证方式（由 pi `ProviderAuth` 派生）。 */
export type CatalogAuthKind = "api-key" | "oauth" | "ambient";

/**
 * Catalog 中的单个 Provider：认证方式 + 默认端点 + 内置模型目录。
 * 「零静态模型」的纯动态 Provider（如 radius）在生成期被排除，不会出现在这里。
 */
export interface CatalogProvider {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  /** 该 Provider 可用的认证方式，按 pi 定义顺序。空数组表示无需认证（本地端点）。 */
  auth: CatalogAuthKind[];
  /** ambient 认证读取的环境变量名（OPENAI_API_KEY 等），用于 UI 标注凭据来源。 */
  envVars?: string[];
  models: CatalogModel[];
}

/**
 * 完整 Catalog。`piVersion` 与随包 pi 二进制同版本，`hash` 是内容哈希——
 * 二者不一致直接让构建失败，防止「二进制升级了、目录没跟上」的静默漂移。
 */
export interface ProviderCatalog {
  schemaVersion: 1;
  piVersion: string;
  hash: string;
  providers: CatalogProvider[];
}

/** `providerCatalog.get` 的返回：加载失败时给出结构化原因，UI 走「目录不可用」降级。 */
export interface ProviderCatalogResult {
  ok: boolean;
  catalog?: ProviderCatalog;
  error?: string;
}

// ── 凭据与认证状态（阶段②；renderer 侧永不接触明文/密文） ───────────────────────

/**
 * 凭据来源。`safe-storage` 是 Cortex 自己保存的（可删除）；`env`/`ambient` 是宿主环境
 * 提供的（AWS profile、gcloud ADC、shell 环境变量），Cortex 只能读取与标注，**不能删除**。
 */
export type ProviderCredentialSource = "safe-storage" | "env" | "ambient" | "none";

/** 单个 Provider 的认证状态。刻意只有布尔与枚举，任何明文都不会走到这里。 */
export interface ProviderAuthStatus {
  providerId: string;
  configured: boolean;
  type?: "api-key" | "oauth";
  source: ProviderCredentialSource;
  /** OAuth token 过期时间（epoch ms）。仅用于 UI 提示，刷新由主进程在 store 锁内完成。 */
  expiresAt?: number;
  /** 结构化错误（如 safeStorage 不可用、token 刷新失败）。不得含凭据片段。 */
  error?: string;
  /**
   * 用户对该 Provider 的自建网关/代理端点覆盖（计划 §4.2「高级 baseUrl 覆盖」）。
   * 与 `CatalogProvider.baseUrl` 语义不同：后者是 Catalog 里的只读官方默认端点。
   * 缺省表示未覆盖，走 pi 内置目录里的端点。
   */
  baseUrlOverride?: string;
}

/** safeStorage 整体可用性。不可用时进入只读降级：禁止新增/修改密钥，且绝不明文回写。 */
export interface CredentialStoreHealth {
  available: boolean;
  reason?: string;
}

/** `providerAuth.status` 的返回：全量状态 + 存储健康度。 */
export interface ProviderAuthSnapshot {
  statuses: ProviderAuthStatus[];
  health: CredentialStoreHealth;
  /** 用户级「隐藏 Provider」偏好（与认证解耦）：防止 ambient key 让选择器涌入几十个 Provider。 */
  hiddenProviderIds: string[];
}

/** OAuth 交互中主进程向 UI 索取输入的类型。复用 pi `AuthInteraction.prompt` 协议。 */
export type AuthPromptKind = "text" | "secret" | "select" | "manual_code";

/** 一次 OAuth 输入请求。`requestId` 用于把 `providerAuth.respond` 对回具体这一问。 */
export interface AuthPrompt {
  requestId: string;
  kind: AuthPromptKind;
  label: string;
  /** kind="select" 时的候选（如「浏览器登录 / 设备码」）。 */
  options?: { value: string; label: string }[];
  /** 需用户在浏览器打开的登录地址。 */
  authUrl?: string;
  /** 设备码流程要用户输入到浏览器的短码。 */
  deviceCode?: string;
}

/** OAuth 过程中的提示/进度。复用 pi `AuthInteraction.notify`。 */
export interface AuthNotice {
  level: "info" | "warn" | "error";
  message: string;
  /** 0–1 进度；缺省表示不确定进度。 */
  progress?: number;
}

/** `providerAuth:event` 推给 renderer 的登录过程事件流。 */
export type ProviderAuthEvent =
  | { type: "prompt"; providerId: string; prompt: AuthPrompt }
  | { type: "notify"; providerId: string; notice: AuthNotice }
  | { type: "done"; providerId: string; status: ProviderAuthStatus }
  | { type: "error"; providerId: string; message: string };

/**
 * 连接测试的一步。UI 据此逐条点亮「测试过程」，失败时用户能看出卡在哪一步。
 *
 * **脱敏红线**：`detail` 里绝不能出现 API Key 明文或 Authorization 头——凭据只标来源标签
 *（safeStorage / 环境变量名 / OAuth）。主进程侧一律先过 `safeErrorMessage` 再填进来。
 */
export interface ProviderConnectionTestStep {
  /** 稳定的步骤 id，UI 按它取 i18n 标题：runtime | resolve | auth | request | response。 */
  id: string;
  state: "running" | "ok" | "error";
  /** 该步的关键参数/结果摘要（已脱敏）。 */
  detail?: string;
  /** 该步耗时；running 态缺省。 */
  ms?: number;
}

/**
 * `providerConnection:testEvent` 推给 renderer 的实时步骤流。
 *
 * `traceId` 由渲染端生成并随 invoke 传入、主进程原样回带：多行同时点「测试」时，
 * 每个面板只认自己的 traceId，事件不会串场。
 */
export interface ProviderConnectionTestEvent {
  traceId: string;
  step: ProviderConnectionTestStep;
}

/** `providerConnection.test` 的结果。显式触发（会产生少量费用），保存配置不自动测试。 */
export interface ProviderConnectionTestResult {
  ok: boolean;
  modelId?: string;
  latencyMs?: number;
  error?: string;
  /**
   * 全量步骤轨迹。与实时事件是同一份数据的两种投递方式——事件用于「边跑边看」，
   * 这里用于兜底（订阅晚了/事件丢了）与「复制诊断信息」。旧外壳缺省，UI 须容忍 undefined。
   */
  steps?: ProviderConnectionTestStep[];
}

// ── 自定义 Provider（用户提供完整 Pi Provider/Model JSON） ─────────────────────

/**
 * 用户自定义 Provider 的持久化形态：保存的是**完整 Pi Provider JSON 文本**，
 * 而不是 Cortex 拆解过的字段——避免再次出现「Cortex 猜默认值覆盖真实能力」。
 * 敏感 Header 用 `${secret:NAME}` 引用，明文由 safeStorage 单独保管。
 */
export interface CustomProviderDefinition {
  id: string;
  /** 完整 Pi Provider 定义的 JSON 文本（含 models 数组）。保存时按 pi schema 校验。 */
  json: string;
  /** 该定义引用到的 Secret 名（`${secret:NAME}`），用于保存时校验「未定义引用」。 */
  secretRefs: string[];
  updatedAt: number;
}

/** JSON 编辑器的行级校验结果。 */
export interface CustomProviderValidation {
  ok: boolean;
  errors: { line?: number; message: string }[];
}

// ── 聚合网关接入（阶段B：设置页向导 → 主进程发现与生成） ──────────────────────
//
// 渲染端在这条链路上刻意「什么都不算」：模型能力由主进程从随包 Catalog 解析，JSON 也由主
// 进程生成。渲染端只负责收集用户的「选择」（启用哪些模型、未识别的用哪条参照模型）。
// 这是能力红线的直接落实——渲染端没有任何产出能力字段的入口。

export interface GatewayDiscoveredModel {
  id: string;
  status: "known" | "unknown";
  model?: CatalogModel;
  capabilitySource?: string;
}

export interface GatewayDiscoverRequest {
  baseUrl: string;
  api: string;
  secretName?: string;
}

export interface GatewayDiscoverResult {
  ok: boolean;
  models?: GatewayDiscoveredModel[];
  error?: string;
}

export interface GatewayModelSelection {
  id: string;
  referenceProviderId?: string;
  referenceModelId?: string;
}

export interface GatewayBuildRequest {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  secretName?: string;
  models: GatewayModelSelection[];
}

export interface GatewayBuildResult {
  ok: boolean;
  json?: string;
  error?: string;
}

// ── Model Gateway（阶段③：文本补全唯一出口） ──────────────────────────────────

/** Gateway 消息内容块。图片只传本地路径或 base64，绝不在这里放凭据。 */
export interface GatewayContentBlock {
  type: "text" | "image";
  text?: string;
  /** 本地绝对路径（主进程读盘）。与 dataBase64 二选一。 */
  imagePath?: string;
  dataBase64?: string;
  mimeType?: string;
}

export interface GatewayMessage {
  role: "system" | "user" | "assistant";
  content: string | GatewayContentBlock[];
}

/** 统一的模型引用。全仓文本模型场景一律用 `{providerId, modelId}`，不再传裸 model 串。 */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface GatewayCompleteRequest extends ModelRef {
  messages: GatewayMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** 推理档位（low/medium/high）。Gateway 经 Catalog 的 thinkingLevelMap 翻译成 provider 私有值。 */
  thinkingLevel?: string;
  /** 调用方生成的取消句柄；`modelGateway.abort(requestId)` 据此中断。 */
  requestId?: string;
}

export interface GatewayUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Gateway 错误分类。调用方据此决定重试/提示：
 *   auth       → 引导去 Provider 设置（不重试）
 *   rate-limit → 可退避重试
 *   provider   → 上游返回的业务错误
 *   aborted    → 用户取消，不算失败
 *   config     → 模型引用在 Catalog 中不存在或未认证（悬空引用阻断态）
 */
export type GatewayErrorKind = "auth" | "rate-limit" | "provider" | "aborted" | "config" | "unknown";

export interface GatewayCompleteResult {
  ok: boolean;
  text?: string;
  usage?: GatewayUsage;
  error?: string;
  errorKind?: GatewayErrorKind;
}

/** 流式事件。`done` 一定是最后一条，且只发一次。 */
export type GatewayStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "usage"; usage: GatewayUsage }
  | { type: "done"; ok: boolean; text?: string; error?: string; errorKind?: GatewayErrorKind };

// ── 跨端共用的小工具（纯函数，无副作用，Web/Desktop 均可调用） ─────────────────

/** 模型是否支持图片输入。Catalog 里查不到该模型时返回 undefined（= 未知，非「不支持」）。 */
export function modelSupportsImage(
  catalog: ProviderCatalog | undefined,
  ref: ModelRef | undefined,
): boolean | undefined {
  const model = findCatalogModel(catalog, ref);
  return model ? model.input.includes("image") : undefined;
}

/** 在 Catalog 中定位模型。providerId + modelId 双键——同名模型经不同 Provider 能力不同。 */
export function findCatalogModel(
  catalog: ProviderCatalog | undefined,
  ref: ModelRef | undefined,
): CatalogModel | undefined {
  if (!catalog || !ref) return undefined;
  const provider = catalog.providers.find((p) => p.id === ref.providerId);
  return provider?.models.find((m) => m.id === ref.modelId);
}

/**
 * 把一条自定义 Provider 的 JSON 解析成 Catalog 形状，供模型选择器、能力判定与只读能力列表
 * 统一消费。
 *
 * 刻意**不补任何默认值**：`input` / `reasoning` / `contextWindow` / `maxTokens` 缺失就整条模型
 * 丢弃（返回的 models 里没有它）。研究文档 §5.1 的硬要求——「目录不知道」绝不能被写成
 * `input:["text"]`，那正是事故根因；宁可让模型不出现在选择器里，也不能给出错误能力。
 * 解析失败返回 undefined，调用方按「该自定义 Provider 配置不完整」展示。
 *
 * ⚠️ 放在 core/desktop 而不是设置页：阶段 A 起，发送路径的图片能力判定与 pi 会话指纹
 * （`personal/modelCapabilities.ts`）也要认识自定义模型，而 core 不能反向依赖 views。
 */
export function parseCustomProvider(def: CustomProviderDefinition): CatalogProvider | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(def.json);
  } catch {
    return undefined;
  }
  // 数组也满足 `typeof === "object"`，必须单独挡掉：主进程的 validateCustomProviderJson 与
  // resolveCustomProviderExtension 都明确要求「顶层是一个 JSON 对象」，放行数组会让渲染端
  // 把一份主进程根本加载不了的定义显示成「0 个模型的正常 Provider」，两侧对同一份 JSON 给出
  // 不同判断，用户看到的提示方向就是错的。
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const models: CatalogModel[] = [];
  for (const m of Array.isArray(o.models) ? o.models : []) {
    if (!m || typeof m !== "object") continue;
    const mm = m as Record<string, unknown>;
    const id = typeof mm.id === "string" ? mm.id : "";
    const input = Array.isArray(mm.input)
      ? mm.input.filter((x): x is ModelInputKind => x === "text" || x === "image")
      : [];
    // 四个能力字段缺一不可 —— 缺了就是配置不完整，不猜。
    if (!id || input.length === 0) continue;
    if (typeof mm.reasoning !== "boolean") continue;
    if (typeof mm.contextWindow !== "number" || typeof mm.maxTokens !== "number") continue;
    models.push({
      id,
      name: typeof mm.name === "string" ? mm.name : id,
      api: typeof mm.api === "string" ? mm.api : typeof o.api === "string" ? o.api : "",
      input,
      reasoning: mm.reasoning,
      thinkingLevelMap: (mm.thinkingLevelMap as Record<string, string> | undefined) ?? undefined,
      contextWindow: mm.contextWindow,
      maxTokens: mm.maxTokens,
      cost: (mm.cost as CatalogModel["cost"]) ?? undefined,
      compat: mm.compat,
    });
  }
  return {
    id: def.id,
    name: typeof o.name === "string" ? o.name : def.id,
    api: typeof o.api === "string" ? o.api : "",
    baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : undefined,
    auth: [],
    models,
  };
}

/**
 * 读取一条自定义 Provider 定义里每个模型的**能力来源标注**（modelId → sourceRef）。
 *
 * sourceRef 有两种形态：`<provider>/<model>`（从随包目录自动命中）与
 * `reference:<provider>/<model>`（用户指认的参照模型）。聚合网关向导生成定义时写入，
 * 设置页据此展示「这套能力当初是从哪来的」。
 *
 * ⚠️ 刻意**不**把它加进 `CatalogModel`：那个类型声明的是「pi `Model` 的原始元数据子集，
 * 字段语义与 pi 完全一致」，塞一个 Cortex 自己的字段进去会让这句话不再成立，也会让主进程
 * 镜像跟着变形。来源标注是**关于**能力的元数据，不是能力本身，单独一条通道读取更诚实。
 *
 * 手写 JSON / 旧版预制表单生成的定义没有这个字段，返回的映射里就没有对应项 —— 调用方
 * 据此显示「来源未记录」，而不是编一个来源出来。
 */
export function readCapabilitySources(def: CustomProviderDefinition): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: unknown;
  try {
    raw = JSON.parse(def.json);
  } catch {
    return out;
  }
  const models = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return out;
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const { id, capabilitySource } = model as { id?: unknown; capabilitySource?: unknown };
    if (typeof id === "string" && typeof capabilitySource === "string" && capabilitySource) {
      out[id] = capabilitySource;
    }
  }
  return out;
}

/**
 * 在自定义 Provider 定义列表中定位模型。与 `findCatalogModel` 同语义（双键、查不到给 undefined），
 * 只是数据源换成用户保存的 JSON。
 */
export function findCustomProviderModel(
  definitions: readonly CustomProviderDefinition[] | undefined,
  ref: ModelRef | undefined,
): CatalogModel | undefined {
  if (!definitions?.length || !ref?.providerId || !ref.modelId) return undefined;
  const def = definitions.find((d) => d.id === ref.providerId);
  if (!def) return undefined;
  return parseCustomProvider(def)?.models.find((m) => m.id === ref.modelId);
}
