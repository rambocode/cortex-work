import { beforeEach, describe, expect, it, vi } from "vitest";

// 可控 ipcMain 桩：原始 handle 把 (channel, wrapped) 存入 map。installIpcTrace 会 monkey-patch
// ipcMainStub.handle，故每个用例在 beforeEach 把它复位回原始实现，保证跨用例隔离。
const { ipcMainStub, origHandle, handleStore, logSpies } = vi.hoisted(() => {
  const handleStore = new Map<string, (...a: unknown[]) => unknown>();
  // 用 rest 签名以匹配 stub 字段类型（避免参数逆变导致的赋值不兼容）。
  const origHandle = (...a: unknown[]): void => {
    const [channel, listener] = a as [string, (...x: unknown[]) => unknown];
    handleStore.set(channel, listener);
  };
  return {
    handleStore,
    origHandle,
    ipcMainStub: { handle: origHandle as (...a: unknown[]) => unknown },
    logSpies: { debug: vi.fn(), error: vi.fn() },
  };
});
vi.mock("electron", () => ({ ipcMain: ipcMainStub }));
vi.mock("./index", () => ({ createLogger: () => logSpies }));
// redact 是纯模块，用真实实现验证脱敏。

import { __resetIpcTraceForTests, installIpcTrace } from "./ipc-trace";

const fakeEvent = { sender: {} }; // 模拟 IpcMainInvokeEvent（第 0 个实参）

beforeEach(() => {
  handleStore.clear();
  logSpies.debug.mockClear();
  logSpies.error.mockClear();
  ipcMainStub.handle = origHandle; // 复位 monkey-patch
  __resetIpcTraceForTests();
});

describe("installIpcTrace", () => {
  it("成功调用记 debug（channel + 耗时），不含入参", async () => {
    installIpcTrace();
    ipcMainStub.handle("demo:ok", async (_e: unknown, x: number) => x + 1);
    const wrapped = handleStore.get("demo:ok")!;
    await expect(wrapped(fakeEvent, 41)).resolves.toBe(42);
    expect(logSpies.debug).toHaveBeenCalledTimes(1);
    const [msg, meta] = logSpies.debug.mock.calls[0];
    expect(msg).toBe("ipc demo:ok");
    expect(meta).toHaveProperty("ms");
  });

  it("reject 记 error（含脱敏入参 + error），并原样抛出", async () => {
    installIpcTrace();
    ipcMainStub.handle("demo:fail", async () => {
      throw new Error("boom");
    });
    const wrapped = handleStore.get("demo:fail")!;
    await expect(wrapped(fakeEvent, { apiKey: "sk-xyz", n: 1 })).rejects.toThrow("boom");
    expect(logSpies.error).toHaveBeenCalledTimes(1);
    const [, meta] = logSpies.error.mock.calls[0];
    expect(meta.error).toBe("boom");
    // 入参摘要跳过第 0 个 event，且敏感字段脱敏
    expect(JSON.stringify(meta.args)).toContain("[redacted]");
    expect(JSON.stringify(meta.args)).not.toContain("sk-xyz");
  });

  it("幂等：重复 install 不重复包裹（成功仅记一次）", async () => {
    installIpcTrace();
    installIpcTrace();
    ipcMainStub.handle("demo:once", async () => "ok");
    await handleStore.get("demo:once")!(fakeEvent);
    expect(logSpies.debug).toHaveBeenCalledTimes(1);
  });
});
