// 受控 HTTP 抓取（spec §12.3、§19.2）——CRE 抓取层的安全核心。
//
// 三道闸按顺序执行，**每一跳重定向都完整重跑一遍**：
//   1) core 的 checkUrlPolicy：scheme / userinfo / 端口 / 域名黑白名单 / IP 字面量；
//   2) resolveAndGuard：DNS 解析出的每个地址都过私网判定，任一命中即整体拒绝；
//   3) 连接钉扎：把已验证的地址通过自定义 lookup 交给 agent，杜绝「解析与连接之间 DNS 变了」
//      的 DNS rebinding 窗口。
// 少任何一道，`https://evil.example/ → 302 → http://169.254.169.254/` 就能读到云元数据。
//
// **刻意用 node:http / node:https 而非全局 fetch**：既有教训见 agents/pi-mcp-bridge.ts:170
// ——Electron utilityProcess 里的 undici fetch 可能不可用/抛 "fetch failed"。另外 undici 会读
// HTTP_PROXY/HTTPS_PROXY 环境代理，而 spec §12.3 要求禁用环境代理；node:http 默认不读代理，
// 再配合 `agent: false`（每请求新建默认 agent）连 globalAgent 被第三方库改写的风险一并规避。
//
// 本文件跑在 utilityProcess Worker 里，**禁止 import electron**。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkUrlPolicy, parseIpLiteral, type IpRange } from "@cortex-work/core/research/url-safety";
import type { FetchFailureCode } from "@cortex-work/core/research/evidence";
import { resolveAndGuard, type DnsLookupFn, type ResolvedAddress } from "./dns-guard";

/// HTML / 纯文本的字节上限（spec §12.3）。
export const MAX_HTML_BYTES = 10 * 1024 * 1024;
/// PDF 的字节上限（spec §12.3）。PDF 天然更大，故单独放宽。
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
/// 单请求总超时（连接 + 传输合计），spec §12.3。
export const DEFAULT_TIMEOUT_MS = 20_000;
/// 最大重定向跳数（spec §12.3「每次 redirect 重新执行完整策略」的配套上限）。
export const MAX_REDIRECTS = 5;

/// 允许抓取的媒体类型。白名单而非黑名单：未知类型一律 unsupported_media，
/// 避免把图片/视频/二进制包整包拖进内存。
const SUPPORTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/pdf",
]);

/// 传给 agent 的自定义 lookup 回调签名（与 node:net 的 LookupFunction 兼容）。
export type PinnedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void;

/// 交给 request 工厂的连接参数。字段刻意与 node:http 的 RequestOptions 子集同名，
/// 生产实现直接透传，测试实现可以对它做断言（钉扎地址、agent:false 等）。
export interface RequestOptions {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  lookup: PinnedLookup;
  /// 恒为 false：每请求新建默认 agent，既不复用连接池也不受 globalAgent 被改写影响。
  agent: false;
  servername?: string;
}

/// 响应流的最小形状（node:http 的 IncomingMessage 子集）。
export interface ResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy(): void;
}

/// 请求对象的最小形状（node:http 的 ClientRequest 子集）。
export interface ClientRequestLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  end(): void;
  destroy(err?: Error): void;
}

/// 可注入的请求工厂。生产按 protocol 分发到 node:http / node:https；测试传脚本化替身。
export type HttpRequestFn = (
  options: RequestOptions,
  onResponse: (res: ResponseLike) => void,
) => ClientRequestLike;

/// 抓取入参。
export interface SafeRequestInput {
  url: string;
  /// 附加请求头（User-Agent 等）。不会覆盖 Host——Host 由 hostname 决定。
  headers?: Record<string, string>;
  allowlist?: string[];
  blocklist?: string[];
  timeoutMs?: number;
  maxRedirects?: number;
  /// 允许的端口，默认 [80, 443]（spec §12.3）。做成参数只为集成测试能连本地随机端口的假站；
  /// 生产调用点一律不传——放开端口等于把内网端口扫描面交给模型生成的 URL。
  allowedPorts?: readonly number[];
}

/// 可注入依赖。forbiddenRanges 是参数：集成测试要用 loopback 假站，传空数组即可放行。
export interface SafeRequestDeps {
  request?: HttpRequestFn;
  lookup?: DnsLookupFn;
  forbiddenRanges?: readonly IpRange[];
  signal?: AbortSignal;
}

