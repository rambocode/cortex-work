// 主进程侧的 Provider Catalog / 认证 / Gateway 类型契约。
//
// ⚠️ 本文件的**类型声明部分**与 `packages/core/desktop/provider-catalog.ts` 逐字镜像，两份必须同步改。
// 主进程刻意不依赖 `@cortex-work/core`（见 main/ipc/types.ts 文件头），故手工镜像而非导入。
// 两侧各有不镜像的附加物：本文件多 `PROVIDER_IPC`（通道名只有主进程与 preload 需要），
// core 侧多 `modelSupportsImage` / `findCatalogModel` 两个纯函数（渲染端查询用）。
// 「类型部分保持一致」由 `contract-mirror.test.ts` 静态守护 —— 手工镜像没有编译期约束，
// 靠人记必然腐坏，而漂移的表现是跨进程传的对象字段对不上、且 typecheck 两侧各自都能过。
//
// 本文件同时是 IPC 通道名的唯一出处：preload 与主进程 handler 都从这里取常量，
// 防止两侧字符串写歪导致「invoke 挂起且无报错」。

// ── Catalog ──────────────────────────────────────────────────────────────────

export type ModelInputKind = "text" | "image";

export interface CatalogModel {
  id: string;
  name: string;
  api: string;
  input: ModelInputKind[];
  reasoning: boolean;
  // 档位值为 null = 该模型显式不支持此档（pi 目录原样抄录,如 deepseek-v4 系仅 high/max 可用）。
  // 消费侧（gateway.resolveThinkingLevel / 渲染端档位过滤）都依赖 null 语义,不得抹成 string。
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  compat?: unknown;
}

export type CatalogAuthKind = "api-key" | "oauth" | "ambient";

export interface CatalogProvider {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  auth: CatalogAuthKind[];
  envVars?: string[];
  models: CatalogModel[];
}

export interface ProviderCatalog {
  schemaVersion: 1;
  piVersion: string;
  hash: string;
  providers: CatalogProvider[];
}

export interface ProviderCatalogResult {
  ok: boolean;
  catalog?: ProviderCatalog;
  error?: string;
}

// ── 凭据与认证 ────────────────────────────────────────────────────────────────

export type ProviderCredentialSource = "safe-storage" | "env" | "ambient" | "none";

export interface ProviderAuthStatus {
  providerId: string;
  configured: boolean;
  type?: "api-key" | "oauth";
  source: ProviderCredentialSource;
  expiresAt?: number;
  error?: string;
  /**
   * 用户对该 Provider 的自建网关/代理端点覆盖（计划 §4.2「高级 baseUrl 覆盖」）。
   * 与 `CatalogProvider.baseUrl` 语义不同：后者是 Catalog 里的只读官方默认端点。
   * 缺省表示未覆盖，走 pi 内置目录里的端点。
   */
  baseUrlOverride?: string;
}

export interface CredentialStoreHealth {
  available: boolean;
  reason?: string;
}

export interface ProviderAuthSnapshot {
  statuses: ProviderAuthStatus[];
  health: CredentialStoreHealth;
  hiddenProviderIds: string[];
}

export type AuthPromptKind = "text" | "secret" | "select" | "manual_code";

export interface AuthPrompt {
  requestId: string;
  kind: AuthPromptKind;
  label: string;
  options?: { value: string; label: string }[];
  authUrl?: string;
  deviceCode?: string;
}

export interface AuthNotice {
  level: "info" | "warn" | "error";
  message: string;
  progress?: number;
}

export type ProviderAuthEvent =
  | { type: "prompt"; providerId: string; prompt: AuthPrompt }
  | { type: "notify"; providerId: string; notice: AuthNotice }
  | { type: "done"; providerId: string; status: ProviderAuthStatus }
  | { type: "error"; providerId: string; message: string };

/**
 * 连接测试的一步。**脱敏红线**：`detail` 里绝不能出现 API Key 明文或 Authorization 头，
 * 凭据只标来源标签；错误一律先过 `secrets.ts` 的 `safeErrorMessage` 再填进来。
 */
export interface ProviderConnectionTestStep {
  id: string;
  state: "running" | "ok" | "error";
  detail?: string;
  ms?: number;
}

