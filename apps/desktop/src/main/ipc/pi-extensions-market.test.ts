// pi 扩展市场 IPC（U4·R8）单测:in-process `DefaultPackageManager` 路径。
// 覆盖 detectOrigin 纯函数;install 落盘定位 / 失败回滚 / 无路径报错 / 在途去重 / settings 排空;
// list 去重与失败降级;remove;运行时加载失败的响亮错误;超时不永久阻塞串行链。
// electron(ipcMain) 与 cli(buildEnv) 全 mock,包管理会话注入 fake。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
}));
vi.mock("./cli", () => ({ buildEnv: () => ({ PATH: "/fake/bin" }) }));
vi.mock("../log", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import {
  registerPiExtensionMarketHandlers,
  __setPiPackageSessionForTest,
  detectOrigin,
  listInstalledPackagePaths,
  type PiConfiguredPackage,
  type PiPackageProgressEvent,
  type PiPackageSession,
} from "./pi-extensions-market";
import type { PiExtInstallResult } from "./types";

registerPiExtensionMarketHandlers();
const callList = () => h.handlers.get("pi-ext:list")!() as Promise<string[]>;
const callInstall = (sourceRef: string) =>
  h.handlers.get("pi-ext:install")!({}, { sourceRef }) as Promise<PiExtInstallResult>;
const callRemove = (sourceRef: string) =>
  h.handlers.get("pi-ext:remove")!({}, { sourceRef }) as Promise<{ ok: boolean; error?: string }>;

/**
 * 内存版包管理器替身：用一个「已装包名 → 路径」的 map 模拟 ~/.pi 的落盘状态。
 * `installImpl` 可覆写以模拟失败 / 半写入。
 */
function fakeSession(options: {
  installed?: Record<string, string>;
  installImpl?: (source: string, installed: Record<string, string>) => Promise<void>;
  removeImpl?: (source: string, installed: Record<string, string>) => Promise<boolean>;
} = {}) {
  const installed = { ...(options.installed ?? {}) };
  let progress: ((e: PiPackageProgressEvent) => void) | undefined;
  const flush = vi.fn(async () => {});
  const session: PiPackageSession = {
    pm: {
      listConfiguredPackages: (): PiConfiguredPackage[] =>
        Object.entries(installed).map(([source, installedPath]) => ({ source, scope: "user", installedPath })),
      getInstalledPath: (source) => installed[source],
      installAndPersist: async (source) => {
        if (options.installImpl) return options.installImpl(source, installed);
        installed[source] = `/pi/npm/node_modules/${source.replace(/^npm:/, "").split("@")[0]}`;
      },
      removeAndPersist: async (source) => {
        if (options.removeImpl) return options.removeImpl(source, installed);
        const had = source in installed;
        delete installed[source];
        return had;
      },
      setProgressCallback: (cb) => {
        progress = cb;
      },
    },
    flush,
  };
  return { session, installed, flush, emit: (e: PiPackageProgressEvent) => progress?.(e) };
}

afterEach(() => {
  __setPiPackageSessionForTest(null);
  vi.useRealTimers();
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
  it("成功:getInstalledPath 定位落盘 path + 溯源,并排空 settings 写入", async () => {
    const f = fakeSession({ installed: { "npm:old": "/a/old" } });
    __setPiPackageSessionForTest(async () => f.session);

    const r = await callInstall("npm:new");
    expect(r).toEqual({
      ok: true,
      ref: "npm:new",
      sourceRef: "npm:new",
      origin: "npm",
      path: "/pi/npm/node_modules/new",
    });
    // 不 flush 就报成功,长驻 pi 会话可能读到还没落盘的 settings.json。
    expect(f.flush).toHaveBeenCalled();
  });

  it("失败且半写入 → 回滚 remove + ok:false,错误里带进度里的原因", async () => {
    // 进度回调是 in-process 下唯一能拿到失败明细的通道(SDK 的 npm 走 stdio:inherit,无 stderr),
    // 故在 install 里现场 emit 一条 error 事件,断言它被拼进最终错误文本。
    let emit: (e: PiPackageProgressEvent) => void = () => {};
    const f = fakeSession({
      installImpl: async (source, installed) => {
        installed[source] = "/a/half"; // 半写入
        emit({ type: "error", action: "install", source, message: "网络断" });
        throw new Error("npm install failed with code 1");
      },
    });
    emit = f.emit;
    __setPiPackageSessionForTest(async () => f.session);

    const r = await callInstall("npm:bad");

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("npm install failed");
      expect(r.error).toContain("网络断");
    }
    expect(f.installed["npm:bad"]).toBeUndefined(); // 已回滚
  });

  it("装前已存在的包安装失败 → 不回滚（那不是本次的半写入）", async () => {
    const f = fakeSession({
      installed: { "npm:keep": "/a/keep" },
      installImpl: async () => {
        throw new Error("boom");
      },
    });
    __setPiPackageSessionForTest(async () => f.session);

    const r = await callInstall("npm:keep");
    expect(r.ok).toBe(false);
    expect(f.installed["npm:keep"]).toBe("/a/keep");
  });

  it("报成功但定位不到路径 → ok:false", async () => {
    const f = fakeSession({ installImpl: async () => {} }); // 什么都不装
    __setPiPackageSessionForTest(async () => f.session);
    const r = await callInstall("npm:noop");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("无法定位");
  });

  it("在途去重:同 ref 并发只跑一次 install", async () => {
    let installCalls = 0;
    const f = fakeSession({
      installImpl: async (source, installed) => {
        installCalls++;
        await Promise.resolve();
        installed[source] = "/a/x";
      },
    });
    __setPiPackageSessionForTest(async () => f.session);

    const [a, b] = await Promise.all([callInstall("npm:dup"), callInstall("npm:dup")]);
    expect(a).toBe(b); // 同一 Promise
    expect(installCalls).toBe(1);
  });

  it("空 ref → ok:false 且不碰包管理器", async () => {
    let touched = false;
    __setPiPackageSessionForTest(async () => {
      touched = true;
      return fakeSession().session;
    });
    const r = await callInstall("   ");
    expect(r.ok).toBe(false);
    expect(touched).toBe(false);
  });

  it("pi 运行时加载失败 → ok:false 且错误响亮（不静默降级成「装好了」）", async () => {
    __setPiPackageSessionForTest(async () => {
      throw new Error("pi 包管理运行时不可用（pi-coding-agent 加载失败）: ERR_MODULE_NOT_FOUND");
    });
    const r = await callInstall("npm:x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("pi 包管理运行时不可用");
  });
});

describe("超时（挂死兜底）", () => {
  it("install 挂死 → 到点以超时错误 settle,不永久阻塞串行链", async () => {
    vi.useFakeTimers();
    const f = fakeSession({ installImpl: () => new Promise(() => {}) }); // 永不 settle
    __setPiPackageSessionForTest(async () => f.session);

    const pending = callInstall("npm:hang");
    await vi.advanceTimersByTimeAsync(120_001);
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("超时");

    // 关键:串行链没被卡死,后续操作仍可完成。
    __setPiPackageSessionForTest(async () => fakeSession({ installed: { "npm:z": "/a/z" } }).session);
    await expect(callList()).resolves.toEqual(["/a/z"]);
  });
});

describe("pi-ext:list / remove", () => {
  it("list 返回已装包路径集（去重）", async () => {
    const f = fakeSession({ installed: { "npm:x": "/a/x", "npm:y": "/b/y", "npm:dup": "/a/x" } });
    __setPiPackageSessionForTest(async () => f.session);
    expect(await callList()).toEqual(["/a/x", "/b/y"]);
  });

  it("配置了但没装上的条目不进结果（installedPath 缺失即不存在）", async () => {
    __setPiPackageSessionForTest(async () => {
      const f = fakeSession();
      f.session.pm.listConfiguredPackages = () => [
        { source: "npm:missing", scope: "user" },
        { source: "npm:there", scope: "user", installedPath: "/a/there" },
      ];
      return f.session;
    });
    expect(await callList()).toEqual(["/a/there"]);
  });

  it("运行时不可用 → list 回空集（IPC 契约是 string[]，只能降级）", async () => {
    __setPiPackageSessionForTest(async () => {
      throw new Error("pi 包管理运行时不可用");
    });
    await expect(callList()).resolves.toEqual([]);
    // 直接调底层能力时仍然抛，调用方（computer-use 预装）据此判定失败而非"没装"。
    await expect(listInstalledPackagePaths()).rejects.toThrow("不可用");
  });

  it("remove 成功 → ok:true;失败 → ok:false+error", async () => {
    __setPiPackageSessionForTest(async () => {
      const f = fakeSession({
        installed: { "npm:ok": "/a/ok" },
        removeImpl: async (source, installed) => {
          if (source !== "npm:ok") throw new Error("无此包");
          delete installed[source];
          return true;
        },
      });
      return f.session;
    });
    expect(await callRemove("npm:ok")).toEqual({ ok: true });
    const bad = await callRemove("npm:missing");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("无此包");
  });
});

describe("PATH（补齐已上移到启动期的 ensureProcessPath）", () => {
  beforeEach(() => {
    process.env.PATH = "/original/bin";
  });

  // 早先这里守的是「操作期间临时改写 process.env.PATH、finally 还原」。那个写法能跑但脆:
  // 还原窗口内任何并发 spawn（agent CLI / pty / helper / whisper 都在并发）都会读到被改的值。
  // 现在补齐一次性发生在启动期（main/index.ts 的 ensureProcessPath），本模块不再碰全局状态。
  it("包管理操作全程不改写 process.env.PATH", async () => {
    let seen = "";
    const f = fakeSession({
      installImpl: async (source, installed) => {
        seen = process.env.PATH ?? "";
        installed[source] = "/a/x";
      },
    });
    __setPiPackageSessionForTest(async () => f.session);

    await callInstall("npm:path");
    // 操作期间读到的就是进程当前值——没有临时替换，也就没有还原窗口。
    expect(seen).toBe("/original/bin");
    expect(process.env.PATH).toBe("/original/bin");
  });
});
