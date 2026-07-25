// URL / IP 安全判定（spec §12.3、§19.2.1）——CRE 抓取层的 SSRF 第一道闸。
//
// 为什么全部逻辑都停留在「字符串 + 数值」层：packages/core 是平台无关层，禁止 `node:dns`、
// `node:net` 等能力。真正的 DNS 解析由调用方（Worker / main 进程）完成，把解析出的地址
// 逐个交给 isForbiddenIp 复检；本模块只负责「给定一个主机名字面量或地址字节，它是否危险」。
// 这样同一套判定可以在 renderer 预校验、Worker 抓取前、以及每次 redirect 后重复执行。
//
// 命名风格：本文件属于领域层，一律 camelCase（协议 JSON 的 snake_case 见 ./protocol）。

/// 一个 CIDR 风格的地址段：start 固定为 16 字节（IPv4 用 IPv4-mapped 形式），
/// prefixLength 以「比特」计，取值 0..128。
export interface IpRange {
  start: Uint8Array;
  prefixLength: number;
}

/// URL 被策略拒绝的原因码。UI 与日志按此分类展示，不要用自由文本判定。
export type UrlRejectCode =
  | "invalid_url"
  | "bad_scheme"
  | "has_userinfo"
  | "bad_port"
  | "blocked_domain"
  | "not_allowed_domain"
  | "forbidden_ip";

/// checkUrlPolicy 的结果。成功时附带已解析的 URL，调用方直接复用，避免二次 parse 产生歧义。
export type UrlPolicyResult =
  | { ok: true; url: URL }
  | { ok: false; code: UrlRejectCode; message: string };

/// checkUrlPolicy 的入参。allowlist / blocklist / forbiddenRanges / allowedPorts 全部是参数，
/// 由 Consumer 的来源范围与本次 Session 配置注入，模块自身不持有任何可变全局状态。
export interface UrlPolicyInput {
  url: string;
  /// 非空时表示「白名单模式」：只有命中的域名可访问（Browser Adapter 的 --allowed-domains 同源）。
  allowlist?: string[];
  /// 优先级高于 allowlist：命中即拒。
  blocklist?: string[];
  forbiddenRanges?: readonly IpRange[];
  allowedPorts?: readonly number[];
}

/// 默认允许的端口。放开其它端口等于把内网服务扫描面直接交给模型生成的 URL。
const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

/// 构造 IPv4 段的 IPv4-mapped 表示。parseIpLiteral 对 IPv4 一律输出 ::ffff:a.b.c.d 的 16 字节，
/// 所以这里把 /n 换算成 /(96+n)，让 IPv4 与 IPv4-mapped 两种写法共用同一条规则、不可能漏配。
function v4Range(a: number, b: number, c: number, d: number, prefixLength: number): IpRange {
  const start = new Uint8Array(16);
  start[10] = 0xff;
  start[11] = 0xff;
  start[12] = a;
  start[13] = b;
  start[14] = c;
  start[15] = d;
  return { start, prefixLength: 96 + prefixLength };
}

/// 构造 IPv6 段。text 必须是能被 parseIpLiteral 解析的字面量，否则视为编码期错误。
function v6Range(text: string, prefixLength: number): IpRange {
  const start = parseIpLiteral(text);
  if (!start) throw new Error(`v6Range 收到非法 IPv6 字面量: ${text}`);
  return { start, prefixLength };
}

