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

/** `providerConnection.test` 的结果。显式触发（会产生少量费用），保存配置不自动测试。 */
export interface ProviderConnectionTestResult {
  ok: boolean;
  modelId?: string;
  latencyMs?: number;
  error?: string;
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
