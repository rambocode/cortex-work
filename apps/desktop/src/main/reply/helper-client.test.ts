import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NdjsonBuffer,
  parseJsonLine,
  encodeCommand,
  backoffDelayMs,
  shouldDegrade,
  MAX_RESTART_ATTEMPTS,
  ReplyHelperClient,
  type SpawnedProcess,
  type SpawnFn,
  type HelperEvent,
} from "./helper-client";

// ── NDJSON 解析(纯函数)──────────────────────────────────────────────────────

describe("NdjsonBuffer", () => {
  it("单 chunk 内多行完整解析", () => {
    const buf = new NdjsonBuffer();
    const out = buf.push('{"event":"ready"}\n{"event":"draft-gesture"}\n');
    expect(out).toEqual([{ event: "ready" }, { event: "draft-gesture" }]);
    expect(buf.pending()).toBe("");
  });

  it("跨 chunk 半行:先留缓冲,补齐后解析", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"event":"voi')).toEqual([]);
    expect(buf.pending()).toBe('{"event":"voi');
    const out = buf.push('ce-start"}\n');
    expect(out).toEqual([{ event: "voice-start" }]);
    expect(buf.pending()).toBe("");
  });

  it("脏行(非 JSON)丢弃,不影响后续完整行", () => {
    const buf = new NdjsonBuffer();
    const out = buf.push("swift log noise\n{\"event\":\"ready\"}\n");
    expect(out).toEqual([{ event: "ready" }]);
  });

  it("空行忽略", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push("\n\n")).toEqual([]);
  });

  it("数组 / 非对象 JSON 行丢弃", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push("[1,2,3]\n")).toEqual([]);
    expect(buf.push("42\n")).toEqual([]);
  });

  it("未结束的最后半行不 emit,留待下次", () => {
    const buf = new NdjsonBuffer();
    const out = buf.push('{"ok":true}\n{"partial":');
    expect(out).toEqual([{ ok: true }]);
    expect(buf.pending()).toBe('{"partial":');
  });
});

describe("parseJsonLine", () => {
  it("合法对象行", () => {
    expect(parseJsonLine('  {"a":1}  ')).toEqual({ a: 1 });
  });
  it("空 / 非法 / 非对象 → null", () => {
    expect(parseJsonLine("")).toBeNull();
    expect(parseJsonLine("   ")).toBeNull();
    expect(parseJsonLine("not json")).toBeNull();
    expect(parseJsonLine("[1]")).toBeNull();
    expect(parseJsonLine("null")).toBeNull();
  });
});

describe("encodeCommand", () => {
  it("对象 → 一行 JSON + 换行", () => {
    expect(encodeCommand({ cmd: "intercept", on: true })).toBe('{"cmd":"intercept","on":true}\n');
  });
});

// ── 退避序列(纯函数)──────────────────────────────────────────────────────────

describe("backoffDelayMs", () => {
  it("指数增长:500 / 1000 / 2000 / 4000", () => {
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(2)).toBe(1000);
    expect(backoffDelayMs(3)).toBe(2000);
    expect(backoffDelayMs(4)).toBe(4000);
  });
  it("上限钳制 30s", () => {
    expect(backoffDelayMs(20)).toBe(30_000);
  });
  it("attempt<1 → 0", () => {
    expect(backoffDelayMs(0)).toBe(0);
  });
});

describe("shouldDegrade", () => {
  it("恰达上限不降级,超上限降级", () => {
    expect(shouldDegrade(MAX_RESTART_ATTEMPTS)).toBe(false);
    expect(shouldDegrade(MAX_RESTART_ATTEMPTS + 1)).toBe(true);
  });
});

// ── 假子进程工具 ──────────────────────────────────────────────────────────────

/** 可编程的假 SpawnedProcess:测试手动喂 stdout / 触发 exit / error。 */
class FakeProc implements SpawnedProcess {
  stdoutCb: ((c: string) => void) | null = null;
  stderrCb: ((c: string) => void) | null = null;
  exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  errorCb: ((err: Error) => void) | null = null;
  written: string[] = [];
  killed = false;
  killSignal: NodeJS.Signals | undefined;

  stdout = { on: (_ev: "data", cb: (c: Buffer | string) => void) => { this.stdoutCb = cb as (c: string) => void; } };
  stderr = { on: (_ev: "data", cb: (c: Buffer | string) => void) => { this.stderrCb = cb as (c: string) => void; } };
  stdin = { write: (d: string) => { this.written.push(d); }, end: () => {} };

  on(ev: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  on(ev: string, cb: (...a: never[]) => void): void {
    if (ev === "exit") this.exitCb = cb as never;
    if (ev === "error") this.errorCb = cb as never;
  }
  kill(signal?: NodeJS.Signals): void {
    this.killed = true;
    this.killSignal = signal;
  }
  emitStdout(s: string): void {
    this.stdoutCb?.(s);
  }
  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCb?.(code, signal);
  }
  emitError(err: Error): void {
    this.errorCb?.(err);
  }
}

// ── events 长驻:退避重启 / 降级 / 配置重放 ──────────────────────────────────