/// 默认禁止的地址段：loopback / 私网 / link-local / CGNAT / 组播 / 保留 / ULA。
/// 顺序无关（命中任一即拒），按 IPv4、IPv6 分组只为可读。
export const DEFAULT_FORBIDDEN_RANGES: readonly IpRange[] = [
  // ---- IPv4（同时覆盖其 IPv4-mapped 写法，见 v4Range 注释）----
  v4Range(0, 0, 0, 0, 8), // "本网络"，0.0.0.0 常被用来绕过 127 检查
  v4Range(10, 0, 0, 0, 8), // RFC1918
  v4Range(100, 64, 0, 0, 10), // CGNAT
  v4Range(127, 0, 0, 0, 8), // loopback
  v4Range(169, 254, 0, 0, 16), // link-local，含云元数据 169.254.169.254
  v4Range(172, 16, 0, 0, 12), // RFC1918
  v4Range(192, 168, 0, 0, 16), // RFC1918
  v4Range(224, 0, 0, 0, 4), // 组播
  v4Range(240, 0, 0, 0, 4), // 保留（含 255.255.255.255 受限广播）
  v4Range(255, 255, 255, 255, 32), // 受限广播，显式列出以便审计
  // ---- IPv6 ----
  v6Range("::1", 128), // loopback
  v6Range("::", 128), // 未指定地址
  // ::/96 是已废弃的 IPv4-compatible 段（如 ::127.0.0.1），它同样能落到本机，
  // 因此整段禁止；它在语义上已包含上面的 ::/128，保留后者只为让审计清单逐条对齐 spec。
  v6Range("::", 96),
  v6Range("fc00::", 7), // ULA
  v6Range("fe80::", 10), // link-local
  v6Range("ff00::", 8), // 组播
];

/// 判断一个字节串是否落在任一禁止段内。
///
/// **ranges 是参数而不是全局开关**：这是刻意的设计——集成测试要能启一个 127.0.0.1 的假站点
/// 来验证抓取管线，此时传入一个「不含 loopback」的段集合即可；生产调用点则始终传默认值
/// （或省略）。把它做成模块级可变开关会带来「测试里改了没还原 → 生产放行内网」的灾难性风险。
export function isForbiddenIp(
  bytes: Uint8Array,
  ranges: readonly IpRange[] = DEFAULT_FORBIDDEN_RANGES,
): boolean {
  // 长度不对说明上游解析出了问题；此时宁可误杀也不放行。
  if (bytes.length !== 16) return true;
  return ranges.some((range) => matchesRange(bytes, range));
}

/// 按比特前缀比较地址是否落入某段。
function matchesRange(bytes: Uint8Array, range: IpRange): boolean {
  // 结构非法的段（长度不对、前缀越界）按「不匹配」处理：它是配置错误，不该让整张表失效。
  if (range.start.length !== 16) return false;
  if (range.prefixLength < 0 || range.prefixLength > 128) return false;
  const fullBytes = range.prefixLength >> 3;
  const remainingBits = range.prefixLength & 7;
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== range.start[i]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((range.start[fullBytes] ?? 0) & mask);
}

/// 把主机名字面量归一成 16 字节地址；不是 IP 字面量（含普通域名、非法写法）时返回 null。
///
/// 为什么要自己实现而不依赖 `new URL()` 的归一：URL 解析器只在「输入本身就是 URL」时才会
/// 把 0x7f000001 归一成 127.0.0.1，而我们还要校验 redirect 的 Location、DNS 返回值、
/// 用户手填的 baseUrl 等裸主机名。八进制/十六进制/缺位补齐正是 SSRF 最常见的绕过手法。
export function parseIpLiteral(host: string): Uint8Array | null {
  if (typeof host !== "string" || host.length === 0) return null;
  const trimmed = host.trim();
  if (trimmed.length === 0) return null;
  // 带 ':' 或方括号的一律按 IPv6 处理；其余按 inet_aton 风格的 IPv4 处理。
  if (trimmed.includes(":") || trimmed.startsWith("[") || trimmed.endsWith("]")) {
    return parseIpv6(trimmed);
  }
  const v4 = parseIpv4(trimmed);
  return v4 ? toMapped(v4) : null;
}

/// 把 4 字节 IPv4 包成 ::ffff:a.b.c.d 的 16 字节，统一后续的段匹配。
function toMapped(v4: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  out.set(v4, 12);
  return out;
}

/// 解析单个 IPv4 段（十进制 / 0 开头八进制 / 0x 开头十六进制），非法返回 null。
function parseV4Part(part: string): number | null {
  if (part.length === 0) return null;
  // 限长以避免超出安全整数范围后静默截断（0x + 8 位、十进制 10 位、八进制 11 位足够表达 32 位）。
  if (part.length > 12) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return Number.parseInt(part, 8);
  if (/^[1-9][0-9]*$/.test(part)) return Number.parseInt(part, 10);
  return null;
}

