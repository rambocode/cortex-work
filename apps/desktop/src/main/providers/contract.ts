// 主进程侧的 Provider Catalog / 认证 / Gateway 类型契约。
//
// ⚠️ 与 `packages/core/desktop/provider-catalog.ts` **逐字镜像**，两份必须同步改。
// 主进程刻意不依赖 `@cortex-work/core`（见 main/ipc/types.ts 文件头），故手工镜像而非导入。
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
  thinkingLevelMap?: Record<string, string>;
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

export interface ProviderConnectionTestResult {
  ok: boolean;
  modelId?: string;
  latencyMs?: number;
  error?: string;
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
  /** 主进程 → renderer 的 OAuth 交互事件流。 */
  authEvent: "providerAuth:event",
  /** 显式连接测试（可能产生费用，调用前 UI 须提示）。 */
  connectionTest: "providerConnection:test",
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
