// in-process 引擎的「扩展 UI 桥」：把 pi 的 `ExtensionUIContext` 接到 Cortex 的
// `PiUiRequest` / `pi:uiResponse` 契约上（IPC 契约一字不改，渲染端零改动 —— 迁移计划 R1）。
//
// 旧路径：pi 子进程把 `{type:"extension_ui_request", id, method, ...}` 写到 stdout，主进程解析后
// 转发给 renderer；renderer 的应答再写回 stdin。in-process 后没有 stdout/stdin 了，改成
// 「pi 直接调用本对象的方法 → 我们造同形状的 PiUiRequest 交给 onUiRequest → renderer 应答经
// respond() 回填 Promise」。**协议字段与 3 态应答（confirmed / value / cancelled）保持逐字一致**，
// 因为 `main/ipc/types.ts` 的 `PiUiRequest` / `PiUiResponsePayload` 是硬约束。
//
// ── 挂起对话框是「会话不能死锁」的关键点 ──────────────────────────────────────────────
// pi 的工具 `execute()` 会 `await ctx.ui.confirm(...)`。没人回写就**永久挂起**（ctx.ui 不带 signal，
// abort 不会 reject）。旧路径靠 `emitUiRequest` 在 renderer 销毁时立刻回 `{cancelled:true}` 兜底；
// in-process 除此之外还多一条：会话 `stop()` 时必须把所有挂起项按默认值结算（`cancelAll`），
// 否则那些 Promise 连同它们持有的 agent loop 栈会一直留在主进程里（旧路径杀进程就自动清了）。

import { sanitizeAskQuestionEnvelope, sanitizeJsReplEnvelope } from "./rpc-shared";
import { createLogger } from "../../log";
import type { PiUiRequest, PiUiResponsePayload } from "../../ipc/types";

const log = createLogger("pi-inproc-ui");

/** pi 的 `ExtensionUIDialogOptions`（结构镜像；只用到 signal / timeout）。 */
interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface PiUiBridgeOptions {
  /** 需用户回写的对话框（confirm / select / input / editor / askquestion）出口。 */
  onUiRequest?: (req: PiUiRequest) => void;
  /**
   * fire-and-forget 的 notify。旧路径把它转成 `{type:"notify"}` **事件**而不是塞进对话框队列
   *（pi 不等应答，塞进队列就永远不显示）——这里保持同一决策。
   */
  onNotify: (message: string, level: "info" | "warning" | "error") => void;
  /**
   * askquestion 借道用的会话级高熵 sentinel。pi 实发的是 `method:"input"`、title 前缀带 sentinel +
   * JSON 信封；命中即归一为 `method:"askquestion"`。与 `PiRpcSession.normalizeUiRequest` 同源。
   */
  askQuestionSentinel?: string;
  /**
   * javascript_repl 借道用的会话级 sentinel（askQuestionSentinel 同轨）。命中即归一为
   * `method:"jsrepl"`——渲染端据此**静默**在沙箱 iframe 执行,绝不弹窗。sentinel 防的是
   * 磁盘扩展/提示注入伪造裸 input 触发渲染端执行任意 JS。
   */
  jsReplSentinel?: string;
  /** 生成请求 id。默认 `crypto.randomUUID()`（与 pi rpc-mode 一致）；单测可注入确定序列。 */
  makeId?: () => string;
}

export interface PiUiBridge {
  /**
   * 交给 `AgentSession.bindExtensions({ uiContext })` 的对象。
   * 类型是 `unknown`：pi 的 `ExtensionUIContext` 有 30 余个 TUI 专属成员（custom / setFooter /
   * theme / getAllThemes…），在无 TUI 的宿主里全部是 no-op，逐个声明只会制造噪音。
   * 会话层在传给 pi 时做一次显式 cast，cast 点集中在一处、有注释，比让本文件假装实现全接口更诚实。
   */
  context: unknown;
  /** renderer 的应答回填（`pi:uiResponse` → 会话 → 这里）。id 未知则静默丢弃（幂等）。 */
  respond(id: string, payload: PiUiResponsePayload): void;
  /** 会话终止：把所有挂起对话框按默认值结算，解锁 pi 的 execute。 */
  cancelAll(): void;
  /** 当前挂起数（诊断/测试用）。 */
  pendingCount(): number;
}

interface PendingDialog {
  /** 用 renderer 的应答结算。 */
  settle(payload: PiUiResponsePayload): void;
  /** 用默认值结算（取消 / 超时 / 会话终止）。 */
  cancel(): void;
}

/**
 * 建一个 UI 桥。
 *
 * 所有对话框方法都走同一条 `dialog()`：登记 pending → 发 PiUiRequest → 等回写。
 * 与 pi rpc-mode 的 `createDialogPromise` 行为对齐（signal / timeout 都退化为 defaultValue，
 * **不 reject**）—— reject 会让扩展的 execute 抛错，而用户「点了取消」不该是错误。
 */