/// inet_aton 风格的 IPv4 解析：支持 1~4 段，最后一段吃掉剩余全部字节（如 127.1 → 127.0.0.1）。
function parseIpv4(host: string): Uint8Array | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    const value = parseV4Part(part);
    if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }

  const out = new Uint8Array(4);
  const leading = values.length - 1;
  for (let i = 0; i < leading; i += 1) {
    const value = values[i] ?? 0;
    if (value > 0xff) return null;
    out[i] = value;
  }
  // 末段承载剩余的 (4 - leading) 个字节，超出即非法（如 4294967296 或 "1.2.3.256"）。
  const tailBytes = 4 - leading;
  const tail = values[leading];
  if (tail === undefined || tail >= 2 ** (8 * tailBytes)) return null;
  for (let i = 0; i < tailBytes; i += 1) {
    out[3 - i] = (tail >>> (8 * i)) & 0xff;
  }
  return out;
}

/// 解析 IPv6 的一侧分组（:: 前或 :: 后），输出字节序列；allowV4Tail 允许末段写成点分 IPv4。
function parseIpv6Side(text: string, allowV4Tail: boolean): number[] | null {
  if (text.length === 0) return [];
  const tokens = text.split(":");
  const bytes: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.includes(".")) {
      // 内嵌 IPv4 只能出现在最末一个分组，且该侧必须是地址的尾部。
      if (!allowV4Tail || i !== tokens.length - 1) return null;
      const v4 = parseIpv4(token);
      if (!v4) return null;
      bytes.push(...v4);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
    const value = Number.parseInt(token, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/// 解析 IPv6 字面量，兼容方括号包裹与 zone id（%eth0 / 百分号编码的 %25eth0）。
function parseIpv6(host: string): Uint8Array | null {
  let text = host;
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) return null;
    text = text.slice(1, -1);
  } else if (text.endsWith("]")) {
    return null;
  }
  // zone id 只对本机链路有意义，对安全判定无影响，直接截掉后再解析地址部分。
  const zoneIndex = text.indexOf("%");
  if (zoneIndex >= 0) text = text.slice(0, zoneIndex);
  if (!text.includes(":")) return null;

  const doubleIndex = text.indexOf("::");
  let headText = text;
  let tailText: string | null = null;
  if (doubleIndex >= 0) {
    // 「::」在一个地址中最多出现一次，出现两次是有歧义的写法，必须拒绝。
    if (text.indexOf("::", doubleIndex + 1) >= 0) return null;
    headText = text.slice(0, doubleIndex);
    tailText = text.slice(doubleIndex + 2);
  }

  const head = parseIpv6Side(headText, tailText === null);
  if (!head) return null;
  const tail = tailText === null ? [] : parseIpv6Side(tailText, true);
  if (!tail) return null;

  const out = new Uint8Array(16);
  if (tailText === null) {
    if (head.length !== 16) return null;
    out.set(head, 0);
    return out;
  }
  // 「::」至少代表一个分组（2 字节），因此两侧字节数之和必须严格小于 16。
  if (head.length + tail.length >= 16) return null;
  out.set(head, 0);
  out.set(tail, 16 - tail.length);
  return out;
}

/// 归一域名用于列表匹配：小写、去掉根域尾随点。
/// 尾随点必须去掉——`example.com.` 与 `example.com` 解析到同一主机，留着就是一条 blocklist 绕过。
function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  while (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return normalized;
}

/// 域名列表匹配：精确命中或「.entry」后缀命中。
/// 用 "." 拼接后缀而非裸 endsWith，是为了让 notexample.com 无法命中 example.com。
/// isIpLiteral 时只允许精确相等——IP 字面量没有域名层级，
/// 后缀匹配会让 "0.0.1" 这类条目意外放行 127.0.0.1。
function matchesDomainList(host: string, list: readonly string[], isIpLiteral: boolean): boolean {
  return list.some((raw) => {
    const entry = normalizeHost(raw);
    if (entry.length === 0) return false;
    if (host === entry) return true;
    if (isIpLiteral) return false;
    return host.endsWith(`.${entry}`);
  });
}

