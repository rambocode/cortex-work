// pi in-process 的 MCP 桥：把已启用的 MCP server 的工具发现出来，直接注册成 pi 原生 `customTools`
// （迁移计划 R5 / U3-3）。**取代** `pi-mcp-bridge.ts` 的「生成 .js extension 文件 + `-e` 加载」那一段。
//
// ── 与旧桥的关系（务必先读 `pi-mcp-bridge.ts` 的文件头）────────────────────────────────
// 旧路径：cortex 把每个 server 的配置 **烘焙进一个生成的 .js**，落 `userData/pi-extensions/`
//        （mode 0600），pi 子进程用 `-e` 加载，扩展在 startup 前异步「连 server → tools/list →
//         registerTool」。
// 新路径：同一套发现流程直接跑在主进程里，产出 `ToolDefinition[]` 喂给 `PiInProcDeps.customTools`。
//
// **server 收集逻辑不重写**：仍复用 `pi-mcp-bridge.ts` 已导出的 `collectBridgeServers` /
// `BridgeServer`（stdio 的 env 解析、非法 id 过滤、浏览器 server 并入都在那里）。本文件只替换
// 「怎么把发现到的工具交给 pi」这一段。
//
// **非目标**：不把 capability server（browser/slides/automation/calendar/knowledge/research/
// media-gen/doc-extract/loop-workflows/delegate…）内联化。它们继续以 MCP 协议提供工具，只是桥接
// 方式变了。内联化省协议往返是独立的后续优化，混做会让爆炸半径不可控（计划 §非目标）。
//
// ── 安全收益：密钥不再落盘 ────────────────────────────────────────────────────────────
// 旧路径把 **鉴权头**（浏览器 server 的 Bearer / X-Cortex-Session、用户自配远程 server 的 headers）
// 与 **stdio 的 env**（含 `${env:X}` 透传解析后的明文值）一起 `JSON.stringify` 进生成的 .js 文件。
// 本文件全程只在内存里持有 `BridgeServer`：headers 只出现在 `fetch` 的 init 里，env 只出现在
// `spawn` 的 options 里，**没有任何写文件动作**（本文件不 import `fs`，这是可 grep 的硬事实）。
//
// ── 进程隔离消失后的四条边界（计划最高风险项）────────────────────────────────────────
//  1. **单 server 失败只跳过该 server**（与旧实现逐字同义）：任何一个 server 连不上/超时/协议不符，
//     只把它记进 `failed[]` 并 warn，不影响其它 server，更不阻断会话启动。
//  2. **失败必须留痕**（KTD5）：in-process 后没有子进程退出码兜底，错误只会被吞进事件流。所以
//     每条失败都同时走 `log.warn` 与返回值 `failed[]`，调用方可再上报，绝不静默 `continue`。
//  3. **超时与 abort 有界**：控制面 20s、tools/call 30min（分级理由见下），且 pi 传进来的
//     `AbortSignal`（用户点「停止」）会真的取消在途请求 —— 旧路径不管 abort，一个 30min 的调用
//     会挂到超时为止；子进程里挂着无所谓，主进程里挂着就是泄漏。
//  4. **会话结束必须 `dispose()`**：stdio 子进程旧路径随 pi 进程一起死，现在主进程长生不老，
//     不显式 kill 就会一路累积。`dispose()` 幂等，且会 abort 所有在途 HTTP 请求。

import { spawn as nodeSpawn } from "node:child_process";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { collectBridgeServers, type BridgeServer } from "./pi-mcp-bridge";
import { createLogger } from "../log";
import type { McpServerConfig } from "../ipc/types";

const log = createLogger("pi-mcp-inproc");

// ── 常量 ──────────────────────────────────────────────────────────────────────────────

/**
 * 分级超时（与旧桥同值同义，不要合并成一个）。
 * 控制面（initialize / tools/list）是本地快操作，20s 足够且能及时暴露「server 起不来」；
 * tools/call 是业务执行面，delegate 子 agent 委派、design-delegate、slides、媒体生成
 *（视频轮询按模态钳制最长 25min）都是分钟级长任务，统一 20s 会把它们拦腰截断。
 * 30min = 覆盖 video 25min 钳制 + 5min 余量。
 */
