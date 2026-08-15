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

  // 「文件不存在」是探测可选文件时的正常结果，调用方本就按 ok:false 优雅降级
  // （如 hydrateDesignChatMetaForDoc 读 .cortex-design/<doc>/chat/meta.json）。
  // 按 error 记会在 dev 日志里持续刷屏并淹没真错误 —— 降到 debug，但仍原样抛出。
  it("ENOENT 记 debug（可选文件探测不是错误），仍原样抛出", async () => {
    installIpcTrace();
    ipcMainStub.handle("fs:readFile", async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, stat '/x/chat/meta.json'"), {
        code: "ENOENT",
      });
    });
    const wrapped = handleStore.get("fs:readFile")!;
    await expect(wrapped(fakeEvent, "/x/chat/meta.json")).rejects.toThrow("ENOENT");
    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.debug).toHaveBeenCalledTimes(1);
    const [msg, meta] = logSpies.debug.mock.calls[0];
    expect(msg).toContain("fs:readFile");
    expect(meta.error).toContain("ENOENT");
  });

  it("其它错误仍记 error（不因上条降级而漏报真故障）", async () => {
    installIpcTrace();
    ipcMainStub.handle("fs:readFile", async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    await expect(handleStore.get("fs:readFile")!(fakeEvent, "/x")).rejects.toThrow("EACCES");
    expect(logSpies.error).toHaveBeenCalledTimes(1);
  });

  // fs:exists 一类批量探测通道:一次消息渲染几十条 { ms: 0 } 成功日志纯属噪声 + CPU 浪费。
  it("高频探测通道(fs:exists)成功不记日志,失败仍记 error", async () => {
    installIpcTrace();
    ipcMainStub.handle("fs:exists", async () => true);
    await expect(handleStore.get("fs:exists")!(fakeEvent, "/x")).resolves.toBe(true);
    expect(logSpies.debug).not.toHaveBeenCalled();
    expect(logSpies.error).not.toHaveBeenCalled();

    ipcMainStub.handle = origHandle;
    __resetIpcTraceForTests();
    installIpcTrace();
    ipcMainStub.handle("fs:exists", async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    await expect(handleStore.get("fs:exists")!(fakeEvent, "/x")).rejects.toThrow("EACCES");
    expect(logSpies.error).toHaveBeenCalledTimes(1);
  });

  it("幂等：重复 install 不重复包裹（成功仅记一次）", async () => {
    installIpcTrace();
    installIpcTrace();
    ipcMainStub.handle("demo:once", async () => "ok");
    await handleStore.get("demo:once")!(fakeEvent);
    expect(logSpies.debug).toHaveBeenCalledTimes(1);
  });
});
