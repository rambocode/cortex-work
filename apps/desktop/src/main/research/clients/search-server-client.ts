// Go Search Server 的 main 侧 HTTP 客户端（spec §11.2、§11.3、§9.1 第 3 步）。
//
// 信任边界：Search Server 是**外部服务**，它返回的一切都不可信。因此本文件只做三件事，
// 顺序不可换：
//   1. 限制读入的字节数（防超大响应把 main 拖垮）；
//   2. 过 parseSearchBatchResponse（zod，未知字段被剥离——远端塞不进任何提示词）；
//   3. 校验 request_id 与我们发出的一致（防串台/重放）。
// 校验没过的响应一律抛错，绝不"尽力而为"地降级成空结果——那会让契约漂移在几轮之后
// 才以「研究没找到来源」的形式暴露。
//
// 隐私红线（spec §19.3.1/§19.3.2）：**token 绝不出现在任何错误消息、日志或异常栈里**。
// 服务端有可能把鉴权头回显进错误体，所以所有对外文本都要过 scrubSecret 再抛。
import { scrubSecret } from "../redact-research";
import {
  SEARCH_LIMITS,
  parseSearchBatchResponse,
  type SearchBatchRequest,
  type SearchBatchResponse,
} from "@cortex-work/core/research/search-api";

/// 响应体读入上限（2 MiB）。8 条查询 × 20 条结果的正常响应远小于它；
/// 超过即视为异常或恶意，直接断流拒绝，不做解析。
export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

/// 客户端超时。取服务端总超时 + 5 秒余量（spec §11.2 要求客户端取相同或略大的值），
/// 让「服务端自己超时并回 503」优先于「客户端断连」，前者的错误分类更有用。
const DEFAULT_TIMEOUT_MS = SEARCH_LIMITS.totalTimeoutMs + 5_000;

/// 错误分类。**必须是有限枚举**：编排层据此决定重试 / 提示用户重新登录 / 直接放弃，
/// 按 message 文本判定会在措辞改动时静默失效。
export type SearchServerErrorCode =
  /// 401：凭据无效或过期，重试无意义，需用户重新配置。
  | "unauthorized"
  /// 403：非该 workspace 成员，重试无意义。
  | "forbidden"
  /// 503：全部 Provider 失败，属于可重试的临时故障。
  | "unavailable"
  /// 其它非 2xx。
  | "http_error"
  /// 响应体超过 MAX_SEARCH_RESPONSE_BYTES。
  | "too_large"
  /// 非 JSON 或不符合 schema。
  | "invalid_response"
  /// request_id 与请求不一致。
  | "request_mismatch"
  /// 连接层失败（DNS / TCP / TLS）。
  | "network_error"
  /// 调用方取消或超时。
  | "cancelled";

/// Search Server 调用失败。httpStatus 仅在拿到响应时有值。
export class SearchServerError extends Error {
  constructor(
    readonly code: SearchServerErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SearchServerError";
  }
}

/// 连接配置。token 是**已解密的明文**，只在 main 内存里存在，永不进日志、永不回 renderer。
export interface SearchServerConfig {
  baseUrl: string;
  workspaceId: string;
  token: string;
}

/// 注入依赖（照 ipc/openai-chat.ts 的惯例：fetchFn 可注入，测试零网络）。
export interface SearchServerDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /// 上报给服务端的桌面端版本；缺省 "unknown"（测试与早期启动阶段拿不到 app.getVersion）。
  clientVersion?: string;
}

/// 批量搜索客户端。无状态，可安全复用。
export class SearchServerClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clientVersion: string;

  constructor(
    private readonly config: SearchServerConfig,
    deps: SearchServerDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientVersion = deps.clientVersion ?? "unknown";
  }

  /// 发一次批量搜索。signal 用于编排层取消（pause / cancel）。
  async searchBatch(request: SearchBatchRequest, signal?: AbortSignal): Promise<SearchBatchResponse> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.token}`,
          "X-Client-Platform": "desktop",
          "X-Client-Version": this.clientVersion,
        },
        body: JSON.stringify(request),
        signal: combined,
      });
    } catch (err) {
      // 取消与网络失败必须分开：前者是用户意图（不该提示"搜索服务不可用"），后者才是故障。
      if (combined.aborted) {
        throw this.fail("cancelled", "搜索请求已取消");
      }
      throw this.fail("network_error", `搜索请求失败：${describe(err)}`);
    }

    if (!response.ok) {
      // 错误体只取前 200 字符用于诊断；scrubSecret 保证回显的鉴权头不会跟着进日志。
      const body = await response.text().catch(() => "");
      throw this.fail(
        statusToCode(response.status),
        `搜索服务返回 HTTP ${response.status}${body ? `：${body.slice(0, 200)}` : ""}`,
        response.status,
      );
    }

    const text = await this.readLimited(response);

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // 刻意不把 body 拼进消息：它可能整段都是攻击者可控的文本。
      throw this.fail("invalid_response", "搜索服务返回的不是合法 JSON");
    }

    let parsed: SearchBatchResponse;
    try {
      parsed = parseSearchBatchResponse(raw);
    } catch (err) {
      throw this.fail("invalid_response", `搜索响应不符合契约：${describe(err)}`);
    }

    // spec §9.1 第 3 步：request id 必须匹配。不匹配说明响应串台或被重放，
    // 把它当成本次请求的结果会把别人的候选写进本 Session 的证据链。
    if (parsed.request_id !== request.request_id) {
      throw this.fail("request_mismatch", "搜索响应的 request_id 与请求不一致");
    }
    return parsed;
  }

  /// 拼接批量搜索端点。workspaceId 走 encodeURIComponent，避免它含 `/` 时越权到别的路径。
  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    return `${base}/api/workspaces/${encodeURIComponent(this.config.workspaceId)}/research/search/batch`;
  }

  /// 带上限地读完响应体。
  ///
  /// 优先流式读取并在超限的那一刻就断流（`reader.cancel()`），而不是先 text() 再判长度——
  /// 后者面对一个 1 GiB 的恶意响应时，内存已经吃完了才发现超限。
  /// 没有 body 流的实现（部分替身 / polyfill）回退到 text() + 字节数复核。
  private async readLimited(response: Response): Promise<string> {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_SEARCH_RESPONSE_BYTES) {
        throw this.fail("too_large", "搜索响应超过大小上限");
      }
      return text;
    }

    const decoder = new TextDecoder();
    let total = 0;
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SEARCH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw this.fail("too_large", "搜索响应超过大小上限");
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  }

  /// 统一构造错误：**所有对外文本都在这里过一次 token 擦除**，杜绝漏网。
  private fail(code: SearchServerErrorCode, message: string, httpStatus?: number): SearchServerError {
    return new SearchServerError(code, scrubSecret(message, this.config.token), httpStatus);
  }
}

/// HTTP 状态码 → 错误分类。
function statusToCode(status: number): SearchServerErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 503) return "unavailable";
  return "http_error";
}

/// 异常的可读描述（不含正文、不含凭据）。
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
