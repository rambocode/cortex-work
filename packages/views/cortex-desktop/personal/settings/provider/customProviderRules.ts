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
 *
 * ⚠️ `compat` 子树整棵跳过，与主进程 `checkInlineSecrets` 保持同一口径。
 * 它是 pi 的**协议行为开关**（`maxTokensField` / `supportsToolSearch` 等），永远不含凭据，
 * 但 `maxTokensField` 归一后会命中 `token` 这条子串规则。这里的误报格外致命：
 * 本函数原注释说「误报的代价是用户改成引用（本来就该这么写）」—— 对 compat **不成立**，
 * 它根本不能写成 `${secret:}`，用户会被彻底卡死、无路可走（实测：网关向导生成的合法配置
 * 粘进 JSON 编辑器后连报 5 行，无法保存）。
 *
 * 两处判定必须一致：同一份 JSON 在「向导保存」与「JSON 编辑器保存」两条路径上给出不同结论，
 * 是最难查的一类问题。
 */
export function findInlineSecrets(json: string): CustomProviderIssue[] {
  const issues: CustomProviderIssue[] = [];
  const lines = json.split("\n");
  // compat 块的进入深度；非 null 表示当前行位于某个 compat 对象内部。
  // 按花括号计数跟踪，够用且不需要引入 CST 解析器（本函数本就是启发式预检）。
  let depth = 0;
  let compatDepth: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (compatDepth === null && /"compat"\s*:\s*\{/.test(line)) compatDepth = depth;

    if (compatDepth === null && !line.includes("${secret:")) {
      const m = line.match(/"([^"]+)"\s*:\s*"([^"]*)"/);
      const key = m?.[1]?.toLowerCase().replace(/[^a-z_]/g, "");
      const value = m?.[2];
      if (key && value?.trim() && SENSITIVE_FIELDS.some((f) => key.includes(f.replace("_", "")))) {
        issues.push({ line: i + 1, message: m![1]! });
      }
    }

    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    // 单行写法 `"compat": { "a": 1 }` 也能正确退出：本行净增为 0，depth 回到进入深度。
    if (compatDepth !== null && depth <= compatDepth) compatDepth = null;
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