export const MCP_CONTROL_TIMEOUT_MS = 20_000;
export const MCP_CALL_TIMEOUT_MS = 30 * 60_000;

/** 与旧桥一致的 MCP 协议版本与客户端标识（server 侧可能按此做兼容分支，别随手改）。 */
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_CLIENT_INFO = { name: "cortex-pi-inproc", version: "1.0.0" };

/**
 * 保留工具名：pi 的内建工具集。
 *
 * 为什么要防：`AgentSession._refreshToolRegistry()` 把 `customTools` **后置**写进
 * definitionRegistry，同名即**静默覆盖**内建工具。一个 MCP server 只要暴露个叫 `read` 的工具，
 * pi 的文件读取就被换掉了，而且没有任何报错。旧路径（extension `registerTool`）有同样的隐患，
 * 只是没人碰过；in-process 后爆炸半径落在主进程，不能继续赌。
 *
 * 这是本文件相对旧实现**刻意加强**的一处：命中即跳过并 warn（计划要求「旧实现没覆盖的，
 * 选择跳过并留痕」）。集成阶段可改传 `pi-inproc/tools.ts` 的 `PI_BUILTIN_TOOL_NAMES`；
 * 这里保留一份字面量是为了不跨 U 硬依赖尚未接线的模块。
 */
export const PI_RESERVED_TOOL_NAMES: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

/** stderr 诊断尾巴的保留上限：够定位「server 启动即报错」，又不至于把主进程内存喂大。 */
const STDERR_TAIL_LIMIT = 2_000;

// ── 传输替身注入点（单测用，绝不真起 server）──────────────────────────────────────────

/** `spawn` 的最小结构视图。收窄成接口是为了单测能塞一个纯内存的假子进程。 */
export interface McpChildLike {
  stdout: { setEncoding(enc: "utf8"): unknown; on(event: "data", listener: (chunk: string) => void): unknown } | null;
  stderr: { setEncoding(enc: "utf8"): unknown; on(event: "data", listener: (chunk: string) => void): unknown } | null;
  stdin: { write(data: string): unknown; on(event: "error", listener: (err: Error) => void): unknown } | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type McpSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string | undefined; stdio: ["pipe", "pipe", "pipe"] },
) => McpChildLike;

/** `fetch` 的最小结构视图（同上，单测替身用）。 */
export interface McpFetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type McpFetchFn = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<McpFetchResponse>;

/**
 * 默认 stdio：`node:child_process.spawn`。
 * cast 是刻意的 —— `ChildProcess` 的 `on` 是巨型重载联合，直接结构化匹配会把接口拖成噪音。
 */
const defaultSpawn: McpSpawnFn = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as McpChildLike;

/**
 * 默认 HTTP：全局 `fetch`。
 *
 * 旧桥刻意用 `node:http/https` 而非 fetch，理由写在它的文件头：那份代码是**注入进 pi 宿主进程**
 * 执行的，那个宿主的全局 fetch（undici）曾实测不可用。本文件跑在 Electron 主进程里，`fetch` 就是
 * Node 自带的 undici（与 `capabilities/` 下一众 server 客户端同源，早已在生产路径上验证），
 * 那条约束不随之迁移。用 fetch 换来的是原生 `AbortSignal` 支持 —— 见文件头边界 3。
 */
const defaultFetch: McpFetchFn = (url, init) => fetch(url, init);

// ── 客户端契约 ────────────────────────────────────────────────────────────────────────

/** 极简 MCP 客户端：只实现 initialize / notifications/initialized / tools/list / tools/call。 */
interface McpClient {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): void;
  /** 失败诊断补充（stdio 的 stderr 尾巴）。无则返回空串。 */
  diagnostics(): string;
}