/// 取 URL 的实际端口（未显式指定时按协议取默认值）。
function resolvePort(url: URL): number {
  if (url.port.length > 0) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

/// 对一个待抓取 URL 执行完整的出站策略校验（spec §12.3）。
///
/// 检查顺序即拒绝优先级：解析 → 协议 → userinfo → 端口 → blocklist → allowlist → IP 段。
/// blocklist 先于 allowlist 是硬性要求：用户拉黑的域名不能靠白名单再被放回来。
/// **每次 redirect 都必须重新调用本函数**，否则「公网 URL 30x 跳私网」即可绕过全部检查。
export function checkUrlPolicy(input: UrlPolicyInput): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { ok: false, code: "invalid_url", message: `无法解析的 URL: ${input.url}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "bad_scheme", message: `只允许 http/https，收到 ${url.protocol}` };
  }

  // userinfo 会被部分 HTTP 客户端/代理按其自身规则解释，且常被用于伪装目标主机，一律拒绝。
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, code: "has_userinfo", message: "URL 不允许包含用户名或密码" };
  }

  const allowedPorts = input.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const port = resolvePort(url);
  if (!allowedPorts.includes(port)) {
    return { ok: false, code: "bad_port", message: `端口 ${port} 不在允许列表内` };
  }

  const host = normalizeHost(url.hostname);
  const ipBytes = parseIpLiteral(url.hostname);
  const isIpLiteral = ipBytes !== null;

  if (input.blocklist && matchesDomainList(host, input.blocklist, isIpLiteral)) {
    return { ok: false, code: "blocked_domain", message: `域名 ${host} 在黑名单内` };
  }

  if (
    input.allowlist &&
    input.allowlist.length > 0 &&
    !matchesDomainList(host, input.allowlist, isIpLiteral)
  ) {
    return { ok: false, code: "not_allowed_domain", message: `域名 ${host} 不在白名单内` };
  }

  if (ipBytes && isForbiddenIp(ipBytes, input.forbiddenRanges)) {
    return { ok: false, code: "forbidden_ip", message: `地址 ${host} 属于禁止访问的网段` };
  }

  return { ok: true, url };
}

/// 需要整段剥除的 tracking 参数（精确匹配）。utm_* 另行按前缀处理。
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gclid",
  "dclid",
  "fbclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_eid",
  "mc_cid",
  "ref",
  "ref_src",
  "referrer",
  "spm",
  "scm",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "wt_mc",
  "trk",
  "trkCampaign",
]);

/// 剥离已知 tracking 参数，返回**新的** URL 对象（入参不被修改）。
/// 只按前缀 `utm_` 匹配，不按 `utm` —— 否则会误伤 utmx 之类的业务参数。
export function stripTrackingParams(url: URL): URL {
  const next = new URL(url.href);
  const keys = [...next.searchParams.keys()];
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(key) || TRACKING_PARAMS.has(lower)) {
      next.searchParams.delete(key);
    }
  }
  // searchParams 全删空后 URL 仍可能残留 "?"，显式清掉，保证 href 稳定可比。
  if ([...next.searchParams.keys()].length === 0) next.search = "";
  return next;
}

/// 把 URL 归一成稳定的去重键；不是可抓取的 http/https URL 时返回 null。
///
/// 归一规则：小写 scheme 与 host、去主机尾随点、去默认端口、去 fragment、剥 tracking、
/// query 按 key 排序、路径末尾的连续斜杠折叠为一个。
/// 注意「/a」与「/a/」被视为**不同**资源（服务端语义确实可能不同），只折叠重复斜杠。
export function canonicalizeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const next = stripTrackingParams(parsed);
  next.hash = "";
  const host = normalizeHost(next.hostname);
  if (host.length === 0) return null;
  next.hostname = next.hostname.startsWith("[") ? `[${host}]` : host;

  // URL 构造器已自动去掉默认端口，这里只处理路径与 query 的稳定化。
  next.pathname = next.pathname.length === 0 ? "/" : next.pathname.replace(/\/{2,}$/, "/");
  if ([...next.searchParams.keys()].length > 0) {
    next.searchParams.sort();
  } else {
    next.search = "";
  }
  return next.href;
}
