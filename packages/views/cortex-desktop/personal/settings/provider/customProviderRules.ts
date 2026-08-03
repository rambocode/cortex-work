// 自定义 Provider 的**渲染端**校验规则：Secret 引用扫描 + 明文密钥嗅探 + 行号定位。
// 纯函数、无副作用，便于单测；权威 schema 校验仍在主进程（providerCustomValidate）。
//
// 为什么渲染端也要查：主进程的 schema 校验只管「结构对不对」，管不了「用户是不是把明文
// API Key 直接贴进了 headers」。明文一旦进 JSON 就会随配置落盘（且不经 safeStorage），
// 等于把阶段②的凭据加密整个绕过去。故保存前先在这里挡一道，并给出行号让人能改。

/** `${secret:NAME}` 引用。NAME 允许字母数字、下划线、短横。 */
const SECRET_REF = /\$\{secret:([A-Za-z0-9_-]+)\}/g;

/** 疑似明文密钥的字段名（大小写不敏感）。命中且值不是 `${secret:...}` 引用即拒绝保存。 */
const SENSITIVE_FIELDS = ["apikey", "api_key", "authorization", "token", "secret", "password", "bearer"];

export interface CustomProviderIssue {
  line?: number;
  message: string;
}

/** 提取 JSON 文本里引用到的全部 Secret 名（去重、保序）。 */
export function extractSecretRefs(json: string): string[] {
  const out: string[] = [];
  for (const m of json.matchAll(SECRET_REF)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 扫描疑似内嵌的明文密钥。逐行做，才拿得到行号——JSON.parse 后的对象树已经丢了位置信息。
 * 判定：这一行的 key 命中敏感字段名，且这一行**不含** `${secret:` 引用，且值非空。
 * 刻意宽松地按行匹配而不做完整解析：误报的代价是用户改成引用（本来就该这么写），
 * 漏报的代价是明文密钥落盘。
 */
export function findInlineSecrets(json: string): CustomProviderIssue[] {
  const issues: CustomProviderIssue[] = [];
  const lines = json.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes("${secret:")) continue;
    const m = line.match(/"([^"]+)"\s*:\s*"([^"]*)"/);
    if (!m) continue;
    const key = m[1]!.toLowerCase().replace(/[^a-z_]/g, "");
    const value = m[2]!;
    if (!value.trim()) continue;
    if (SENSITIVE_FIELDS.some((f) => key.includes(f.replace("_", "")))) {
      issues.push({ line: i + 1, message: m[1]! });
    }
  }
  return issues;
}

/** 被引用但未定义的 Secret 名。保存时必须为空，否则运行期会拿到空 Header 而非报错。 */
export function undefinedSecretRefs(json: string, definedNames: string[]): string[] {
  const defined = new Set(definedNames);
  return extractSecretRefs(json).filter((n) => !defined.has(n));
}

/**
 * 由 provider slug 派生 Secret 名。须满足主进程 SECRET_NAME_RE（字母数字与 _ . -）。
 * 预制表单与聚合网关向导共用同一条规则——两处若各写一份，同名 Provider 在两条路径下会
 * 落到不同 Secret 上，表现为「换个入口重配就说找不到密钥」。
 */
export function secretNameFor(slug: string): string {
  return `CUSTOM_${slug.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

/** id slug 化：作为 pi provider 名，仅允许字母数字与 - _。 */
export function slugifyProviderId(s: string): string {
  const out = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "custom-provider";
}
