// Provider 登录（OAuth / 交互式 API Key）的交互状态机。
//
// ── 协议翻译 ─────────────────────────────────────────────────────────────────
// pi 的登录流程是 provider-owned 的：`Models.login(providerId, type, interaction)` 调用 provider
// 自己的 `auth.oauth.login` / `auth.apiKey.login`，通过 `AuthInteraction`（prompt/notify）与「UI」
// 对话（见 pi-ai/dist/auth/types.d.ts:95-157）。主进程在这里把它翻译成契约里的
// `ProviderAuthEvent`，经 `PROVIDER_IPC.authEvent` 推给 renderer；renderer 用
// `providerAuth:respond(requestId, value)` 回答。
//
// `requestId` 必须能对回**具体那一问** —— OAuth 会连续多问（先选登录方式，再贴回调码），
// 只按 providerId 匹配会把第二问的答案错配给第一问。
//
// ── auth_url / device_code 为什么要缓冲 ───────────────────────────────────────
// pi 是先 `notify({type:"auth_url"|"device_code"})` 再 `prompt({type:"manual_code"})`，两次调用；
// 而契约把 authUrl / deviceCode 挂在 `AuthPrompt` 上（UI 要在同一个对话框里既显示链接又收码）。
// 故把最近一次 notify 的 url/code 暂存，附到**下一个** prompt 上。
//
// ── 禁泄 ─────────────────────────────────────────────────────────────────────
// 所有对外文本（notify / error）都过 `redactAuthText`；用户输入的 value（可能是授权码或
// API Key）只在内存里传给 pi，绝不写日志。

import { shell } from "electron";

import { createLogger } from "../log";
import type {
  AuthNotice,
  AuthPrompt as ContractAuthPrompt,
  AuthPromptKind,
  ProviderAuthEvent,
  ProviderAuthStatus,
} from "./contract";
import type { PiAuthRuntime } from "./pi-runtime";
import { redactAuthText, safeErrorMessage } from "./secrets";

// pi 侧的交互类型（结构镜像，避免在纯逻辑文件里静态引 pi-ai 运行时）。
import type { AuthEvent, AuthInteraction, AuthPrompt as PiAuthPrompt, AuthType } from "@earendil-works/pi-ai";

const log = createLogger("provider-oauth");

/** 单问的等待上限：用户去浏览器授权再贴码，5 分钟足够，超时即判定放弃。 */
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60_000;
/** 整个登录流程的上限：防止 provider 实现自己卡死导致 session 永久占用。 */
const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60_000;

export interface LoginControllerDeps {
  runtime: PiAuthRuntime;
  /** 把事件推给 renderer（真实实现广播到所有窗口；单测收集到数组里）。 */
  emit: (event: ProviderAuthEvent) => void;
  /** 登录成功后回读认证状态，作为 `done` 事件的载荷。 */
  resolveStatus: (providerId: string) => Promise<ProviderAuthStatus>;
  /** 打开系统浏览器（OAuth 授权页）。 */
  openExternal?: (url: string) => void;
  promptTimeoutMs?: number;
  loginTimeoutMs?: number;
}

interface PendingPrompt {
  requestId: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** pi 的 per-prompt AbortSignal 监听器，清理时要摘掉，否则同一 signal 上会堆积监听。 */
  detach?: () => void;
}

interface LoginSession {
  providerId: string;
  abort: AbortController;
  pending?: PendingPrompt;
  /** 最近一次 notify 带来的授权 URL / 设备码，附到下一个 prompt 上（见文件头）。 */
  bufferedAuthUrl?: string;
  bufferedDeviceCode?: string;
  overallTimer: ReturnType<typeof setTimeout>;
}

export interface LoginController {
  /** 发起登录。**立即**返回「是否已启动」，最终结果经 done/error 事件推送。 */
  start(providerId: string): Promise<{ ok: boolean; error?: string }>;
  /** 回答某一问。requestId 不匹配当前待答问题时返回 ok:false（陈旧回答不生效）。 */
  respond(requestId: string, value: string): { ok: boolean; error?: string };
  /** 用户中途放弃。 */
  cancel(providerId: string): { ok: boolean; error?: string };
  /** 是否有进行中的登录（UI 防重入用）。 */
  isActive(providerId: string): boolean;
}