/** 按 method 选超时：仅 tools/call 用长超时，其余全走控制面。 */
function timeoutForMethod(method: string, opts: ResolvedOptions): number {
  return method === "tools/call" ? opts.callTimeoutMs : opts.controlTimeoutMs;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── stdio 传输 ────────────────────────────────────────────────────────────────────────

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * stdio 传输：spawn 子进程，换行分帧 JSON-RPC（MCP stdio 规范：一行一条消息，无内嵌换行）。
 * 帧解析、pending 表、退出即全量 reject 的语义与旧桥逐条一致。
 */
function createStdioClient(server: BridgeServer, opts: ResolvedOptions): McpClient {
  const child = opts.spawnFn(server.command ?? "", server.args ?? [], {
    // 继承主进程 env 再叠加 server 自己的（stdio server 常靠 PATH/HOME 找依赖）。
    env: { ...process.env, ...(server.env ?? {}) },
    cwd: server.cwd || undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, PendingEntry>();
  let closedError: Error | null = null;
  let buf = "";
  let nextId = 0;
  let stderrTail = "";

  child.stdout?.setEncoding("utf8");
  // stderr 必须被消费，否则管道胀满会**阻塞子进程**（旧桥用 resume()）；这里顺手留最后一段，
  // 让「server 启动即报错」的失败信息能进 failed[]，而不是只有一句「子进程已退出 code=1」。
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  // 子进程已死还写 stdin 会抛 EPIPE，吞掉即可（真正的失败由 exit 事件表达）。
  child.stdin?.on("error", () => {});

  function rejectAllPending(error: Error): void {
    closedError = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  }

  child.on("error", (error: Error) => rejectAllPending(error));
  child.on("exit", (code: number | null, signal: string | null) => {
    rejectAllPending(new Error(`MCP 子进程已退出: code=${String(code)} signal=${String(signal)}`));
  });

  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line.trim()) continue;
      let msg: { id?: unknown; error?: { message?: string }; result?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // 非 JSON 行（某些 server 会往 stdout 打日志）直接丢，不能因此杀连接
      }
      if (typeof msg?.id !== "number") continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
      else p.resolve(msg.result);
    }
  });

  function writeFrame(payload: Record<string, unknown>): void {
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  function notify(method: string, params: unknown): void {
    try {
      writeFrame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    } catch {
      // 通知失败不阻断（与旧桥同）：notify 无应答，失败也无从补救。
    }
  }

  function request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (closedError) return Promise.reject(closedError);
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      // settle 统一收口：清超时、摘 abort 监听、删 pending。三者漏一个都是泄漏。
      let done = false;
      const cleanup = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
      };
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        cleanup();
        reject(new Error(`MCP 超时: ${method}`));
      }, timeoutForMethod(method, opts));
      // 用户点「停止」时 pi 会 abort 工具的 signal。旧路径不管它（子进程里挂着无所谓），
      // in-process 必须真取消：本地释放 pending，并按 MCP 规范通知 server 别再干了。
      function onAbort(): void {
        if (!pending.has(id)) return;
        cleanup();
        notify("notifications/cancelled", { requestId: id, reason: "客户端取消" });
        reject(new Error(`MCP 请求已取消: ${method}`));
      }
      if (signal?.aborted) {
        cleanup();
        reject(new Error(`MCP 请求已取消: ${method}`));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      try {
        writeFrame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  return {
    request,
    notify,
    close: () => {
      try {
        child.kill();
      } catch {
        // 已死/无权限都无所谓：close 是尽力而为的资源回收
      }
      rejectAllPending(new Error("MCP 客户端已关闭"));
    },
    diagnostics: () => stderrTail.trim(),
  };
}

// ── streamable-http 传输 ──────────────────────────────────────────────────────────────

/**
 * 从 SSE 文本里取出 id 匹配的 JSON-RPC 响应（无 id 的消息作兜底）。与旧桥同实现。
 * 导出仅为单测直测这段分帧逻辑。
 */
export function parseSseForId(text: string, id: number): Record<string, unknown> | null {
  let fallback: Record<string, unknown> | null = null;
  for (const block of text.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (msg?.id === id) return msg;
    if (msg && msg.id == null && !fallback) fallback = msg;
  }
  return fallback;
}

/**
 * streamable-http 传输：每条 JSON-RPC 一次 POST。
 *
 * `accept` 必须同时含 `application/json` 与 `text/event-stream`（SDK 的
 * `StreamableHTTPServerTransport` 据此判定，缺则 406）。响应头里的 `mcp-session-id` 要捕获并
 * 在后续请求回送（远程有状态 server 依赖它）。
 *
 * legacy `sse` 传输也走这里（尽力而为）：纯 GET-SSE 的旧端点可能不通，连接时会 warn。
 */
function createHttpClient(server: BridgeServer, opts: ResolvedOptions): McpClient {
  let sessionId: string | null = null;
  let nextId = 0;
  let closed = false;
  // 在途请求的 controller 集合：`close()` 要能把它们全 abort 掉，否则一个 30min 的
  // tools/call 会在会话早就销毁之后继续占着连接（旧路径杀进程就自动清了）。
  const inflight = new Set<AbortController>();

  async function rpc(method: string, params: unknown, isNotify: boolean, signal?: AbortSignal): Promise<unknown> {
    if (closed) throw new Error("MCP 客户端已关闭");
    const id = isNotify ? undefined : ++nextId;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(server.headers ?? {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    };
    const envelope: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (id != null) envelope.id = id;
    if (params !== undefined) envelope.params = params;

    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("MCP HTTP 超时")), timeoutForMethod(method, opts));
    const forwardAbort = (): void => controller.abort(new Error("客户端取消"));
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });

    // 超时/abort 必须**覆盖到读完 body 为止**，不能只包住 fetch()：
    // streamable-http 的响应是 SSE 流，server 完全可以先把响应头发回来、再把流吊着不结束。
    // 只包 fetch() 的话那种 server 会让 `res.text()` 永久挂住，而在途 controller 又已被摘掉，
    // 连 dispose() 都救不回来 —— in-process 下这就是一条泄漏到主进程的僵尸请求。
    try {
      const res = await opts.fetchFn(server.url ?? "", {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (isNotify) return undefined;
      // 202 = server 只 ack 不回包（notify 语义），与 200 一样视为成功。
      if (res.status !== 200 && res.status !== 202) throw new Error(`MCP HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const payload = ct.includes("text/event-stream")
        ? parseSseForId(body, id as number)
        : body
          ? (JSON.parse(body) as Record<string, unknown>)
          : null;
      if (!payload) throw new Error(`MCP 无响应: ${method}`);
      const rpcError = payload.error as { message?: string } | undefined;
      if (rpcError) throw new Error(rpcError.message || "MCP error");
      return payload.result;
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  return {
    request: (method, params, signal) => rpc(method, params, false, signal),
    // notify 刻意不返回 Promise：调用方不 await，未处理的 reject 在 in-process 下会变成
    // **主进程 unhandledRejection**（旧路径顶多打到 pi 子进程）。这里就地吞掉。
    notify: (method, params) => {
      void rpc(method, params, true).catch((err: unknown) => {
        log.debug("MCP 通知发送失败（忽略）", { server: server.id, method, error: errText(err) });
      });
    },
    close: () => {
      closed = true;
      for (const c of inflight) {
        try {
          c.abort(new Error("MCP 客户端已关闭"));
        } catch {
          // abort 不该抛，兜底而已
        }
      }
      inflight.clear();
    },
    diagnostics: () => "",
  };
}

// ── 工具映射 ──────────────────────────────────────────────────────────────────────────

/** MCP `tools/list` 里的一条。字段按 MCP 规范，全部按「可能缺」处理。 */
interface McpToolInfo {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * 把 MCP `tools/call` 的 content 归一成 pi 认识的 `TextContent | ImageContent`。
 *
 * 旧桥是**原样透传**：MCP 还有 `audio` / `resource` / `resource_link` 三类 content，pi 没有对应
 * 类型，透传下去会在 provider 序列化时炸成一个跟 MCP 毫无关系的堆栈。这里降级成 text 并留痕，
 * 属于「旧实现没覆盖的边界，选择跳过并留痕」。
 */
function toPiContent(raw: unknown, serverId: string): PiContent[] {
  if (!Array.isArray(raw)) return [{ type: "text", text: JSON.stringify(raw ?? null) }];
  const out: PiContent[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      out.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      out.push({ type: "image", data: item.data, mimeType: item.mimeType });
      continue;
    }
    log.debug("MCP 返回了 pi 无对应类型的 content，已降级为文本", { server: serverId, type: String(item.type) });
    out.push({ type: "text", text: JSON.stringify(item) });
  }
  // 空 content 是合法的（工具只做副作用），但直接给 pi 一个空数组会让模型看到「什么都没发生」。
  return out.length ? out : [{ type: "text", text: "(MCP 工具无输出)" }];
}

/** `tools/call` 的返回壳。 */
interface McpCallResult {
  content?: unknown;
  isError?: unknown;
  structuredContent?: unknown;
}

/**
 * 把一条 MCP 工具定义包成 pi 的 `ToolDefinition`。
 *
 * 两处与旧桥的**语义差异**，都是被 pi 原生契约逼出来的，不是随手改的：
 *  1. `parameters` 直接吃 MCP 的 JSON Schema。pi-ai 的 `validateToolArguments` 对「没有
 *     TypeBox Kind 符号」的纯 JSON Schema 有专门分支（`coerceWithJsonSchema`），所以不需要
 *     转 TypeBox —— 与旧桥「普通 JSON Schema 即可」的实测结论一致。
 *  2. 失败用 **throw** 而不是返回 `{isError:true}`。pi 的 `AgentToolResult` 根本没有 `isError`
 *     字段（旧桥那个字段是被静默丢弃的，模型看到的是一条「成功」的工具结果里写着失败文案）；
 *     agent-loop 只认 execute 抛异常 → `createErrorToolResult` → 转录里标红。throw 才是正确映射。
 */
function buildToolDefinition(info: McpToolInfo, server: BridgeServer, client: McpClient): ToolDefinition {
  const name = info.name as string;
  const schema =
    info.inputSchema && typeof info.inputSchema === "object"
      ? (info.inputSchema as Record<string, unknown>)
      : { type: "object", properties: {} };
  return {
    name,
    // label 只用于 TUI 展示，Cortex 的 renderer 走事件里的工具名，故直接用 name。
    label: name,
    description: typeof info.description === "string" ? info.description : "",
    // 刻意不填 `promptSnippet`：旧路径的 extension `registerTool` 同样没有，填了会改动系统提示
    // 的静态前缀（影响 provider 侧 prompt 缓存命中）。保持与旧路径逐字一致。
    parameters: schema as unknown as ToolDefinition["parameters"],
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      // 这里**不 try/catch**：抛出去正是我们要的错误语义（见上面第 2 点）。超时/取消/连接已死
      // 都由 client.request 抛具体消息，pi 会把它当成工具错误结果交给模型，用户也能在 UI 看到。
      const raw = (await client.request("tools/call", { name, arguments: args }, signal)) as McpCallResult | null;
      const content = toPiContent(raw?.content, server.id);
      if (raw?.isError === true) {
        // MCP 协议层的「工具自己报错」。转成 throw，与传输失败走同一条错误通道。
        const text = content
          .map((c) => (c.type === "text" ? c.text : "(image)"))
          .join("\n")
          .slice(0, 2_000);
        throw new Error(`MCP 工具 ${name} 执行失败: ${text}`);
      }
      return {
        content,
        // details 供日志/UI 使用；带上来源 server 便于排查「这工具哪来的」。
        details: { serverId: server.id, ...(raw?.structuredContent ? { structuredContent: raw.structuredContent } : {}) },
      };
    },
  };
}

// ── 对外契约 ──────────────────────────────────────────────────────────────────────────

export interface McpBridgeFailure {
  /** 失败的 server id（与 `BridgeServer.id`、设置页展示的 id 同一个）。 */
  id: string;
  /** 人类可读原因。stdio 会带上 server 自己的 stderr 尾巴。 */
  error: string;
}

/**
 * 一次会话的 MCP 桥。`tools` 可直接喂 `PiInProcDeps.customTools`。
 *
 * **生命周期契约**：`dispose()` 必须在会话结束时调用（`PiInProcSession.stop()` 一侧接线），
 * 否则 stdio 子进程与在途 HTTP 请求会一路累积在主进程里。幂等，可重复调。
 */
export interface McpInProcBridge {
  tools: ToolDefinition[];
  /** 成功接入的 server id（按输入顺序）。 */
  connected: string[];
  /** 每个 server 最终通过名称/冲突校验的工具；required 能力不能只凭 connected 判定。 */
  acceptedTools: Record<string, string[]>;
  /** 接入失败的 server（KTD5：失败必须能被看见，不能只留一条 warn 日志）。 */
  failed: McpBridgeFailure[];
  dispose(): Promise<void>;
}

export interface McpInProcOptions {
  /** 单测替身：stdio。 */
  spawnFn?: McpSpawnFn;
  /** 单测替身：http。 */
  fetchFn?: McpFetchFn;
  /** 禁止被 MCP 工具占用的名字。缺省 `PI_RESERVED_TOOL_NAMES`，传 `[]` 可关闭该保护。 */
  reservedToolNames?: readonly string[];
  controlTimeoutMs?: number;
  callTimeoutMs?: number;
}

interface ResolvedOptions {
  spawnFn: McpSpawnFn;
  fetchFn: McpFetchFn;
  reservedToolNames: ReadonlySet<string>;
  controlTimeoutMs: number;
  callTimeoutMs: number;
}

function resolveOptions(options: McpInProcOptions): ResolvedOptions {
  return {
    spawnFn: options.spawnFn ?? defaultSpawn,
    fetchFn: options.fetchFn ?? defaultFetch,
    reservedToolNames: new Set(options.reservedToolNames ?? PI_RESERVED_TOOL_NAMES),
    controlTimeoutMs: options.controlTimeoutMs ?? MCP_CONTROL_TIMEOUT_MS,
    callTimeoutMs: options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
  };
}

/** 单个 server 的接入结果（内部用，供确定性合并）。 */
interface ServerOutcome {
  server: BridgeServer;
  client?: McpClient;
  tools: McpToolInfo[];
  error?: string;
}

/**
 * 连一个 server 并拿到它的工具清单。**本函数不抛** —— 失败信息落在 `outcome.error` 上，
 * 单 server 失败只跳过该 server（文件头边界 1）。
 */
async function connectServer(server: BridgeServer, opts: ResolvedOptions): Promise<ServerOutcome> {
  if (server.transport === "sse") {
    // legacy sse：按 streamable-http 尽力而为（与旧桥同决策）。纯 GET-SSE 的旧端点连不上，
    // 会在下面的 initialize 处以「MCP HTTP 405/406」之类的形式失败并进 failed[]。
    log.warn("MCP server 使用 legacy sse 传输，按 streamable-http 尽力而为", { server: server.id });
  }
  let client: McpClient | undefined;
  try {
    client = server.transport === "stdio" ? createStdioClient(server, opts) : createHttpClient(server, opts);
    await client.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    });
    client.notify("notifications/initialized", {});
    const list = (await client.request("tools/list", {})) as { tools?: unknown } | null;
    const tools = Array.isArray(list?.tools) ? (list.tools as McpToolInfo[]) : [];
    return { server, client, tools };
  } catch (err) {
    // 失败即回收：连不上的 server 也可能已经 spawn 出了子进程 / 建了连接。
    if (client) {
      try {
        client.close();
      } catch {
        // 忽略：回收路径不该再抛
      }
    }
    const detail = client?.diagnostics();
    return {
      server,
      tools: [],
      error: detail ? `${errText(err)}（server 输出: ${detail}）` : errText(err),
    };
  }
}

/**
 * 建立 in-process MCP 桥：逐个 server 连接 → 握手 → `tools/list` → 包成原生 `ToolDefinition`。
 *
 * **并发连接、确定性合并**：各 server 并行握手（把最坏开销从 Σ20s 压到 20s —— in-process 后这段
 * 等待直接顶在会话建立的关键路径上，不再像旧路径那样躲在子进程 startup 里），但结果严格按输入
 * 顺序合并，所以「跨 server 重名先到先得」的胜负关系与旧实现完全一致（浏览器 server 由
 * `collectBridgeServers` 放在末位，故用户 server 优先）。
 */
export async function createMcpInProcTools(
  servers: BridgeServer[],
  options: McpInProcOptions = {},
): Promise<McpInProcBridge> {
  const opts = resolveOptions(options);
  if (!servers.length) {
    return { tools: [], connected: [], acceptedTools: {}, failed: [], dispose: async () => {} };
  }

  const outcomes = await Promise.all(servers.map((s) => connectServer(s, opts)));

  const tools: ToolDefinition[] = [];
  const connected: string[] = [];
  const acceptedTools: Record<string, string[]> = {};
  const failed: McpBridgeFailure[] = [];
  const clients: McpClient[] = [];
  const claimed = new Set<string>();

  for (const outcome of outcomes) {
    if (outcome.error || !outcome.client) {
      // KTD5：in-process 后没有子进程退出码兜底，这类失败只会表现为「某个能力莫名不见了」。
      // 必须同时 warn + 进 failed[]，绝不静默跳过。
      log.warn("MCP server 接入失败，已跳过", { server: outcome.server.id, error: outcome.error });
      failed.push({ id: outcome.server.id, error: outcome.error ?? "未知错误" });
      continue;
    }
    const client = outcome.client;
    clients.push(client);
    connected.push(outcome.server.id);
    const accepted: string[] = [];
    for (const info of outcome.tools) {
      if (!info || typeof info.name !== "string" || !info.name) continue;
      const name = info.name;
      if (opts.reservedToolNames.has(name)) {
        // 见 PI_RESERVED_TOOL_NAMES：customTools 会静默覆盖 pi 内建工具，宁可少一个工具。
        log.warn("MCP 工具名与 pi 内建工具冲突，已跳过", { server: outcome.server.id, tool: name });
        continue;
      }
      if (claimed.has(name)) {
        // 跨 server 重名：先到先得（与旧实现同），但旧实现是静默 `continue`，这里补一条 warn。
        log.warn("MCP 工具名跨 server 重复，已跳过后到者", { server: outcome.server.id, tool: name });
        continue;
      }
      claimed.add(name);
      tools.push(buildToolDefinition(info, outcome.server, client));
      accepted.push(name);
    }
    acceptedTools[outcome.server.id] = accepted;
    log.info("MCP server 已接入", { server: outcome.server.id, tools: accepted });
  }

  let disposed = false;
  return {
    tools,
    connected,
    acceptedTools,
    failed,
    // 幂等：`stop()` 可能被重复调用（renderer 主动关 + 崩溃清理），重复 kill 无害但重复 log 有噪音。
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const c of clients) {
        try {
          c.close();
        } catch (err) {
          log.warn("MCP 客户端关闭失败", { error: errText(err) });
        }
      }
    },
  };
}

/**
 * 便捷入口：直接从 `McpServerConfig` 列表 + 浏览器 server 建桥。
 *
 * server 收集**完全复用** `pi-mcp-bridge.collectBridgeServers`（stdio env 解析、非法 id 过滤、
 * 浏览器 server 末位并入），本次迁移只换「怎么把工具交给 pi」，收集规则一个字都不改。
 */
export async function createMcpInProcToolsFromConfigs(
  userServers: McpServerConfig[],
  browserServer: McpServerConfig | null,
  options: McpInProcOptions = {},
): Promise<McpInProcBridge> {
  return createMcpInProcTools(collectBridgeServers(userServers, browserServer), options);
}
