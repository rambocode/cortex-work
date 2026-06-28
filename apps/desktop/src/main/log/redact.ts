// 统一脱敏工具（字符串行 + 结构化对象两种形态）。
//
// 背景（为什么收敛）：迁移前存在两套独立脱敏口径——logger.ts 的 redactSensitive 对
// 「整行字符串」做正则替换；agent-trace.ts 的 sanitizeTraceData 对「结构化事件对象」
// 按 key 名脱敏并截断长文本。两者各扫一处，易漂移。本模块合并为单一来源：
//  - redactString：落盘文件行（日志一行已是字符串）用正则脱敏。
//  - redactObject：打印 agent 流式事件 / RPC 载荷（结构化对象）用 key 级脱敏 + 截断。
// electron-log 的 file transform 与 agent-trace 同源调用此处，杜绝第三套口径。

// 长文本上限：单条字符串超过即截断，避免单行日志/事件膨胀（兼作流式增量段的内容上限）。
export const MAX_STRING_LENGTH = 4000;

// 敏感字段名判定（对象 key 级）：归一化去掉非字母数字后匹配常见密钥字段。
// 覆盖 authorization / cortexpikey / *apikey* / *token* / *secret* / *password* / *credential*。
function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "cortexpikey" ||
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

// 截断超长字符串，尾部加省略号标记。
export function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
}

// 字符串行脱敏：把 api_key/apikey/token/secret/authorization 形态的「值」替换为 ***。
// 用于已格式化成单行字符串的日志（electron-log file transport 的最终落盘文本）。
export function redactString(line: string): string {
  return line.replace(
    /("?(?:api[_-]?key|apikey|token|secret|authorization)"?\s*[:=]\s*"?)([^",\s}]+)/gi,
    "$1***",
  );
}

// 结构化对象脱敏：递归遍历，命中敏感 key 名的值替换为 [redacted]，其余字符串截断。
// 用于打印 agent 流式事件 / RPC 载荷等结构化数据（不要把原始 JSON 直接喂给 logger）。
export function redactObject(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value);
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? "[redacted]" : redactObject(item);
  }
  return out;
}
