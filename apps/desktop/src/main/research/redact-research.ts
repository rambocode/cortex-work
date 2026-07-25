// CRE 专属日志脱敏（spec §19.3.1、§19.3.2）。
//
// 复用 main/log/redact.ts 的通用口径（key 级密钥脱敏 + Bearer/kv 正则 + 长字符串截断），
// 在其之上加三条 CRE 红线——它们是通用规则覆盖不到的：
//   1. **查询原文不落盘**：只记 sha256 前缀 + 长度。查询本身就是用户意图（"老板的离职传闻"），
//      泄漏程度不亚于正文。
//   2. **URL 去 query string 与 fragment**：查询串里常带搜索词、会话 id、甚至一次性 token。
//   3. **正文永不入日志**：正文字段一律替换成长度占位，连片段都不留。
//
// 用法：任何要打印 CRE 结构体（Worker 响应、搜索请求、Session 快照）的地方，
// 一律 `log.info("...", redactResearchLog(payload))`，不要直接把原始对象交给 logger。
import { createHash } from "node:crypto";
import { redactObject, redactString, truncateString } from "../log/redact";

/// 查询哈希取前 16 个十六进制字符：足以在日志里关联"同一条查询跑了几次"，
/// 又短到无法被用来反查原文（配合 salt-free 的单向哈希，本身也不可逆）。
const QUERY_HASH_LENGTH = 16;

/// 归一化 key（去掉下划线、连字符并小写），让 snake_case 与 camelCase 命中同一条规则。
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/// 查询类字段：值被替换成 { hash, length }。
/// objective 一并计入——研究目标同样是用户意图原文。
const QUERY_KEYS = new Set(["query", "querytext", "searchquery", "q", "objective", "text0"]);

/// 正文类字段：值被替换成长度占位。
/// 注意 `text` 同时是 chunk 正文与 query 文本的字段名，这里按"更保守的那个"处理（当正文）——
/// 查询文本另有 query/queryText 字段承载，误伤成本远低于漏记正文。
const BODY_KEYS = new Set([
  "text",
  "markdown",
  "content",
  "body",
  "html",
  "snippet",
  "excerpt",
  "chunktext",
  "rawtext",
  "report",
]);

/// URL 类字段：只保留 origin + pathname。
const URL_KEYS = new Set(["url", "canonicalurl", "locator", "href", "baseurl", "endpoint", "link"]);

/// 查询文本的单向指纹。
export function hashQueryText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, QUERY_HASH_LENGTH);
}

/// 去掉 URL 的 query string 与 fragment；无法解析时返回固定占位（绝不原样回显）。
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // 用户名/密码形式的 URL 也在这里被丢掉（URL.origin 不含 userinfo）。
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

/// 对任意 CRE 载荷做脱敏。
///
/// 两段式：先按 CRE 规则重写（查询/正文/URL），再整体过通用 redactObject
///（密钥 key、内嵌 Bearer、长字符串截断、循环引用护栏都由它兜底）。
/// 顺序不能反：先跑 redactObject 会把正文截断成 4000 字符**留在日志里**，红线就破了。
export function redactResearchLog(value: unknown): unknown {
  return redactObject(applyResearchRules(value, new WeakSet()));
}

/// CRE 规则的递归应用。带环护栏——载荷可能来自事件对象，存在自引用。
function applyResearchRules(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncateString(redactString(value));
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => applyResearchRules(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeKey(key);
    if (QUERY_KEYS.has(normalized) && typeof item === "string") {
      out[key] = { hash: hashQueryText(item), length: item.length };
      continue;
    }
    if (BODY_KEYS.has(normalized) && typeof item === "string") {
      out[key] = `[body omitted:${item.length}]`;
      continue;
    }
    if (URL_KEYS.has(normalized) && typeof item === "string") {
      out[key] = redactUrl(item);
      continue;
    }
    out[key] = applyResearchRules(item, seen);
  }
  return out;
}

/// 把一段密文/凭据的明文从任意文本里抹掉。
///
/// 提到本文件是为了让 search 与 stealth-fetch 两个客户端**共用同一份实现**：
/// 这类擦除函数一旦各写一份，就会出现「一边覆盖了 `Bearer <token>` 写法、另一边没有」
/// 的漂移，而漂移的后果是凭据出现在用户能看到（并可能截图外发）的错误文案里。
///
/// 只做整串替换：token 是不透明串，不需要按格式解析；`Bearer x` 里的 `x` 同样被整串命中。
export function scrubSecret(message: string, secret: string): string {
  if (secret.length === 0) return message;
  return message.split(secret).join("***");
}