/** `providerConnection:testEvent` 的负载。traceId 由渲染端生成，主进程原样回带，防止多行串场。 */
export interface ProviderConnectionTestEvent {
  traceId: string;
  step: ProviderConnectionTestStep;
}

export interface ProviderConnectionTestResult {
  ok: boolean;
  modelId?: string;
  latencyMs?: number;
  error?: string;
  steps?: ProviderConnectionTestStep[];
}

export interface CustomProviderDefinition {
  id: string;
  json: string;
  secretRefs: string[];
  updatedAt: number;
}

export interface CustomProviderValidation {
  ok: boolean;
  errors: { line?: number; message: string }[];
}

// ── 聚合网关接入（阶段B：填地址 + Key → 自动拉模型 → 勾选启用） ────────────────
//
// 顺路径全程零手填：模型列表由 `GET <baseUrl>/models` 发现，能力由 capability-resolver 从
// 随包 Catalog 解析。`/models` 只负责**发现**、不负责能力（标准响应只有 id/created/owned_by）。
//
// ⚠️ API Key 只以 Secret **名**在这两条通道上流动，明文永不过桥（与自定义 Provider 同规矩）。

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

// ── Gateway ──────────────────────────────────────────────────────────────────

export interface GatewayContentBlock {
  type: "text" | "image";
  text?: string;
  imagePath?: string;
  dataBase64?: string;
  mimeType?: string;
}

export interface GatewayMessage {
  role: "system" | "user" | "assistant";
  content: string | GatewayContentBlock[];
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface GatewayCompleteRequest extends ModelRef {
  messages: GatewayMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingLevel?: string;
  requestId?: string;
}

export interface GatewayUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type GatewayErrorKind = "auth" | "rate-limit" | "provider" | "aborted" | "config" | "unknown";

export interface GatewayCompleteResult {
  ok: boolean;
  text?: string;
  usage?: GatewayUsage;
  error?: string;
  errorKind?: GatewayErrorKind;
}

export type GatewayStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "usage"; usage: GatewayUsage }
  | { type: "done"; ok: boolean; text?: string; error?: string; errorKind?: GatewayErrorKind };

// ── IPC 通道名（preload 与 main handler 的唯一出处） ────────────────────────────

export const PROVIDER_IPC = {
  /** 阶段①：只读 Catalog（不含任何秘密）。 */
  catalogGet: "providerCatalog:get",
  /** 阶段②：认证状态快照。 */
  authStatus: "providerAuth:status",
  authLogin: "providerAuth:login",
  authRespond: "providerAuth:respond",
  authCancel: "providerAuth:cancel",
  authLogout: "providerAuth:logout",
  authSetApiKey: "providerAuth:setApiKey",
  authSetSecrets: "providerAuth:setSecrets",
  authSetHidden: "providerAuth:setHidden",
  /** 自建网关/代理的 baseUrl 覆盖（传 undefined 清除覆盖，恢复内置端点）。 */
  authSetBaseUrl: "providerAuth:setBaseUrl",
  /** 主进程 → renderer 的 OAuth 交互事件流。 */
  authEvent: "providerAuth:event",
  /** 显式连接测试（可能产生费用，调用前 UI 须提示）。 */
  connectionTest: "providerConnection:test",
  /** 主进程 → renderer 的连接测试步骤流（按 traceId 分发，见 ProviderConnectionTestEvent）。 */
  connectionTestEvent: "providerConnection:testEvent",
  /** 阶段B：聚合网关接入 —— 模型发现（GET /v1/models）与 Pi Provider JSON 生成。 */
  gatewayDiscover: "providerGateway:discover",
  gatewayBuild: "providerGateway:build",
  /** 自定义 Provider 定义的读写与校验。 */
  customList: "providerCustom:list",
  customSave: "providerCustom:save",
  customDelete: "providerCustom:delete",
  customValidate: "providerCustom:validate",
  /** 阶段③：文本补全唯一出口。 */
  gatewayComplete: "modelGateway:complete",
  gatewayStream: "modelGateway:stream",
  gatewayAbort: "modelGateway:abort",
  /** 主进程 → renderer 的流式事件（按 requestId 分发）。 */
  gatewayEvent: "modelGateway:event",
} as const;