/// 抓取结果。失败码直接复用协议的 fetch_failure 枚举，上层无需再映射。
export type SafeRequestResult =
  | {
      ok: true;
      finalUrl: string;
      status: number;
      mediaType: string;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
      bytes: number;
      redirects: string[];
    }
  | { ok: false; code: FetchFailureCode; message: string; httpStatus?: number };

/// 生产用的请求工厂：按 protocol 分发到 node:http / node:https。
export const nodeHttpRequest: HttpRequestFn = (options, onResponse) => {
  const send = options.protocol === "https:" ? httpsRequest : httpRequest;
  return send(options as never, onResponse as never) as unknown as ClientRequestLike;
};

/// 从 Content-Type 头解析裸媒体类型（去参数、小写）。缺失时按 text/html 猜测——
/// 绝大多数缺 Content-Type 的站点返回的都是 HTML，且后续抽取本就能容忍非 HTML 输入。
function parseMediaType(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "text/html";
  return value.split(";")[0]!.trim().toLowerCase();
}

/// 取单值响应头。
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/// 按媒体类型给出字节上限。
function limitForMediaType(mediaType: string): number {
  return mediaType === "application/pdf" ? MAX_PDF_BYTES : MAX_HTML_BYTES;
}

/// 把 socket 层错误分类成协议的有限失败码：main 据此决定重试 / 降级 Browser / 放弃。
function classifyRequestError(err: Error & { code?: string }): {
  code: FetchFailureCode;
  message: string;
} {
  const code = err.code ?? "";
  // TLS 相关错误码族：证书链、协议版本、主机名不匹配等。它们重试无益，也不该降级到明文。
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.startsWith("CERT_") ||
    code.startsWith("UNABLE_TO_") ||
    code.startsWith("DEPTH_ZERO") ||
    code === "EPROTO" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN"
  ) {
    return { code: "tls_failure", message: err.message };
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "EAI_AGAIN"
  ) {
    return { code: "connect_failure", message: err.message };
  }
  return { code: "internal_error", message: err.message };
}

/// 构造把连接钉死在已验证地址上的 lookup 回调。
///
/// **这是 DNS rebinding 防线的落点**：resolveAndGuard 校验过的地址与真正建立连接时用的地址
/// 必须是同一个。如果让 agent 自己再解析一次，攻击者只要在两次解析之间把 A 记录切到 127.0.0.1
/// 就能穿透全部检查（经典 TOCTOU）。
function pinnedLookup(addresses: ResolvedAddress[]): PinnedLookup {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  };
}

/// 单跳请求的结果：要么已终结，要么给出下一跳的 Location。
type HopOutcome =
  | { kind: "done"; result: SafeRequestResult }
  | { kind: "redirect"; location: string };

