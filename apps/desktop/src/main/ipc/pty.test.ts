import { describe, expect, it, vi, beforeEach } from "vitest";

// 生命周期埋点单测:mock electron / node-pty / ./cli / ../log,断言 spawn 成功(debug)、
// onExit 退出码(debug)、killAllPty 回收(debug)经 scoped logger 落点。纯路径函数测试不受影响。
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
}));
// 注意:pty.ts 经 require("node-pty") 懒加载,vi.mock 无法拦截 CJS require,故 spawn 埋点
// 用真实 node-pty 跑(短命子进程,测试内 killAllPty 回收),仅对 id 等稳定字段做断言。
vi.mock("./cli", () => ({ buildEnv: () => ({}) }));
vi.mock("../log", () => ({ createLogger: () => mocks.log, isDevEnv: () => true }));

import { nodePtyDiskRoot, nodePtySpawnHelperCandidates, registerPtyHandlers, killAllPty } from "./pty";

describe("node-pty spawn-helper path", () => {
  it("maps packaged app.asar roots to app.asar.unpacked before chmod", () => {
    const root = "/Applications/Cortex.app/Contents/Resources/app.asar/node_modules/node-pty";

    expect(nodePtyDiskRoot(root)).toBe(
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty",
    );
  });

  it("does not double-map an already unpacked root", () => {
    const root = "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty";

    expect(nodePtyDiskRoot(root)).toBe(root);
  });

  it("builds chmod candidates from the physical node-pty root", () => {
    const candidates = nodePtySpawnHelperCandidates(
      "/Applications/Cortex.app/Contents/Resources/app.asar/node_modules/node-pty",
      "darwin",
      "arm64",
    );

    expect(candidates).toEqual([
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Debug/spawn-helper",
      "/Applications/Cortex.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    ]);
  });
});

// 假 sender:not destroyed,记录 send;once 捕获 destroyed 回收回调。
function makeFakeSender() {
  return { isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
}

describe("pty 生命周期埋点", () => {
  beforeEach(() => {
    killAllPty(); // 清掉上轮残留终端
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it("killAllPty 空注册表 → log.debug 记回收 0", () => {
    killAllPty();
    expect(mocks.log.debug).toHaveBeenCalledWith(expect.stringContaining("killAllPty 回收 0"));
  });

  it("spawn 成功 → log.debug 记 id/pid;onExit → log.debug 记退出码(真实 node-pty)", async () => {
    registerPtyHandlers();
    const spawnHandler = mocks.handlers.get("pty:spawn")!;
    const res = spawnHandler({ sender: makeFakeSender() }, { id: "t1", cols: 80, rows: 24 }) as { ok: boolean };

    // node-pty 不可用的环境(无原生预编译)直接跳过真实进程断言。
    if (!res.ok) return;
    expect(mocks.log.debug).toHaveBeenCalledWith(expect.stringContaining("spawn 成功 id=t1 pid="));

    // killAllPty 对真实 proc 调用 kill() → 子进程退出 → 异步落 onExit 埋点。
    mocks.log.debug.mockClear();
    killAllPty();
    await vi.waitFor(() => {
      expect(mocks.log.debug).toHaveBeenCalledWith(expect.stringContaining("onExit id=t1 exitCode="));
    });
  });
});
