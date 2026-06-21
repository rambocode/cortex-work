import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 捕获 app.on 注册的事件;process.on 在用例里直接 spy(避免污染真实进程监听器)。
const h = vi.hoisted(() => ({
  appEvents: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { on: (event: string, fn: (...args: unknown[]) => unknown) => h.appEvents.set(event, fn) },
}));

import { installGlobalCrashGuards, __resetCrashGuardsForTests } from "./crash-guards";

describe("installGlobalCrashGuards", () => {
  // 收集本函数向 process 注册的 (事件, 处理器),用 spy 拦截以免真给测试进程挂监听器。
  const procListeners: Array<[string, (...args: unknown[]) => unknown]> = [];
  let onSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetCrashGuardsForTests();
    h.appEvents.clear();
    procListeners.length = 0;
    onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, fn: (...args: unknown[]) => unknown) => {
      procListeners.push([event, fn]);
      return process;
    }) as never);
  });

  afterEach(() => {
    onSpy.mockRestore();
  });

  const procEvents = (): string[] => procListeners.map(([e]) => e);

  it("注册 process 与 app 两类崩溃监听", () => {
    installGlobalCrashGuards();
    expect(procEvents()).toContain("uncaughtException");
    expect(procEvents()).toContain("unhandledRejection");
    expect(h.appEvents.has("render-process-gone")).toBe(true);
    expect(h.appEvents.has("child-process-gone")).toBe(true);
  });

  it("幂等:重复安装不会重复注册监听器", () => {
    installGlobalCrashGuards();
    installGlobalCrashGuards();
    expect(procEvents().filter((e) => e === "uncaughtException")).toHaveLength(1);
    expect(procEvents().filter((e) => e === "unhandledRejection")).toHaveLength(1);
  });

  it("uncaughtException 处理器只记日志、不退出进程", () => {
    const logger = { error: vi.fn() };
    installGlobalCrashGuards(logger);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as never);
    const handler = procListeners.find(([e]) => e === "uncaughtException")![1];

    expect(() => handler(new Error("boom"), "uncaughtException")).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("unhandledRejection 处理器记录拒绝原因、不抛出", () => {
    const logger = { error: vi.fn() };
    installGlobalCrashGuards(logger);
    const handler = procListeners.find(([e]) => e === "unhandledRejection")![1];

    expect(() => handler(new Error("rej"))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith("[main] unhandledRejection", expect.anything());
  });

  it("render-process-gone 处理器记录崩溃详情", () => {
    const logger = { error: vi.fn() };
    installGlobalCrashGuards(logger);
    const handler = h.appEvents.get("render-process-gone")!;

    handler({}, {}, { reason: "crashed" });
    expect(logger.error).toHaveBeenCalledWith("[main] render-process-gone", { reason: "crashed" });
  });
});
