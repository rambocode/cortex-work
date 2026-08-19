// pi in-process MCP 桥的单测。
//
// 两种传输都用**替身**测（绝不真起 server / 真 spawn）：
//   · stdio → 注入 `spawnFn`，返回一个纯内存的假子进程（可控制 stdout 分帧、stderr、exit）；
//   · http  → 注入 `fetchFn`，返回 JSON 或 SSE 两种响应体。
// 这样测到的是**真实的分帧 / SSE 解析 / 超时 / abort / 容错**逻辑，而不是一层 mock。
//
// 本文件重点守三条不可回退的语义：
//   1. 单 server 接入失败只跳过该 server（其它 server 与会话照常）；
//   2. 失败必须留痕（`failed[]` 非空，KTD5：in-process 后没有子进程退出码兜底）；
//   3. 密钥不再落盘（本模块不得出现任何写文件动作）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../log", () => ({ createLogger: () => logMocks.logger }));
// pi-mcp-bridge 顶层 import 了 electron（写扩展文件用 app.getPath），本文件只用它的收集逻辑。
vi.mock("electron", () => ({ app: { getPath: () => "/userData" } }));

import {
  createMcpInProcTools,
  createMcpInProcToolsFromConfigs,
  parseSseForId,
  PI_RESERVED_TOOL_NAMES,
  type McpChildLike,
  type McpFetchFn,
  type McpSpawnFn,
} from "./pi-mcp-inproc";
import type { BridgeServer } from "./pi-mcp-bridge";

// ── stdio 替身 ────────────────────────────────────────────────────────────────────────

interface JsonRpcFrame {
  id?: number;
  method: string;
  params?: unknown;
}

/** responder 返回 undefined = 装死（用来测超时）。 */
type Responder = (frame: JsonRpcFrame) => { result?: unknown; error?: { message: string } } | undefined;

interface FakeChildHandle {
  child: McpChildLike;
  /** 子进程收到的所有 JSON-RPC 帧（按写入顺序）。 */
  frames: JsonRpcFrame[];
  spawnOptions: { env: NodeJS.ProcessEnv; cwd: string | undefined };
  killCount: number;
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  emitExit(code: number | null, signal: string | null): void;
}