export function createPiUiBridge(options: PiUiBridgeOptions): PiUiBridge {
  const { onUiRequest, onNotify, askQuestionSentinel, jsReplSentinel } = options;
  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  const pending = new Map<string, PendingDialog>();

  /** 造一个待回写的对话框请求。`parse` 把 3 态应答翻成该 method 的返回值。 */
  function dialog<T>(
    request: Omit<PiUiRequest, "id" | "type">,
    defaultValue: T,
    parse: (payload: PiUiResponsePayload) => T,
    opts?: DialogOptions,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    // 没有 UI 出口（如单发路径/渲染端已销毁前的极早期）→ 立刻按默认值结算，绝不挂起。
    if (!onUiRequest) return Promise.resolve(defaultValue);
    const id = makeId();
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
      };
      const onAbort = (): void => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timer = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      pending.set(id, {
        settle: (payload) => {
          cleanup();
          resolve(parse(payload));
        },
        cancel: () => {
          cleanup();
          resolve(defaultValue);
        },
      });
      try {
        onUiRequest(normalizeUiRequest({ type: "extension_ui_request", id, ...request } as PiUiRequest));
      } catch (err) {
        // 出口抛错（renderer 已销毁等）→ 立即按默认值结算，绝不留下永久挂起的 execute。
        log.warn("pi UI 请求派发失败，按默认值结算", { error: err instanceof Error ? err.message : String(err) });
        cleanup();
        resolve(defaultValue);
      }
    });
  }

  /**
   * 把「带本会话 sentinel 的 input 请求」归一为 askquestion 富信封；否则原样返回。
   * 与 `PiRpcSession.normalizeUiRequest` 逐条同源：sentinel 是每会话高熵 token，LLM 无法在裸
   * input 的 title 里伪造；解析/越界失败 → 记诊断 + 透传为裸 input（由 renderer 的 cancelled 兜底），
   * **不静默吞**，便于 pi 版本漂移时定位。
   */
  function normalizeUiRequest(req: PiUiRequest): PiUiRequest {
    if (req.method !== "input" || typeof req.title !== "string") return req;
    if (askQuestionSentinel && req.title.startsWith(askQuestionSentinel)) {
      const json = req.title.slice(askQuestionSentinel.length);
      try {
        const envelope = sanitizeAskQuestionEnvelope(JSON.parse(json));
        if (envelope) return { type: "extension_ui_request", id: req.id, method: "askquestion", envelope };
        log.warn("[pi-askquestion] 信封校验失败(空/越界/不可作答)，透传为裸 input");
      } catch {
        log.warn("[pi-askquestion] 信封 JSON 解析失败，透传为裸 input");
      }
      return req;
    }
    // jsrepl 借道（askquestion 同款）:命中 sentinel → 归一为 method:"jsrepl"（渲染端静默沙箱执行）。
    // 校验失败同样透传裸 input + 诊断（渲染端 cancelled 兜底），不静默吞。
    if (jsReplSentinel && req.title.startsWith(jsReplSentinel)) {
      const json = req.title.slice(jsReplSentinel.length);
      try {
        const envelope = sanitizeJsReplEnvelope(JSON.parse(json));
        if (envelope) return { type: "extension_ui_request", id: req.id, method: "jsrepl", envelope };
        log.warn("[pi-jsrepl] 信封校验失败(空 code/越界)，透传为裸 input");
      } catch {
        log.warn("[pi-jsrepl] 信封 JSON 解析失败，透传为裸 input");
      }
    }
    return req;
  }

  /** 3 态应答 → 字符串值（select / input / editor / askquestion 共用）。 */
  const asValue = (p: PiUiResponsePayload): string | undefined =>
    "cancelled" in p ? undefined : "value" in p ? p.value : undefined;

  // 只实现「在无 TUI 宿主里有意义」的成员，其余按 pi rpc-mode 的做法留 no-op。
  // 形状与 pi-coding-agent 0.82.1 `modes/rpc/rpc-mode.js` 的 createExtensionUIContext 对齐。
  const context = {
    select: (title: string, opts0: string[], opts?: DialogOptions) =>
      dialog({ method: "select", title, options: opts0, timeout: opts?.timeout } as never, undefined, asValue, opts),
    confirm: (title: string, message: string, opts?: DialogOptions) =>
      dialog(
        { method: "confirm", title, message, timeout: opts?.timeout } as never,
        false,
        (p) => ("cancelled" in p ? false : "confirmed" in p ? p.confirmed : false),
        opts,
      ),
    input: (title: string, placeholder?: string, opts?: DialogOptions) =>
      dialog({ method: "input", title, placeholder, timeout: opts?.timeout } as never, undefined, asValue, opts),
    editor: (title: string, prefill?: string) =>
      dialog({ method: "editor", title, prefill } as never, undefined, asValue),
    // fire-and-forget：转成事件而非对话框（见 PiUiBridgeOptions.onNotify 的说明）。
    notify: (message: string, type?: "info" | "warning" | "error") => {
      onNotify(String(message ?? ""), type === "warning" || type === "error" ? type : "info");
    },
    // 旧路径对 setStatus 是「无 UI 承接，丢弃」。保持一致，避免凭空多出一条渲染端不认识的事件。
    setStatus: () => {},
    setWidget: () => {},
    setTitle: () => {},
    setEditorText: () => {},
    pasteToEditor: () => {},
    getEditorText: () => "",
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    custom: async () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching not supported in Cortex host" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return {
    context,
    respond: (id, payload) => {
      const p = pending.get(id);
      if (!p) return; // 重复回写 / 已超时 / 已取消：幂等丢弃
      pending.delete(id);
      p.settle(payload);
    },
    cancelAll: () => {
      // 先取出再清空：cancel() 内部会调 cleanup() 二次删除，遍历中改 Map 不安全。
      const all = [...pending.values()];
      pending.clear();
      for (const p of all) {
        try {
          p.cancel();
        } catch {
          /* 结算失败不影响其余项 */
        }
      }
    },
    pendingCount: () => pending.size,
  };
}
