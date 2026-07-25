// 服务端 stealth 抓取的 main 侧 HTTP 客户端。
//
// 它把「桌面端抓不到的页面」交给 backend 的 `/research/fetch`，后者转给 research-fetch
// sidecar 用 Camoufox 抓（实测知乎专栏：本地 403 / 真 Chrome 被判 40362 / Camoufox 3/3 成功）。
//
// **为什么客户端在 main 而不在 worker**：请求要带 PAT。worker 处理的是不可信的外部 HTML，
// 把长期凭据放进那个进程等于让「一个解析漏洞」升级成「凭据泄漏」。main 拿到 HTML 后再
// 交给 worker 抽取正文——凭据不出 main，抽取逻辑不重复。
//
// 信任边界：sidecar 抓回来的 HTML 是**任意公网页面**，完全不可信。本文件只做四件事：
//   1. 限制读入字节数；
//   2. 校验响应形状（缺字段即视为契约漂移，不"尽力而为"地降级）；
//   3. 错误按有限枚举分类（编排层据此决定放弃还是重排）；
//   4. **所有对外文本都过一次 token 擦除** —— 服务端有可能把鉴权头回显进错误体。
import { scrubSecret } from "../redact-research";

/// 响应体读入上限（2 MiB），与服务端 MaxBodyBytes 一致。
/// 一篇长文的 HTML 远小于它；超过即视为异常，断流而不是解析。
export const MAX_STEALTH_RESPONSE_BYTES = 2 * 1024 * 1024;

/// 客户端超时。服务端总超时 40s，这里取 50s 余量，
/// 让「服务端超时并回结构化错误」优先于「我们断连」——前者的错误分类更有用。
const DEFAULT_TIMEOUT_MS = 50_000;

/// 错误分类。**必须是有限枚举**：编排层据此决定「这个候选放弃」还是「稍后重排」，
/// 按 message 文本判定会在措辞改动时静默失效。
export type StealthFetchErrorCode =
  /// 未配置服务端抓取（backend 没设 RESEARCH_FETCH_BASE_URL）。**不是错误**，
  /// 编排层应当据此彻底跳过 stealth 路径，而不是逐个候选重试。
  | "unconfigured"
  /// 凭据无效或过期。
  | "unauthorized"
  /// 无权访问该 workspace（服务端对非成员统一回 404，见验收记录 §19.2.6）。
  | "forbidden"
  /// URL 被 SSRF 策略拒绝。重试无意义。
  | "blocked_by_policy"
  /// 浏览器槽位已满。**可重排**，不代表这个候选抓不到。
  | "busy"
  /// 目标页面抓取失败（站点自身的问题）。
  | "fetch_failed"
  /// 超时。
  | "timeout"
  /// 服务端不可用 / 连接层失败。
  | "unavailable"
  /// 响应体超限或不符合契约。
  | "invalid_response"
  /// 调用方取消。
  | "cancelled";

export class StealthFetchError extends Error {
  constructor(
    readonly code: StealthFetchErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "StealthFetchError";
  }
}

/// 连接配置。token 是**已解密的明文**，只在 main 内存里存在，永不进日志、永不回 renderer。
export interface StealthFetchConfig {
  baseUrl: string;
  workspaceId: string;
  token: string;
}

export interface StealthFetchDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/// 一次抓取的结果。html 是原始 HTML，交给 worker 走既有的抽取管线。
export interface StealthFetchResult {
  /// 目标页面自身的 HTTP 状态码（可能是 404 —— 那是页面不存在，不是抓取失败）。
  status: number;
  html: string;
  finalUrl: string;
}

/// 服务端 stealth 抓取客户端。无状态，可安全复用。
export class StealthFetchClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: StealthFetchConfig,
    deps: StealthFetchDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /// 抓一个 URL。signal 用于编排层取消（pause / cancel）。
  async fetch(url: string, signal?: AbortSignal): Promise<StealthFetchResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ url }),
        signal: combined,
      });
    } catch (err) {
      // 区分「调用方取消」与「超时」：前者不该被当成故障记到警告里。
      if (signal?.aborted) throw this.fail("cancelled", "抓取已取消");
      if (timeoutSignal.aborted) throw this.fail("timeout", "抓取超时");
      throw this.fail("unavailable", `连接失败：${describe(err)}`);
    }

    if (!response.ok) {
      throw await this.readError(response);
    }

    const text = await this.readLimited(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw this.fail("invalid_response", "响应不是合法 JSON", response.status);
    }
    return this.parseResult(parsed, response.status);
  }

  /// 校验响应形状。**缺字段一律报错，不补默认值**：
  /// 「尽力而为地降级成空 HTML」会让契约漂移在几轮之后才以「研究没找到来源」的形式暴露。
  private parseResult(parsed: unknown, httpStatus: number): StealthFetchResult {
    if (typeof parsed !== "object" || parsed === null) {
      throw this.fail("invalid_response", "响应不是对象", httpStatus);
    }
    const raw = parsed as Record<string, unknown>;
    if (typeof raw["html"] !== "string") {
      throw this.fail("invalid_response", "响应缺少 html 字段", httpStatus);
    }
    return {
      status: typeof raw["status"] === "number" ? raw["status"] : 0,
      html: raw["html"],
      finalUrl: typeof raw["final_url"] === "string" ? raw["final_url"] : "",
    };
  }

  /// 读取响应体并限制字节数。
  private async readLimited(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_STEALTH_RESPONSE_BYTES) {
      throw this.fail("invalid_response", "响应体超过上限", response.status);
    }
    const text = await response.text();
    // Content-Length 可能缺失或撒谎，读完再校验一次真实长度。
    if (text.length > MAX_STEALTH_RESPONSE_BYTES) {
      throw this.fail("invalid_response", "响应体超过上限", response.status);
    }
    return text;
  }

  /// 非 2xx 的错误分类。优先用服务端回的 code（有限枚举），拿不到再退回状态码。
  private async readError(response: Response): Promise<StealthFetchError> {
    let serverCode = "";
    try {
      const body = (await response.text()).slice(0, 2048);
      const parsed = JSON.parse(body) as { error?: { code?: unknown } };
      if (typeof parsed.error?.code === "string") serverCode = parsed.error.code;
    } catch {
      // 错误体读不出或不是 JSON：按状态码兜底，不影响分类的正确性。
    }
    const code = mapCode(serverCode, response.status);
    return this.fail(code, `服务端返回 HTTP ${response.status}`, response.status);
  }

  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    return `${base}/api/workspaces/${encodeURIComponent(this.config.workspaceId)}/research/fetch`;
  }

  /// 统一构造错误：**所有对外文本都在这里过一次 token 擦除**，杜绝漏网。
  private fail(code: StealthFetchErrorCode, message: string, httpStatus?: number): StealthFetchError {
    return new StealthFetchError(code, scrubSecret(message, this.config.token), httpStatus);
  }
}

/// 服务端错误码 / HTTP 状态码 → 本地分类。
function mapCode(serverCode: string, status: number): StealthFetchErrorCode {
  switch (serverCode) {
    case "fetch_unconfigured":
      return "unconfigured";
    case "blocked_by_policy":
      return "blocked_by_policy";
    case "busy":
      return "busy";
    case "fetch_timeout":
      return "timeout";
    case "fetch_unavailable":
      return "unavailable";
    case "fetch_failed":
      return "fetch_failed";
  }
  if (status === 401) return "unauthorized";
  if (status === 403 || status === 404) return "forbidden";
  if (status === 429) return "busy";
  if (status === 504) return "timeout";
  if (status === 503) return "unavailable";
  return "fetch_failed";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}