/// 需要跟随的重定向状态码。303 也跟随（改用 GET 语义，我们本来就只发 GET）。
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/// 执行**单跳**请求，负责体积上限、超时、媒体类型与错误分类。策略校验由调用方在每跳前完成。
function performHop(
  url: URL,
  addresses: ResolvedAddress[],
  input: SafeRequestInput,
  deps: SafeRequestDeps,
): Promise<HopOutcome> {
  return new Promise<HopOutcome>((resolve) => {
    const send = deps.request ?? nodeHttpRequest;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const isIpHost = parseIpLiteral(url.hostname) !== null;

    let settled = false;
    // 显式初始化：settle 闭包在定时器创建之前就捕获了它，声明与赋值必须分开。
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let onAbort: (() => void) | undefined;

    // 单一收口：无论从哪个分支结束，都只 resolve 一次并清理定时器与 abort 监听。
    // 少了它，「超时 destroy → 随后 socket 抛 error」会二次 resolve，错误码变成随机的。
    const settle = (outcome: HopOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) deps.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const fail = (code: FetchFailureCode, message: string, httpStatus?: number): void =>
      settle({ kind: "done", result: { ok: false, code, message, httpStatus } });

    const options: RequestOptions = {
      protocol: url.protocol === "https:" ? "https:" : "http:",
      hostname: url.hostname,
      port: url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity",
        ...input.headers,
      },
      lookup: pinnedLookup(addresses),
      agent: false,
      // SNI 必须用域名；IP 字面量做 servername 是非法的 TLS 用法，此时不设。
      ...(url.protocol === "https:" && !isIpHost ? { servername: url.hostname } : {}),
    };

    const req = send(options, (res) => {
      const status = res.statusCode ?? 0;
      const mediaType = parseMediaType(res.headers);

      if (REDIRECT_STATUSES.has(status)) {
        const location = headerValue(res.headers, "location");
        res.destroy();
        if (!location) {
          fail("http_error", `HTTP ${status} 缺少 Location 头`, status);
          return;
        }
        settle({ kind: "redirect", location });
        return;
      }

      if (status < 200 || status >= 300) {
        res.destroy();
        fail("http_error", `HTTP ${status}`, status);
        return;
      }

      if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
        res.destroy();
        fail("unsupported_media", `不支持的媒体类型 ${mediaType}`);
        return;
      }

      const limit = limitForMediaType(mediaType);
      // 声明长度就已超限时直接断流：没有理由为了确认「确实太大」而把它下载完。
      const declared = Number.parseInt(headerValue(res.headers, "content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > limit) {
        res.destroy();
        fail("too_large", `声明长度 ${declared} 超过上限 ${limit}`);
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", ((chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        // 边收边判：超限**立即** destroy。收完再判等于把上限交给对端决定。
        if (received > limit) {
          res.destroy();
          fail("too_large", `响应体超过上限 ${limit} 字节`);
          return;
        }
        chunks.push(chunk);
      }) as (...args: unknown[]) => void);
      res.on("end", (() => {
        if (settled) return;
        const body = Buffer.concat(chunks);
        if (body.length === 0) {
          fail("empty_content", "响应体为空");
          return;
        }
        settle({
          kind: "done",
          result: {
            ok: true,
            finalUrl: url.href,
            status,
            mediaType,
            headers: res.headers,
            body,
            bytes: body.length,
            redirects: [],
          },
        });
      }) as (...args: unknown[]) => void);
      res.on("error", ((err: Error & { code?: string }) => {
        const classified = classifyRequestError(err);
        fail(classified.code, classified.message);
      }) as (...args: unknown[]) => void);
    });

    req.on("error", ((err: Error & { code?: string }) => {
      const classified = classifyRequestError(err);
      fail(classified.code, classified.message);
    }) as (...args: unknown[]) => void);

    // 自管超时而不是 req.setTimeout：后者只覆盖 socket 空闲，慢速持续投递的响应可以无限拖住我们。
    timer = setTimeout(() => {
      req.destroy();
      fail("timeout", `请求超过 ${timeoutMs}ms 未完成`);
    }, timeoutMs);

    if (deps.signal) {
      onAbort = (): void => {
        req.destroy();
        fail("cancelled", "请求已取消");
      };
      deps.signal.addEventListener("abort", onAbort, { once: true });
      // 已经 abort 的 signal 不会再触发 'abort' 事件。取消可能正好落在上一步 DNS 解析期间，
      // 此时 listener 挂晚了一步；不补这一次判定，该请求会一直挂到超时才结束。
      if (deps.signal.aborted) onAbort();
    }

    req.end();
  });
}

/// 受控抓取：完整策略 → DNS 私网判定 → 钉扎连接 → 手动跟随重定向（每跳重跑前两步）。
export async function safeRequest(
  input: SafeRequestInput,
  deps: SafeRequestDeps = {},
): Promise<SafeRequestResult> {
  const maxRedirects = input.maxRedirects ?? MAX_REDIRECTS;
  const redirects: string[] = [];
  let currentUrl = input.url;

  for (;;) {
    if (deps.signal?.aborted) {
      return { ok: false, code: "cancelled", message: "请求已取消" };
    }

    const policy = checkUrlPolicy({
      url: currentUrl,
      allowlist: input.allowlist,
      blocklist: input.blocklist,
      forbiddenRanges: deps.forbiddenRanges,
      ...(input.allowedPorts ? { allowedPorts: input.allowedPorts } : {}),
    });
    if (!policy.ok) {
      return { ok: false, code: "blocked_by_policy", message: policy.message };
    }

    const guard = await resolveAndGuard(policy.url.hostname, {
      lookup: deps.lookup,
      forbiddenRanges: deps.forbiddenRanges,
    });
    if (!guard.ok) {
      return { ok: false, code: guard.code, message: guard.message };
    }

    const outcome = await performHop(policy.url, guard.addresses, input, deps);
    if (outcome.kind === "done") {
      return outcome.result.ok ? { ...outcome.result, redirects } : outcome.result;
    }

    if (redirects.length >= maxRedirects) {
      return {
        ok: false,
        code: "blocked_by_policy",
        message: `重定向超过 ${maxRedirects} 跳，放弃抓取`,
      };
    }

    let next: URL;
    try {
      next = new URL(outcome.location, policy.url);
    } catch {
      return { ok: false, code: "blocked_by_policy", message: `无法解析的 Location: ${outcome.location}` };
    }
    currentUrl = next.href;
    redirects.push(currentUrl);
  }
}
