import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NdjsonBuffer,
  parseJsonLine,
  encodeCommand,
  backoffDelayMs,
  shouldDegrade,
  MAX_RESTART_ATTEMPTS,
  STABLE_UPTIME_MS,
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
  stdinEndCalls = 0;
  stdin = { write: (d: string) => { this.written.push(d); }, end: () => { this.stdinEndCalls += 1; } };

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
    const client = new ReplyHelperClient({ binaryPath: "/x/Cortex_Helper", spawnFn, onDegrade });
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

  it("ready 后长时间稳定存活的偶发崩溃复位退避计数,不累积到降级", () => {
    // 注入可控时间源:每轮让进程「稳定存活」超过 STABLE_UPTIME_MS 再崩溃,
    // 崩溃时 uptime >= 阈值 → 复位退避计数,故连续多次偶发崩溃也永不降级。
    let now = 1_000_000; // 非零基准,避开 spawnedAt===0 哨兵
    const procs: FakeProc[] = [];
    const spawnFn: SpawnFn = () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    };
    const onDegrade = vi.fn();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn, onDegrade, nowFn: () => now });
    client.startEvents();

    for (let i = 0; i < MAX_RESTART_ATTEMPTS + 3; i++) {
      const cur = procs[procs.length - 1];
      cur.emitStdout('{"event":"ready"}\n'); // 建起 tap
      now += STABLE_UPTIME_MS + 1; // 稳定存活超过阈值
      cur.emitExit(1, null); // 之后偶发崩溃 → 崩溃时 uptime>=阈值 → 复位退避计数
      vi.runOnlyPendingTimers(); // 触发重启,spawn 新进程(spawnedAt=now)
    }
    expect(onDegrade).not.toHaveBeenCalled();
    expect(client.isDegraded()).toBe(false);
  });

  it("ready→立即崩溃反复循环最终触发降级(短命 ready 不复位退避,不绕过安全网)", () => {
    // 回归防护(KTD7):每轮进程都发过 ready 但随即崩溃、存活远不足 STABLE_UPTIME_MS。
    // 旧实现「ready 无条件复位」会让计数永远清零、恒以最短间隔重启、永不降级;
    // 修复后短命 ready 不复位,计数持续累加,最终越过 MAX_RESTART_ATTEMPTS 触发降级。
    let now = 1_000_000;
    const procs: FakeProc[] = [];
    const spawnFn: SpawnFn = () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    };
    const onDegrade = vi.fn();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn, onDegrade, nowFn: () => now });
    client.startEvents();

    for (let i = 0; i < MAX_RESTART_ATTEMPTS + 1; i++) {
      const cur = procs[procs.length - 1];
      cur.emitStdout('{"event":"ready"}\n'); // 每轮都发过 ready
      now += 10; // 仅存活极短,远不足稳定阈值
      cur.emitExit(1, null);
      vi.runOnlyPendingTimers();
    }
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(client.isDegraded()).toBe(true);
    // 初次 + MAX 次重启后,第 MAX+1 次崩溃降级、不再 spawn。
    expect(procs.length).toBe(MAX_RESTART_ATTEMPTS + 1);
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

  it("高层事件（含听写事件）转发给 onEvent", () => {
    const p = new FakeProc();
    const events: HelperEvent[] = [];
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: () => p,
      onEvent: (e) => events.push(e),
    });
    client.startEvents();
    p.emitStdout('{"event":"draft-gesture"}\n{"event":"dictation-start"}\n{"event":"dictation-end"}\n{"event":"key-event","key":"tab"}\n');
    expect(events).toEqual([
      { event: "draft-gesture" },
      { event: "dictation-start" },
      { event: "dictation-end" },
      { event: "key-event", key: "tab" },
    ]);
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
    client.sendConfig({
      draft: "command",
      voice: "function",
      dictation: { modifiers: ["command", "shift"], keyCode: 2 },
    });
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
    expect(joined).toContain('"dictation":{"modifiers":["command","shift"],"keyCode":2}');
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

  // ── 日历命令（capabilities/calendar 用）──────────────────────────────────

  // 回归锁：reply/controller.ts 的 calendarContext() 逐字段依赖 calendar 子命令的输出，
  // 新增日历命令时绝不能顺手把它参数化。
  it("calendar 仍且只发 [\"calendar\"]（快捷回复路径不受影响）", async () => {
    let gotArgs: string[] = [];
    const p = new FakeProc();
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: (_bin, args) => {
        gotArgs = args;
        return p;
      },
    });
    const promise = client.calendar();
    p.emitStdout('{"ok":true,"busy":[]}\n');
    p.emitExit(0);
    await promise;
    expect(gotArgs).toEqual(["calendar"]);
    // 不传 stdin 的命令完全不碰 proc.stdin。
    expect(p.written).toEqual([]);
    expect(p.stdinEndCalls).toBe(0);
  });

  it("calendarEvents 把时间窗以 epoch 毫秒经 argv 传入", async () => {
    let gotArgs: string[] = [];
    const p = new FakeProc();
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: (_bin, args) => {
        gotArgs = args;
        return p;
      },
    });
    const promise = client.calendarEvents(1786000000000, 1786600000000);
    p.emitStdout('{"ok":true,"events":[]}\n');
    p.emitExit(0);
    await promise;
    expect(gotArgs).toEqual(["calendar-events", "1786000000000", "1786600000000"]);
  });

  it("screenshot 可选地把目标 pid 传给 helper，并原样返回 PNG base64 响应", async () => {
    let gotArgs: string[] = [];
    const p = new FakeProc();
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: (_bin, args) => {
        gotArgs = args;
        return p;
      },
    });
    const promise = client.screenshot(4321);
    p.emitStdout('{"ok":true,"pid":4321,"pngBase64":"cG5n"}\n');
    p.emitExit(0);

    await expect(promise).resolves.toEqual({ ok: true, pid: 4321, pngBase64: "cG5n" });
    expect(gotArgs).toEqual(["screenshot", "4321"]);
  });

  // 载荷走 stdin 而非 argv：事件标题/备注是私密内容，argv 对同机任意进程经 ps 可见。
  it("calendarCreate 的载荷经 stdin 而非 argv，且 end 恰好调一次", async () => {
    let gotArgs: string[] = [];
    const p = new FakeProc();
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: (_bin, args) => {
        gotArgs = args;
        return p;
      },
    });
    const promise = client.calendarCreate({ title: "私密会议", startMs: 1, endMs: 2 });
    p.emitStdout('{"ok":true,"id":"evt-1"}\n');
    p.emitExit(0);
    await promise;

    expect(gotArgs).toEqual(["calendar-create"]);
    expect(gotArgs.join(" ")).not.toContain("私密会议");
    expect(p.written).toHaveLength(1);
    expect(JSON.parse(p.written[0])).toEqual({ title: "私密会议", startMs: 1, endMs: 2 });
    expect(p.written[0].endsWith("\n")).toBe(true); // helper 侧 readLine 需要换行收尾
    expect(p.stdinEndCalls).toBe(1);
  });

  // 听写正文与日历标题同属用户私密内容；绝不能把它放进 argv 让同机 ps 读取。
  it("paste 的正文经 stdin 而非 argv，且仍以换行结束", async () => {
    let gotArgs: string[] = [];
    const p = new FakeProc();
    const client = new ReplyHelperClient({
      binaryPath: "/x",
      spawnFn: (_bin, args) => {
        gotArgs = args;
        return p;
      },
    });
    const promise = client.paste("只写入当前光标");
    p.emitStdout('{"ok":true}\n');
    p.emitExit(0);
    await promise;

    expect(gotArgs).toEqual(["paste"]);
    expect(gotArgs.join(" ")).not.toContain("只写入当前光标");
    expect(p.written).toEqual(["只写入当前光标\n"]);
    expect(p.stdinEndCalls).toBe(1);
  });

  it("进程 error 事件 → reject", async () => {
    const p = new FakeProc();
    const client = new ReplyHelperClient({ binaryPath: "/x", spawnFn: () => p });
    const promise = client.paste("hi");
    p.emitError(new Error("spawn error"));
    await expect(promise).rejects.toThrow("spawn error");
  });
});