/** pi 的 prompt 类型与契约的 kind 一一对应；出现未知类型时按 text 兜底（不阻断登录）。 */
function toPromptKind(type: PiAuthPrompt["type"]): AuthPromptKind {
  switch (type) {
    case "secret":
      return "secret";
    case "select":
      return "select";
    case "manual_code":
      return "manual_code";
    default:
      return "text";
  }
}

let requestSeq = 0;
function nextRequestId(providerId: string): string {
  requestSeq += 1;
  return `${providerId}#${Date.now().toString(36)}#${requestSeq}`;
}

/** 建一个登录控制器。依赖全部注入，故可脱离 pi 运行时与 Electron 窗口单测。 */
export function createLoginController(deps: LoginControllerDeps): LoginController {
  const promptTimeoutMs = deps.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const loginTimeoutMs = deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const openExternal =
    deps.openExternal ??
    ((url: string) => {
      void shell.openExternal(url).catch(() => undefined);
    });

  const sessions = new Map<string, LoginSession>();
  /** requestId → providerId，供 respond 反查会话。 */
  const requestIndex = new Map<string, string>();

  function clearPending(session: LoginSession): void {
    const pending = session.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.detach?.();
    requestIndex.delete(pending.requestId);
    session.pending = undefined;
  }

  function finish(session: LoginSession): void {
    clearPending(session);
    clearTimeout(session.overallTimer);
    sessions.delete(session.providerId);
  }

  function notify(providerId: string, notice: AuthNotice): void {
    deps.emit({ type: "notify", providerId, notice });
  }

  /** 构造喂给 pi 的 AuthInteraction。prompt 的 Promise 由 respond/cancel/超时 三者之一了结。 */
  function buildInteraction(session: LoginSession): AuthInteraction {
    return {
      signal: session.abort.signal,
      prompt: (piPrompt: PiAuthPrompt) =>
        new Promise<string>((resolve, reject) => {
          // 同一时刻只允许一个待答问题：pi 的登录流程是串行提问的，若真出现并发，
          // 旧问题必须先失败，否则 requestIndex 会残留、UI 也会同时弹两个框。
          if (session.pending) {
            const stale = session.pending;
            clearPending(session);
            stale.reject(new Error("上一问被新的提问取代"));
            reject(new Error("上一问尚未回答即收到新提问"));
            return;
          }

          const requestId = nextRequestId(session.providerId);
          const prompt: ContractAuthPrompt = {
            requestId,
            kind: toPromptKind(piPrompt.type),
            label: redactAuthText(piPrompt.message),
            ...(piPrompt.type === "select"
              ? {
                  options: piPrompt.options.map((option) => ({
                    value: option.id,
                    label: option.description ? `${option.label} — ${option.description}` : option.label,
                  })),
                }
              : {}),
            ...(session.bufferedAuthUrl ? { authUrl: session.bufferedAuthUrl } : {}),
            ...(session.bufferedDeviceCode ? { deviceCode: session.bufferedDeviceCode } : {}),
          };
          // 缓冲值是「一次性」的：附给这一问后清空，避免后续无关提问继续挂着旧链接。
          session.bufferedAuthUrl = undefined;
          session.bufferedDeviceCode = undefined;

          const timer = setTimeout(() => {
            clearPending(session);
            reject(new Error("等待用户输入超时"));
          }, promptTimeoutMs);

          // pi 的 per-prompt signal：回调服务器抢先拿到 code 时会 abort 这一问（见 .d.ts:95-100）。
          let detach: (() => void) | undefined;
          if (piPrompt.signal) {
            const onAbort = () => {
              clearPending(session);
              reject(new Error("该提问已被流程取消"));
            };
            piPrompt.signal.addEventListener("abort", onAbort, { once: true });
            detach = () => piPrompt.signal?.removeEventListener("abort", onAbort);
          }

          session.pending = { requestId, resolve, reject, timer, ...(detach ? { detach } : {}) };
          requestIndex.set(requestId, session.providerId);
          deps.emit({ type: "prompt", providerId: session.providerId, prompt });
        }),
      notify: (event: AuthEvent) => {
        switch (event.type) {
          case "auth_url": {
            session.bufferedAuthUrl = event.url;
            openExternal(event.url);
            notify(session.providerId, {
              level: "info",
              message: redactAuthText(event.instructions ?? "已在浏览器中打开授权页面"),
            });
            return;
          }
          case "device_code": {
            session.bufferedDeviceCode = event.userCode;
            session.bufferedAuthUrl = event.verificationUri;
            notify(session.providerId, {
              level: "info",
              message: `请在 ${event.verificationUri} 输入设备码 ${event.userCode}`,
            });
            return;
          }
          case "progress": {
            notify(session.providerId, { level: "info", message: redactAuthText(event.message) });
            return;
          }
          default: {
            const links = (event.links ?? []).map((link) => `${link.label ?? "链接"}: ${link.url}`).join("；");
            notify(session.providerId, {
              level: "info",
              message: redactAuthText(links ? `${event.message}（${links}）` : event.message),
            });
          }
        }
      },
    };
  }

  return {
    async start(providerId) {
      if (sessions.has(providerId)) return { ok: false, error: "该 Provider 已有进行中的登录流程" };

      // 登录方式：有 OAuth 钩子就走 OAuth（「登录」按钮的语义），
      // 否则走交互式 api_key login。两者都没有的是纯 ambient provider，无从登录。
      let type: AuthType;
      try {
        const capability = (await deps.runtime.capabilities()).find((item) => item.providerId === providerId);
        if (!capability) return { ok: false, error: "未知的 Provider" };
        if (capability.oauth) type = "oauth";
        else if (capability.apiKeyLogin) type = "api_key";
        else return { ok: false, error: "该 Provider 不支持交互式登录（凭据来自环境或系统配置）" };
      } catch (err) {
        return { ok: false, error: safeErrorMessage(err, "无法读取 Provider 认证能力") };
      }

      const session: LoginSession = {
        providerId,
        abort: new AbortController(),
        overallTimer: setTimeout(() => {
          session.abort.abort();
          clearPending(session);
        }, loginTimeoutMs),
      };
      sessions.set(providerId, session);

      // 刻意不 await：登录流程会反复回调 prompt，等它结束会让 IPC invoke 悬挂到用户答完为止。
      void (async () => {
        try {
          await deps.runtime.login(providerId, type, buildInteraction(session));
          finish(session);
          deps.emit({ type: "done", providerId, status: await deps.resolveStatus(providerId) });
        } catch (err) {
          finish(session);
          const message = session.abort.signal.aborted ? "登录已取消" : safeErrorMessage(err, "登录失败");
          // 只记脱敏后的一句话：provider SDK 的错误对象常整体带着请求头与响应体。
          log.warn(`Provider 登录失败（${providerId}）: ${message}`);
          deps.emit({ type: "error", providerId, message });
        }
      })();

      return { ok: true };
    },

    respond(requestId, value) {
      const providerId = requestIndex.get(requestId);
      const session = providerId ? sessions.get(providerId) : undefined;
      const pending = session?.pending;
      if (!session || !pending || pending.requestId !== requestId) {
        return { ok: false, error: "该提问已失效（可能已超时或被取消）" };
      }
      const { resolve } = pending;
      clearPending(session);
      resolve(value);
      return { ok: true };
    },

    cancel(providerId) {
      const session = sessions.get(providerId);
      if (!session) return { ok: false, error: "没有进行中的登录流程" };
      const pending = session.pending;
      // 先 abort 再拒绝待答问题：pi 的 login 实现通常同时监听 signal，双保险确保它一定退出。
      session.abort.abort();
      clearPending(session);
      pending?.reject(new Error("登录已取消"));
      return { ok: true };
    },

    isActive(providerId) {
      return sessions.has(providerId);
    },
  };
}
