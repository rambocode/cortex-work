// pi 扩展市场 IPC（U4）单测:parsePiList/detectOrigin 纯函数;install 落盘定位/失败回滚/无新增报错/
// 在途去重;list/remove。electron(ipcMain) + cli(spawnEnvFor) + pi-locate 全 mock,runner 注入 fake。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  spawnMock: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
}));
vi.mock("./cli", () => ({ spawnEnvFor: () => ({}) }));
vi.mock("../agents/pi-locate", () => ({ resolvePiBinary: () => "/pi" }));
vi.mock("child_process", () => ({ spawn: (...a: unknown[]) => h.spawnMock(...a) }));

import {
  registerPiExtensionMarketHandlers,
  __setPiRunnerForTest,
  parsePiList,
  detectOrigin,
} from "./pi-extensions-market";
import type { PiExtInstallResult } from "./types";

registerPiExtensionMarketHandlers();
const callList = () => h.handlers.get("pi-ext:list")!() as Promise<string[]>;
const callInstall = (sourceRef: string) =>
  h.handlers.get("pi-ext:install")!({}, { sourceRef }) as Promise<PiExtInstallResult>;
const callRemove = (sourceRef: string) =>
  h.handlers.get("pi-ext:remove")!({}, { sourceRef }) as Promise<{ ok: boolean; error?: string }>;

const listOut = (paths: string[]) => paths.map((p) => `    ${p}`).join("\n");

beforeEach(() => __setPiRunnerForTest(null));

describe("parsePiList", () => {
  it("取缩进>=4 的绝对路径行,去重", () => {
    const out = `User packages:\n  npm:foo\n    /a/foo\n  git:bar\n    /b/bar\n    /a/foo`;
    expect(parsePiList(out)).toEqual(["/a/foo", "/b/bar"]);
  });
  it("空/无包 → []", () => expect(parsePiList("User packages:\n")).toEqual([]));
});

describe("detectOrigin", () => {
  it("npm/git/https/local", () => {
    expect(detectOrigin("npm:@foo/bar")).toBe("npm");
    expect(detectOrigin("git:github.com/u/r")).toBe("git");
    expect(detectOrigin("https://github.com/u/r")).toBe("git");
    expect(detectOrigin("./local/x")).toBe("local");
  });
});

describe("pi-ext:install", () => {
  it("成功:list 前后差分定位落盘 path + 溯源", async () => {
    let installed = ["/a/old"];
    __setPiRunnerForTest(async (args) => {
      if (args[0] === "list") return { code: 0, stdout: listOut(installed), stderr: "" };
      if (args[0] === "install") {
        installed = [...installed, "/a/new"];
        return { code: 0, stdout: "Installed", stderr: "" };
      }
      return { code: -1, stdout: "", stderr: "?" };
    });
    const r = await callInstall("npm:new");
    expect(r).toEqual({ ok: true, ref: "npm:new", sourceRef: "npm:new", origin: "npm", path: "/a/new" });
  });

  it("失败(非零退出)且半写入 → 回滚 remove + ok:false", async () => {
    const calls: string[][] = [];
    let installed = ["/a/old"];
    __setPiRunnerForTest(async (args) => {
      calls.push(args);
      if (args[0] === "list") return { code: 0, stdout: listOut(installed), stderr: "" };
      if (args[0] === "install") {
        installed = [...installed, "/a/half"]; // 半写入
        return { code: 1, stdout: "", stderr: "网络断" };
      }
      if (args[0] === "remove") return { code: 0, stdout: "", stderr: "" };
      return { code: -1, stdout: "", stderr: "?" };
    });
    const r = await callInstall("npm:bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("网络断");
    expect(calls.some((c) => c[0] === "remove")).toBe(true); // 触发回滚
  });

  it("成功但 list 无新增 → ok:false（无法定位路径）", async () => {
    __setPiRunnerForTest(async (args) => {
      if (args[0] === "list") return { code: 0, stdout: listOut(["/a/old"]), stderr: "" };
      if (args[0] === "install") return { code: 0, stdout: "Installed", stderr: "" }; // 不增 list
      return { code: -1, stdout: "", stderr: "?" };
    });
    const r = await callInstall("npm:noop");
    expect(r.ok).toBe(false);
  });

  it("在途去重:同 ref 并发只跑一次 install", async () => {
    let installCalls = 0;
    let installed: string[] = [];
    __setPiRunnerForTest(async (args) => {
      if (args[0] === "list") return { code: 0, stdout: listOut(installed), stderr: "" };
      if (args[0] === "install") {
        installCalls++;
        await Promise.resolve();
        installed = ["/a/x"];
        return { code: 0, stdout: "Installed", stderr: "" };
      }
      return { code: -1, stdout: "", stderr: "?" };
    });
    const [a, b] = await Promise.all([callInstall("npm:dup"), callInstall("npm:dup")]);
    expect(a).toBe(b); // 同一 Promise
    expect(installCalls).toBe(1);
  });

  it("空 ref → ok:false 不 spawn", async () => {
    let spawned = false;
    __setPiRunnerForTest(async () => {
      spawned = true;
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await callInstall("   ");
    expect(r.ok).toBe(false);
    expect(spawned).toBe(false);
  });
});

describe("defaultRunner 超时（C1 spawn 挂死兜底）", () => {
  // 可控 fake 子进程:不 emit close → 模拟挂死。
  function fakeChild() {
    const c = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = vi.fn();
    return c;
  }
  afterEach(() => {
    vi.useRealTimers();
    __setPiRunnerForTest(null);
  });

  it("pi list 挂死 → 短超时(30s) SIGTERM 并以 code:-1 settle,不永久阻塞", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    h.spawnMock.mockReturnValue(child);
    __setPiRunnerForTest(null); // 用真实 defaultRunner（走 mock spawn）
    const pending = callList(); // list 永不 close → 挂死
    await vi.advanceTimersByTimeAsync(30_001); // 越过 list/remove 的 30s 短超时
    await expect(pending).resolves.toEqual([]); // list code:-1 → listPaths []
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("子进程正常 close → 不触发超时,正常返回退出码", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    h.spawnMock.mockReturnValue(child);
    __setPiRunnerForTest(null);
    const pending = callList();
    child.stdout.emit("data", "    /a/x\n");
    child.emit("close", 0);
    await expect(pending).resolves.toEqual(["/a/x"]);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("pi-ext:list / remove", () => {
  it("list 返回解析后的路径集", async () => {
    __setPiRunnerForTest(async () => ({ code: 0, stdout: listOut(["/a/x", "/b/y"]), stderr: "" }));
    expect(await callList()).toEqual(["/a/x", "/b/y"]);
  });
  it("remove 成功 → ok:true;失败 → ok:false+error", async () => {
    __setPiRunnerForTest(async (args) =>
      args[1] === "npm:ok" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "无此包" },
    );
    expect(await callRemove("npm:ok")).toEqual({ ok: true });
    const bad = await callRemove("npm:missing");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("无此包");
  });
});
