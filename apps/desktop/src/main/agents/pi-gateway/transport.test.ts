// 承载层单测。**不真起进程**：`electron` 的 `utilityProcess` 用替身，只验证那几条实测约束
// 是否真的写在了 fork 参数里——它们各自对应一个「worker 起不来却没有任何报错」的坑（KTD2/KTD3）。

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  // 手写极简事件源：`vi.hoisted` 的工厂跑在所有 import 之前，此处不能引 node:events。
  class Tiny {
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
  }
  class FakeStream extends Tiny {
    encoding?: string;
    resumed = 0;
    setEncoding(enc: string): void {
      this.encoding = enc;
    }
    resume(): void {
      this.resumed += 1;
    }
  }
  class FakeChild extends Tiny {
    pid: number | undefined = 4242;
    readonly stdout = new FakeStream();
    readonly stderr = new FakeStream();
    readonly posted: unknown[] = [];
    killCalls = 0;
    postMessage(msg: unknown): void {
      this.posted.push(msg);
    }
    kill(): void {
      this.killCalls += 1;
    }
  }
  return {
    FakeChild,
    state: {
      ready: true,
      isPackaged: false,
      appPath: "/repo/apps/desktop",
      forks: [] as Array<{ entry: string; args: string[]; options: Record<string, unknown> }>,
      children: [] as InstanceType<typeof FakeChild>[],
      exists: new Set<string>(),
      signals: [] as Array<[number, string]>,
    },
  };
});

vi.mock("electron", () => ({
  app: {
    isReady: () => hoisted.state.ready,
    get isPackaged() {
      return hoisted.state.isPackaged;
    },
    getAppPath: () => hoisted.state.appPath,
  },
  utilityProcess: {
    fork: (entry: string, args: string[], options: Record<string, unknown>) => {
      const child = new hoisted.FakeChild();
      hoisted.state.forks.push({ entry, args, options });
      hoisted.state.children.push(child);
      return child;
    },
  },
}));
vi.mock("../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() }),
  isDevEnv: () => true,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (p: string) => hoisted.state.exists.has(p) };
});

import { activePiHostWorkerCount, forkPiHostTransport, killAllPiHostWorkers } from "./transport";

const ENTRY = "/repo/apps/desktop/out/worker/pi-host.js";

beforeEach(() => {
  hoisted.state.ready = true;
  hoisted.state.isPackaged = false;
  hoisted.state.forks.length = 0;
  hoisted.state.children.length = 0;
  hoisted.state.signals.length = 0;
  hoisted.state.exists.clear();
  hoisted.state.exists.add(ENTRY);
  killAllPiHostWorkers();
});

describe("forkPiHostTransport", () => {
  it("KTD2：stdin 必须是 ignore，stdout/stderr 走 pipe", () => {
    forkPiHostTransport();
    expect(hoisted.state.forks[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("stdout 立刻 resume（不消费的话管道写满会把 worker 卡死）", () => {
    forkPiHostTransport();
    expect(hoisted.state.children[0]?.stdout.resumed).toBe(1);
  });

  it("stderr 进尾环，只留最后 2KB（worker ESM 加载失败的唯一线索来源）", () => {
    const transport = forkPiHostTransport();
    const child = hoisted.state.children[0]!;
    expect(child.stderr.encoding).toBe("utf8");
    child.stderr.emit("data", "x".repeat(3000));
    child.stderr.emit("data", "TAIL");

    let tail: string | undefined;
    transport.onExit((_code, stderrTail) => {
      tail = stderrTail;
    });
    child.emit("exit", 1);
    expect(tail).toHaveLength(2000);
    expect(tail?.endsWith("TAIL")).toBe(true);
  });

  it("入口按 entry-resolver 解析；缺失时响亮失败并列出候选", () => {
    forkPiHostTransport();
    expect(hoisted.state.forks[0]?.entry).toBe(ENTRY);

    hoisted.state.exists.clear();
    expect(() => forkPiHostTransport()).toThrow(/找不到 pi-host worker 入口/);
  });

  it("必须等 app ready（早于 ready 调用 utilityProcess 会直接抛）", () => {
    hoisted.state.ready = false;
    expect(() => forkPiHostTransport()).toThrow(/app ready/);
  });

  it("env 与 process.env 合并（fork 的 env 是整体替换语义，只传增量会丢掉 PATH）", () => {
    forkPiHostTransport({ env: { CORTEX_PI_SECRET_1: "v" } });
    const env = hoisted.state.forks[0]?.options.env as Record<string, string>;
    expect(env.CORTEX_PI_SECRET_1).toBe("v");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("不传 env 时完全不下发该项（继承主进程环境）", () => {
    forkPiHostTransport({ cwd: "/proj" });
    expect(hoisted.state.forks[0]?.options).not.toHaveProperty("env");
    expect(hoisted.state.forks[0]?.options.cwd).toBe("/proj");
  });

  it("writeLine 走 postMessage（协议不经 stdio）", () => {
    const transport = forkPiHostTransport();
    transport.writeLine('{"kind":"shutdown"}');
    expect(hoisted.state.children[0]?.posted).toEqual(['{"kind":"shutdown"}']);
  });

  it("onLine 收到非字符串消息时序列化后交给上层（由上层丢弃并留痕）", () => {
    const transport = forkPiHostTransport();
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    hoisted.state.children[0]?.emit("message", '{"kind":"log"}');
    hoisted.state.children[0]?.emit("message", { kind: "log" });
    expect(lines).toEqual(['{"kind":"log"}', '{"kind":"log"}']);
  });

  it("两段式 kill：优雅走 child.kill()，强杀走 SIGKILL", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const transport = forkPiHostTransport();
    transport.kill();
    expect(hoisted.state.children[0]?.killCalls).toBe(1);

    transport.kill(true);
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGKILL");
    // 强杀不再走优雅路径
    expect(hoisted.state.children[0]?.killCalls).toBe(1);
    killSpy.mockRestore();
  });

  it("kill 抛错被吞掉（进程已退出是正常竞态）", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const transport = forkPiHostTransport();
    expect(() => transport.kill(true)).not.toThrow();
    killSpy.mockRestore();
  });
});

describe("孤儿 worker 清理", () => {
  it("fork 后进注册表，退出后自动摘除", () => {
    const transport = forkPiHostTransport();
    expect(activePiHostWorkerCount()).toBe(1);
    // onExit 订阅是摘除的触发点：客户端一定会订阅，这里显式模拟。
    transport.onExit(() => {});
    hoisted.state.children[0]?.emit("exit", 0);
    expect(activePiHostWorkerCount()).toBe(0);
  });

  it("killAllPiHostWorkers 一把杀干净，单个失败不影响其余", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw new Error("ESRCH");
    });
    forkPiHostTransport();
    forkPiHostTransport();
    expect(killAllPiHostWorkers()).toBe(2);
    expect(activePiHostWorkerCount()).toBe(0);
    killSpy.mockRestore();
  });
});
