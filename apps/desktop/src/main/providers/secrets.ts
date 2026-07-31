// 命名 Secret 的引用语法（`${secret:NAME}`）与「禁泄」文本清洗——**纯函数**，不碰磁盘、
// 不碰 Electron，因此可以脱离 safeStorage 完整单测。
//
// 为什么要有引用语法：自定义 Provider 是一整段用户提供的 Pi Provider JSON，会被落盘并（由
// pi-providers.ts）渲染成 extension 文件。若允许把 API Key / Authorization 直接写在 JSON 里，
// 明文就会同时出现在持久化状态、extension 文件与日志里——这正是本次事故要根除的形态。
// 所以敏感值一律只写 `${secret:NAME}` 占位，真值经 `providerAuth:setSecrets` 进 safeStorage 金库。

/** Secret 名的合法字符集：大小写字母 / 数字 / `_ . -`，长度 1–64。 */
export const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** `${secret:NAME}` 引用。全局正则，使用前须重置 lastIndex（见 collectSecretRefs）。 */
const SECRET_REF_RE = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

/** 整值恰好是一个 Secret 引用（用于「敏感字段必须走引用」的判定）。 */
const WHOLE_SECRET_REF_RE = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;

// pi 自己的配置值语法：`$ENV_VAR` / `${ENV_VAR}` 环境变量插值、`!command` 命令求值。
// 这两种形态本身不含明文密钥（真值在用户环境里），故与 `${secret:}` 一样属于允许写法。
const PI_INDIRECTION_RE = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|!.+)$/;

/** 提取文本中出现的全部 Secret 名（去重、保持出现顺序）。 */
export function collectSecretRefs(text: string): string[] {
  const found: string[] = [];
  SECRET_REF_RE.lastIndex = 0;
  for (let m = SECRET_REF_RE.exec(text); m; m = SECRET_REF_RE.exec(text)) {
    const name = m[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/** 引用中尚未在金库里定义的 Secret 名（保存自定义 Provider 时据此拒绝）。 */
export function findUndefinedSecretRefs(text: string, definedNames: readonly string[]): string[] {
  const defined = new Set(definedNames);
  return collectSecretRefs(text).filter((name) => !defined.has(name));
}

/**
 * 把文本里的 `${secret:NAME}` 替换成真值。缺失的引用**保持原样**并在 missing 里返回，
 * 绝不静默替换成空串——否则会拼出一个「看起来配好了、实际无鉴权」的请求。
 */
export function resolveSecretRefs(
  text: string,
  secrets: Readonly<Record<string, string>>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  SECRET_REF_RE.lastIndex = 0;
  const out = text.replace(SECRET_REF_RE, (whole, name: string) => {
    const value = secrets[name];
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return value;
  });
  return { text: out, missing };
}

/** 敏感字段名判定（与 log/redact.ts 的 isSecretKey 同口径，刻意保持一致以免两处漂移）。 */
export function isSensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "apikey" ||
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

/**
 * 判断敏感字段的值是否合法：只允许 `${secret:NAME}` 引用、`$ENV` 插值或 `!command`。
 * 任何其它字面量都视为「明文内嵌」并被拒绝。
 */
export function isAllowedSensitiveValue(value: string): boolean {
  return WHOLE_SECRET_REF_RE.test(value) || PI_INDIRECTION_RE.test(value);
}

// OAuth 授权码与 token 常见于 URL query（`?code=...&state=...`）与 kv 文本。
// log/redact.ts 的 redactString 覆盖了 apikey/token/secret/authorization/password/credential，
// 但**没有** code/access/refresh/client_secret 这几个 OAuth 专有名，故此处补齐。
const OAUTH_KV_RE =
  /\b(code|access[_-]?token|refresh[_-]?token|client[_-]?secret|id[_-]?token|assertion)\b(\s*[:=]\s*"?)([^&",\s}]+)/gi;
const SCHEME_RE = /\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]+/gi;
const GENERIC_KV_RE =
  /("?(?:api[_-]?key|apikey|token|secret|authorization|password|credential)"?\s*[:=]\s*"?)([^",\s}]+)/gi;

/** 错误详情/日志文本的上限：再长也不该进日志，且长文本更容易夹带密钥。 */
const MAX_AUTH_TEXT = 400;

/**
 * 认证链路专用的文本清洗：错误信息、通知文案在过桥或落日志**之前**都必须过这里。
 *
 * 为什么不直接复用 log/redact.ts：那一层只在「写日志」时生效，而认证错误会经 IPC 直接
 * 送到 renderer 并显示在 UI 上——那条路径不经过 logger，必须在源头清洗。
 */
export function redactAuthText(text: string): string {
  const cleaned = text
    .replace(SCHEME_RE, "$1 ***")
    .replace(OAUTH_KV_RE, "$1$2***")
    .replace(GENERIC_KV_RE, "$1***");
  return cleaned.length > MAX_AUTH_TEXT ? `${cleaned.slice(0, MAX_AUTH_TEXT)}…` : cleaned;
}

/**
 * 把任意 throw 出来的东西转成**可安全外泄**的一句话。
 *
 * 只取 message、丢弃 stack / cause / response body：这些字段在 provider SDK 里经常原样带着
 * 请求头（含 Authorization）与响应体（含 token），整体透传等于把密钥送进 UI 与日志。
 */
export function safeErrorMessage(err: unknown, fallback = "未知错误"): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const text = raw.trim();
  return text ? redactAuthText(text) : fallback;
}