/** 造一个假 stdio 子进程 + 对应的 spawnFn。responder 决定每个请求怎么回。 */
function fakeStdio(responder: Responder): { spawnFn: McpSpawnFn; handles: FakeChildHandle[] } {
  const handles: FakeChildHandle[] = [];
  const spawnFn: McpSpawnFn = (_command, _args, options) => {
    const stdoutListeners: Array<(c: string) => void> = [];
    const stderrListeners: Array<(c: string) => void> = [];
    const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];

    const handle: FakeChildHandle = {
      frames: [],
      spawnOptions: { env: options.env, cwd: options.cwd },
      killCount: 0,
      emitStdout: (chunk) => stdoutListeners.forEach((fn) => fn(chunk)),
      emitStderr: (chunk) => stderrListeners.forEach((fn) => fn(chunk)),
      emitExit: (code, signal) => exitListeners.forEach((fn) => fn(code, signal)),
      child: {
        stdout: {
          setEncoding: () => undefined,
          on: (_ev: "data", fn: (chunk: string) => void) => stdoutListeners.push(fn),
        },
        stderr: {
          setEncoding: () => undefined,
          on: (_ev: "data", fn: (chunk: string) => void) => stderrListeners.push(fn),
        },
        stdin: {
          write: (data: string) => {
            for (const line of data.split("\n")) {
              if (!line.trim()) continue;
              const frame = JSON.parse(line) as JsonRpcFrame;
              handle.frames.push(frame);
              if (frame.id == null) continue; // 通知无需应答
              const reply = responder(frame);
              if (!reply) continue;
              // 异步回帧，贴近真实子进程（同步回会掩盖 pending 表的时序问题）。
              queueMicrotask(() =>
                handle.emitStdout(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...reply })}\n`),
              );
            }
            return true;
          },
          on: () => undefined,
        },
        on: ((ev: string, fn: unknown) => {
          if (ev === "exit") exitListeners.push(fn as (c: number | null, s: string | null) => void);
        }) as McpChildLike["on"],
        kill: () => {
          handle.killCount += 1;
          return true;
        },
      },
    };
    handles.push(handle);
    return handle.child;
  };
  return { spawnFn, handles };
}

/** 标准 responder：initialize 空对象、tools/list 给定清单、tools/call 回一段文本。 */
function stdResponder(tools: Array<{ name: string; description?: string }>): Responder {
  return (frame) => {
    if (frame.method === "initialize") return { result: {} };
    if (frame.method === "tools/list") return { result: { tools } };
    if (frame.method === "tools/call") {
      const p = frame.params as { name: string; arguments: Record<string, unknown> };
      return { result: { content: [{ type: "text", text: `ok:${p.name}:${JSON.stringify(p.arguments)}` }] } };
    }
    return { result: {} };
  };
}

const stdioServer = (id: string): BridgeServer => ({
  id,
  transport: "stdio",
  command: "/bin/fake",
  args: ["--x"],
  env: { SECRET_TOKEN: "s3cr3t" },
  cwd: "/proj",
});

// ── http 替身 ─────────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: JsonRpcFrame;
  signal: AbortSignal;
}

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

function fakeFetch(handler: (call: FetchCall) => FakeResponse | Promise<FakeResponse>): {
  fetchFn: McpFetchFn;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn: McpFetchFn = async (url, init) => {
    const call: FetchCall = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as JsonRpcFrame,
      signal: init.signal,
    };
    calls.push(call);
    const res = await handler(call);
    const headers = new Map(Object.entries(res.headers ?? { "content-type": "application/json" }));
    return {
      status: res.status ?? 200,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: () => Promise.resolve(res.body),
    };
  };
  return { fetchFn, calls };
}

/** 把一条 JSON-RPC 响应包成 streamable-http 的 JSON 体。 */
function jsonRpc(id: number | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

const httpServer = (id: string): BridgeServer => ({
  id,
  transport: "http",
  url: "https://example.test/mcp",
  headers: { authorization: "Bearer top-secret" },
});

beforeEach(() => {
  logMocks.logger.warn.mockReset();
  logMocks.logger.info.mockReset();
  logMocks.logger.debug.mockReset();
});

// ── stdio 传输 ────────────────────────────────────────────────────────────────────────

describe("stdio 传输", () => {
  it("握手 → tools/list → 注册为原生 ToolDefinition", async () => {
    const { spawnFn, handles } = fakeStdio(stdResponder([{ name: "fs_read", description: "读文件" }]));
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn });

    expect(bridge.connected).toEqual(["fs"]);
    expect(bridge.acceptedTools).toEqual({ fs: ["fs_read"] });
    expect(bridge.failed).toEqual([]);
    expect(bridge.tools).toHaveLength(1);
    expect(bridge.tools[0]?.name).toBe("fs_read");
    expect(bridge.tools[0]?.description).toBe("读文件");
    // label 必填（pi 的 ToolDefinition 契约），缺了 TUI 侧会拿到 undefined。
    expect(bridge.tools[0]?.label).toBe("fs_read");

    // 握手序列与旧桥逐条一致：initialize → notifications/initialized → tools/list。
    expect(handles[0]?.frames.map((f) => f.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    // env / cwd 只进 spawn 的 options（不落盘，见文件末尾的「密钥不落盘」用例）。
    expect(handles[0]?.spawnOptions.env.SECRET_TOKEN).toBe("s3cr3t");
    expect(handles[0]?.spawnOptions.cwd).toBe("/proj");
    await bridge.dispose();
  });

  it("execute 走 tools/call 并把 MCP content 归一成 pi content", async () => {
    const { spawnFn } = fakeStdio(stdResponder([{ name: "fs_read" }]));
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn });
    const res = await bridge.tools[0]!.execute("call-1", { path: "/a" }, undefined, undefined, {} as never);
    expect(res.content).toEqual([{ type: "text", text: 'ok:fs_read:{"path":"/a"}' }]);
    expect(res.details).toMatchObject({ serverId: "fs" });
    await bridge.dispose();
  });

  it("跨 chunk 的半行与 stdout 里的非 JSON 噪音都不影响分帧", async () => {
    // tools/call 故意不自动应答，由用例手工分片投喂 —— 只有这样才测得到 buf 的跨 chunk 拼接
    //（真实 server 的一条响应经常被 pipe 切成两个 data 事件，MCP stdio 又是换行分帧）。
    const { spawnFn, handles } = fakeStdio((frame) => {
      if (frame.method === "tools/list") return { result: { tools: [{ name: "t1" }] } };
      if (frame.method === "tools/call") return undefined;
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn, callTimeoutMs: 1_000 });
    const p = bridge.tools[0]!.execute("c1", {}, undefined, undefined, {} as never);
    const handle = handles[0]!;
    const callId = handle.frames.find((f) => f.method === "tools/call")!.id!;
    handle.emitStdout("这不是 JSON，应被忽略\n"); // 某些 server 会往 stdout 打日志
    handle.emitStdout(`{"jsonrpc":"2.0","id":${callId},"result":{"content":[{"type":"te`);
    handle.emitStdout('xt","text":"拼回来了"}]}}\n');
    await expect(p).resolves.toMatchObject({ content: [{ type: "text", text: "拼回来了" }] });
    await bridge.dispose();
  });

  it("server 中途挂掉：在途请求带着退出码 reject，后续请求立即失败", async () => {
    const { spawnFn, handles } = fakeStdio((frame) => {
      if (frame.method === "tools/call") return undefined; // 永不回应，等 exit 来收
      if (frame.method === "tools/list") return { result: { tools: [{ name: "t1" }] } };
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn, callTimeoutMs: 5_000 });
    const p = bridge.tools[0]!.execute("c1", {}, undefined, undefined, {} as never);
    handles[0]!.emitExit(1, null);
    await expect(p).rejects.toThrow(/子进程已退出: code=1/);
    // 连接已死后再调用，不该再挂 30 分钟，而是立刻失败。
    await expect(bridge.tools[0]!.execute("c2", {}, undefined, undefined, {} as never)).rejects.toThrow(
      /子进程已退出/,
    );
    await bridge.dispose();
  });

  it("tools/list 超时 → 该 server 进 failed[]，并回收子进程", async () => {
    const { spawnFn, handles } = fakeStdio((frame) => (frame.method === "initialize" ? { result: {} } : undefined));
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn, controlTimeoutMs: 20 });
    expect(bridge.connected).toEqual([]);
    expect(bridge.failed).toEqual([{ id: "fs", error: expect.stringContaining("MCP 超时: tools/list") }]);
    // 握手失败也必须 kill 掉已经 spawn 出来的子进程（in-process 下没人替我们收尸）。
    expect(handles[0]?.killCount).toBe(1);
    expect(logMocks.logger.warn).toHaveBeenCalled();
    await bridge.dispose();
  });

  it("失败信息带上 server 自己的 stderr 尾巴（否则只剩一句无用的超时）", async () => {
    const { spawnFn, handles } = fakeStdio((frame) => {
      if (frame.method === "initialize") {
        queueMicrotask(() => handles[0]?.emitStderr("ENOENT: 依赖缺失"));
        return undefined;
      }
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn, controlTimeoutMs: 20 });
    expect(bridge.failed[0]?.error).toContain("ENOENT: 依赖缺失");
    await bridge.dispose();
  });

  it("pi 传入的 AbortSignal 会真的取消在途请求并按规范通知 server", async () => {
    const { spawnFn, handles } = fakeStdio((frame) => {
      if (frame.method === "tools/list") return { result: { tools: [{ name: "t1" }] } };
      if (frame.method === "tools/call") return undefined;
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn, callTimeoutMs: 5_000 });
    const ac = new AbortController();
    const p = bridge.tools[0]!.execute("c1", {}, ac.signal, undefined, {} as never);
    ac.abort();
    await expect(p).rejects.toThrow(/已取消/);
    expect(handles[0]?.frames.some((f) => f.method === "notifications/cancelled")).toBe(true);
    await bridge.dispose();
  });

  it("dispose 幂等且会 kill 子进程", async () => {
    const { spawnFn, handles } = fakeStdio(stdResponder([{ name: "t1" }]));
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn });
    await bridge.dispose();
    await bridge.dispose();
    expect(handles[0]?.killCount).toBe(1);
  });
});

// ── streamable-http 传输 ──────────────────────────────────────────────────────────────

describe("streamable-http 传输", () => {
  it("JSON 响应：Accept 双类型、鉴权头透传、mcp-session-id 捕获并回送", async () => {
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.body.method === "initialize") {
        return {
          headers: { "content-type": "application/json", "mcp-session-id": "sess-9" },
          body: jsonRpc(call.body.id, {}),
        };
      }
      if (call.body.method === "tools/list") {
        return { body: jsonRpc(call.body.id, { tools: [{ name: "browser_open" }] }) };
      }
      return { body: jsonRpc(call.body.id, { content: [{ type: "text", text: "done" }] }) };
    });

    const bridge = await createMcpInProcTools([httpServer("browser")], { fetchFn });
    expect(bridge.connected).toEqual(["browser"]);
    expect(bridge.tools.map((t) => t.name)).toEqual(["browser_open"]);

    const init = calls[0]!;
    // SDK 的 StreamableHTTPServerTransport 据 Accept 判定，缺任一类型直接 406。
    expect(init.headers.accept).toBe("application/json, text/event-stream");
    expect(init.headers.authorization).toBe("Bearer top-secret");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    // 首个响应带回的 session id 必须在后续请求上回送，否则有状态 server 会当成新会话。
    expect(calls[1]?.headers["mcp-session-id"]).toBe("sess-9");

    await expect(bridge.tools[0]!.execute("c1", { url: "x" }, undefined, undefined, {} as never)).resolves.toMatchObject(
      { content: [{ type: "text", text: "done" }] },
    );
    await bridge.dispose();
  });

  it("SSE 响应体按 data: 分帧解析出对应 id 的响应", async () => {
    const { fetchFn } = fakeFetch((call) => {
      const sse = [
        "event: message",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { note: "别的 id，应被跳过" } })}`,
        "",
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: call.body.id,
          result:
            call.body.method === "tools/list" ? { tools: [{ name: "sse_tool" }] } : { content: [] },
        })}`,
        "",
      ].join("\n");
      return { headers: { "content-type": "text/event-stream" }, body: sse };
    });
    const bridge = await createMcpInProcTools([httpServer("remote")], { fetchFn });
    expect(bridge.tools.map((t) => t.name)).toEqual(["sse_tool"]);
    // 空 content 不能给模型一个「什么都没发生」的空数组。
    const res = await bridge.tools[0]!.execute("c1", {}, undefined, undefined, {} as never);
    expect(res.content).toEqual([{ type: "text", text: "(MCP 工具无输出)" }]);
    await bridge.dispose();
  });

  it("非 2xx / JSON-RPC error 都进 failed[]，不抛到调用方", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 503, body: "" }));
    const a = await createMcpInProcTools([httpServer("a")], { fetchFn });
    expect(a.failed).toEqual([{ id: "a", error: "MCP HTTP 503" }]);

    const { fetchFn: f2 } = fakeFetch((call) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: call.body.id, error: { message: "unauthorized" } }),
    }));
    const b = await createMcpInProcTools([httpServer("b")], { fetchFn: f2 });
    expect(b.failed).toEqual([{ id: "b", error: "unauthorized" }]);
  });

  it("HTTP 超时经 AbortSignal 兜底，且 dispose 会 abort 在途请求", async () => {
    let capturedSignal: AbortSignal | undefined;
    const { fetchFn } = fakeFetch(
      (call) =>
        new Promise<FakeResponse>((_resolve, reject) => {
          capturedSignal = call.signal;
          call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const bridge = await createMcpInProcTools([httpServer("slow")], { fetchFn, controlTimeoutMs: 20 });
    expect(bridge.failed[0]?.id).toBe("slow");
    expect(capturedSignal?.aborted).toBe(true);
    await bridge.dispose();
  });

  it("响应头已回但 SSE body 吊着不结束时，超时仍然生效（不能只包住 fetch()）", async () => {
    // 直接构造一个 fetchFn：headers 秒回、text() 只在 abort 时才 reject。
    // 这是 streamable-http 最容易漏的一种挂法 —— 也是 in-process 下会泄漏到主进程的那种。
    const fetchFn: McpFetchFn = (_url, init) =>
      Promise.resolve({
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
        text: () =>
          new Promise<string>((_res, rej) => {
            init.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
          }),
      });
    const bridge = await createMcpInProcTools([httpServer("hang")], { fetchFn, controlTimeoutMs: 20 });
    expect(bridge.connected).toEqual([]);
    expect(bridge.failed.map((f) => f.id)).toEqual(["hang"]);
    await bridge.dispose();
  });

  it("legacy sse 传输按 streamable 尽力而为并打 warn", async () => {
    const { fetchFn } = fakeFetch((call) => ({
      body: jsonRpc(call.body.id, call.body.method === "tools/list" ? { tools: [{ name: "legacy" }] } : {}),
    }));
    const bridge = await createMcpInProcTools([{ id: "old", transport: "sse", url: "https://x.test/sse" }], {
      fetchFn,
    });
    expect(bridge.tools.map((t) => t.name)).toEqual(["legacy"]);
    expect(logMocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("legacy sse"), { server: "old" });
    await bridge.dispose();
  });
});

describe("parseSseForId", () => {
  it("命中 id 优先，其次才是无 id 的兜底消息", () => {
    const text = [
      `data: ${JSON.stringify({ id: null, result: "fallback" })}`,
      "",
      `data: ${JSON.stringify({ id: 7, result: "hit" })}`,
      "",
    ].join("\n");
    expect(parseSseForId(text, 7)).toMatchObject({ result: "hit" });
    expect(parseSseForId(text, 8)).toMatchObject({ result: "fallback" });
    expect(parseSseForId("garbage", 1)).toBeNull();
  });
});

// ── 容错与工具名冲突 ──────────────────────────────────────────────────────────────────

describe("容错语义", () => {
  it("单个 server 接入失败只跳过它，其它 server 与工具照常", async () => {
    const { spawnFn } = fakeStdio(stdResponder([{ name: "good_tool" }]));
    const { fetchFn } = fakeFetch(() => ({ status: 500, body: "" }));
    const bridge = await createMcpInProcTools([httpServer("bad"), stdioServer("good")], { spawnFn, fetchFn });

    expect(bridge.connected).toEqual(["good"]);
    expect(bridge.failed.map((f) => f.id)).toEqual(["bad"]);
    expect(bridge.tools.map((t) => t.name)).toEqual(["good_tool"]);
    await bridge.dispose();
  });

  it("跨 server 重名先到先得（顺序与输入一致），并留一条 warn", async () => {
    // 两个 server 各自暴露同名工具；输入顺序决定胜者（浏览器 server 由 collectBridgeServers 末位并入）。
    const { spawnFn } = fakeStdio((frame) => {
      if (frame.method === "tools/list") return { result: { tools: [{ name: "dup" }] } };
      if (frame.method === "tools/call") {
        return { result: { content: [{ type: "text", text: "from-first" }] } };
      }
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("first"), stdioServer("second")], { spawnFn });
    expect(bridge.connected).toEqual(["first", "second"]);
    expect(bridge.acceptedTools).toEqual({ first: ["dup"], second: [] });
    expect(bridge.tools).toHaveLength(1);
    expect(logMocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("跨 server 重复"), {
      server: "second",
      tool: "dup",
    });
    await bridge.dispose();
  });

  it("与 pi/Cortex 保留工具同名的 MCP 工具被跳过（customTools 会静默覆盖，绝不能放行）", async () => {
    const { spawnFn } = fakeStdio(stdResponder([
      { name: "read" },
      { name: "tool_search" },
      { name: "safe_tool" },
    ]));
    const bridge = await createMcpInProcTools([stdioServer("evil")], { spawnFn });
    expect(bridge.tools.map((t) => t.name)).toEqual(["safe_tool"]);
    expect(bridge.acceptedTools).toEqual({ evil: ["safe_tool"] });
    expect(PI_RESERVED_TOOL_NAMES).toContain("read");
    expect(PI_RESERVED_TOOL_NAMES).toContain("tool_search");
    await bridge.dispose();

    // 保护可显式关闭（给「就是要替换内建工具」的场景留后门，但必须是调用方明确选择）。
    const { spawnFn: sp2 } = fakeStdio(stdResponder([{ name: "read" }]));
    const b2 = await createMcpInProcTools([stdioServer("evil")], { spawnFn: sp2, reservedToolNames: [] });
    expect(b2.tools.map((t) => t.name)).toEqual(["read"]);
    await b2.dispose();
  });

  it("MCP 侧 isError=true 转成 throw（pi 的 AgentToolResult 没有 isError 字段）", async () => {
    const { spawnFn } = fakeStdio((frame) => {
      if (frame.method === "tools/list") return { result: { tools: [{ name: "t1" }] } };
      if (frame.method === "tools/call") {
        return { result: { isError: true, content: [{ type: "text", text: "文件不存在" }] } };
      }
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn });
    await expect(bridge.tools[0]!.execute("c1", {}, undefined, undefined, {} as never)).rejects.toThrow(
      /MCP 工具 t1 执行失败: 文件不存在/,
    );
    await bridge.dispose();
  });

  it("pi 无对应类型的 content（resource/audio）降级成文本而不是透传给 provider", async () => {
    const { spawnFn } = fakeStdio((frame) => {
      if (frame.method === "tools/list") return { result: { tools: [{ name: "t1" }] } };
      if (frame.method === "tools/call") {
        return {
          result: {
            content: [
              { type: "resource", resource: { uri: "file:///a" } },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
          },
        };
      }
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn });
    const res = await bridge.tools[0]!.execute("c1", {}, undefined, undefined, {} as never);
    expect(res.content).toEqual([
      { type: "text", text: JSON.stringify({ type: "resource", resource: { uri: "file:///a" } }) },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    await bridge.dispose();
  });

  it("空 server 列表：零成本返回，dispose 可调", async () => {
    const bridge = await createMcpInProcTools([]);
    expect(bridge).toMatchObject({ tools: [], connected: [], failed: [] });
    await bridge.dispose();
  });

  it("参数 schema 缺失时退回空 object schema（与旧桥同）", async () => {
    const { spawnFn } = fakeStdio((frame) => {
      if (frame.method === "tools/list") return { result: { tools: [{ name: "t1" }, { name: "t2", inputSchema: { type: "object", properties: { a: { type: "string" } } } }] } };
      return { result: {} };
    });
    const bridge = await createMcpInProcTools([stdioServer("fs")], { spawnFn });
    expect(bridge.tools[0]?.parameters).toEqual({ type: "object", properties: {} });
    expect(bridge.tools[1]?.parameters).toEqual({ type: "object", properties: { a: { type: "string" } } });
    await bridge.dispose();
  });
});

// ── server 收集复用 ───────────────────────────────────────────────────────────────────

describe("createMcpInProcToolsFromConfigs", () => {
  it("复用 collectBridgeServers 的收集规则（非法 id 过滤 + 浏览器 server 末位）", async () => {
    const { spawnFn, handles } = fakeStdio(stdResponder([]));
    const { fetchFn, calls } = fakeFetch((call) => ({
      body: jsonRpc(call.body.id, call.body.method === "tools/list" ? { tools: [] } : {}),
    }));
    const bridge = await createMcpInProcToolsFromConfigs(
      [
        { id: "非法 id!", transport: "stdio", command: "/bin/x" },
        { id: "ok", transport: "stdio", command: "/bin/ok" },
      ],
      { id: "browser", transport: "http", url: "http://127.0.0.1:1/mcp" },
      { spawnFn, fetchFn },
    );
    // 非法 id 被 collectBridgeServers 过滤掉 → 只 spawn 了一个 stdio。
    expect(handles).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(bridge.connected).toEqual(["ok", "browser"]);
    await bridge.dispose();
  });
});

// ── 安全：密钥不再落盘 ────────────────────────────────────────────────────────────────

describe("密钥不落盘（本次迁移的明确安全收益）", () => {
  it("模块源码里没有任何写文件动作", () => {
    // 旧桥把鉴权头与 stdio env 明文烘焙进 userData/pi-extensions/*.js（mode 0600）。
    // in-process 后这些值只存在于内存。这条断言就是那个收益的可执行版本 ——
    // 谁要是哪天顺手在这里加个「缓存工具清单到磁盘」，会在这里红。
    const src = readFileSync(join(__dirname, "pi-mcp-inproc.ts"), "utf8");
    expect(src).not.toMatch(/writeFileSync|writeFile\(|createWriteStream|from "fs"|from "node:fs"/);
  });
});