describe("ReplyHelperClient events", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("崩溃后按退避重启,连续超上限置降级标志并回调", () => {
    const procs: FakeProc[] = [];
    const spawnFn: SpawnFn = () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    };
    const onDegrade = vi.fn();
    const client = new ReplyHelperClient({ binaryPath: "/x/reply-helper", spawnFn, onDegrade });
    client.startEvents();

    // 反复:崩溃 → 定时器到点重启 → 再崩,直到超过 MAX_RESTART_ATTEMPTS。
    for (let i = 0; i < MAX_RESTART_ATTEMPTS + 1; i++) {
      procs[procs.length - 1].emitExit(1, null);
      vi.runOnlyPendingTimers();
    }
    // 第 MAX+1 次崩溃触发降级,不再 spawn 新进程。
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(client.isDegraded()).toBe(true);
    // spawn 次数 = 初次 + MAX 次重启(第 MAX+1 次崩溃降级,不再重启)。
    expect(procs.length).toBe(MAX_RESTART_ATTEMPTS + 1);
  });

  it("ready 事件复位退避计数(偶发崩溃不累积到降级)", () => {
    const procs: FakeProc[] = [];
    const spawnFn: SpawnFn = () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    };
    const onDegrade = vi.fn();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn, onDegrade });
    client.startEvents();

    // 崩溃几次但每次重启后都收到 ready,计数被复位,永不降级。
    for (let i = 0; i < MAX_RESTART_ATTEMPTS + 3; i++) {
      procs[procs.length - 1].emitExit(1, null);
      vi.runOnlyPendingTimers();
      procs[procs.length - 1].emitStdout('{"event":"ready"}\n');
    }
    expect(onDegrade).not.toHaveBeenCalled();
    expect(client.isDegraded()).toBe(false);
  });

  it("tap-unavailable 事件立即降级", () => {
    const p = new FakeProc();
    const onDegrade = vi.fn();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn: () => p, onDegrade });
    client.startEvents();
    p.emitStdout('{"event":"tap-unavailable"}\n');
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(client.isDegraded()).toBe(true);
  });

  it("高层事件转发给 onEvent", () => {
    const p = new FakeProc();
    const events: HelperEvent[] = [];
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: () => p,
      onEvent: (e) => events.push(e),
    });
    client.startEvents();
    p.emitStdout('{"event":"draft-gesture"}\n{"event":"key-event","key":"tab"}\n');
    expect(events).toEqual([{ event: "draft-gesture" }, { event: "key-event", key: "tab" }]);
  });

  it("ready 后重放 config 与 intercept 状态", () => {
    const procs: FakeProc[] = [];
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: () => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
    });
    client.startEvents();
    const first = procs[0];
    first.emitStdout('{"event":"ready"}\n');
    client.sendConfig({ draft: "command", voice: "function" });
    client.setIntercept(true);
    first.written.length = 0;

    // 崩溃 → 重启 → 新进程 ready:应重放 config 与 intercept。
    first.emitExit(1, null);
    vi.runOnlyPendingTimers();
    const second = procs[1];
    second.emitStdout('{"event":"ready"}\n');
    const joined = second.written.join("");
    expect(joined).toContain('"cmd":"config"');
    expect(joined).toContain('"draft":"command"');
    expect(joined).toContain('"cmd":"intercept"');
    expect(joined).toContain('"on":true');
  });

  it("stopEvents 后不再自动重启", () => {
    const procs: FakeProc[] = [];
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: () => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
    });
    client.startEvents();
    client.stopEvents();
    expect(procs[0].killed).toBe(true);
    // 主动停止后触发 exit,不应再 spawn。
    procs[0].emitExit(null, "SIGTERM");
    vi.runOnlyPendingTimers();
    expect(procs.length).toBe(1);
  });
});

// ── one-shot 命令:解析 / 超时 / 无输出 ──────────────────────────────────────

describe("ReplyHelperClient one-shot", () => {
  it("正常退出 → resolve 首行对象", async () => {
    const p = new FakeProc();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn: () => p });
    const promise = client.axCapture();
    p.emitStdout('{"ok":true,"text":"hi","pid":123}\n');
    p.emitExit(0);
    await expect(promise).resolves.toEqual({ ok: true, text: "hi", pid: 123 });
  });

  it("多行输出只取首个对象", async () => {
    const p = new FakeProc();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn: () => p });
    const promise = client.permissions();
    p.emitStdout('{"ok":true,"accessibility":"granted"}\n{"stray":true}\n');
    p.emitExit(0);
    await expect(promise).resolves.toEqual({ ok: true, accessibility: "granted" });
  });

  it("超时 → kill 并 reject", async () => {
    vi.useFakeTimers();
    const p = new FakeProc();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn: () => p });
    const promise = client.runCommand(["ocr"], 1000);
    const assertion = expect(promise).rejects.toThrow(/超时/);
    vi.advanceTimersByTime(1000);
    await assertion;
    expect(p.killed).toBe(true);
    vi.useRealTimers();
  });

  it("退出但无有效输出 → reject", async () => {
    const p = new FakeProc();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn: () => p });
    const promise = client.calendar();
    p.emitExit(0);
    await expect(promise).rejects.toThrow(/无有效输出/);
  });

  it("spawn 抛错 → reject", async () => {
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(client.axCapture()).rejects.toThrow("ENOENT");
  });

  it("进程 error 事件 → reject", async () => {
    const p = new FakeProc();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn: () => p });
    const promise = client.paste("hi");
    p.emitError(new Error("spawn error"));
    await expect(promise).rejects.toThrow("spawn error");
  });
});
