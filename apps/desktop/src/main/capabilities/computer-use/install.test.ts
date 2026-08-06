import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// userData 指向真实临时目录：marker 的读写与「路径还在吗」的判定都是真文件系统行为，
// 用内存替身反而测不到「marker 指向的包被删了」这个关键场景。
let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
vi.mock("../../log", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// U4·R8 后预装走市场模块的 in-process `DefaultPackageManager` 封装。这里替身掉那两个能力：
// 真跑会去 npm 拉包并写用户的 ~/.pi。本文件只测「幂等 + marker」这层逻辑，
// 包管理器本身的行为（回滚/超时/进度）由 ipc/pi-extensions-market.test.ts 覆盖。
const pm = vi.hoisted(() => ({ resolve: vi.fn(), install: vi.fn() }));
vi.mock("../../ipc/pi-extensions-market", () => ({
  resolveInstalledPackagePath: pm.resolve,
  installPiPackage: pm.install,
}));

import { ensureComputerUsePackage, peekComputerUsePackage, findComputerUsePath } from "./install";
import { COMPUTER_USE_SOURCE_REF } from "../../ipc/types";

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

// 一个真实存在的目录充当「已装好的包」，让 existsSync 判定为真。
// 目录名必须真叫 pi-computer-use —— findComputerUsePath 是按包名认路径的，
// 随便一个临时目录名会被它正确地判定为「不是这个包」。
let pkgRoot = "";
let pkgDir = "";
const markerFile = () => join(userData, "computer-use-package.json");

beforeEach(() => {
  setPlatform("darwin");
  userData = mkdtempSync(join(tmpdir(), "cu-userdata-"));
  pkgRoot = mkdtempSync(join(tmpdir(), "cu-pkg-"));
  pkgDir = join(pkgRoot, "npm", "node_modules", "pi-computer-use");
  mkdirSync(pkgDir, { recursive: true });
  pm.resolve.mockResolvedValue(undefined);
  pm.install.mockRejectedValue(new Error("未预期的安装调用"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  rmSync(userData, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("findComputerUsePath", () => {
  it("从落盘路径里认出 pi-computer-use", () => {
    expect(findComputerUsePath(["/a/node_modules/other", "/a/node_modules/pi-computer-use"])).toBe(
      "/a/node_modules/pi-computer-use",
    );
  });

  it("不误认前缀相同的其它包（pi-computer-use-extra 不是它）", () => {
    expect(findComputerUsePath(["/a/node_modules/pi-computer-use-extra"])).toBeUndefined();
  });

  it("找不到时返回 undefined", () => {
    expect(findComputerUsePath([])).toBeUndefined();
    expect(findComputerUsePath(["/a/b/c"])).toBeUndefined();
  });
});

describe("ensureComputerUsePackage", () => {
  it("首次:跑 install,拿到落盘路径并写 marker", async () => {
    pm.install.mockResolvedValue(pkgDir);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(pm.install).toHaveBeenCalledWith(COMPUTER_USE_SOURCE_REF);
    const marker = JSON.parse(readFileSync(markerFile(), "utf-8"));
    expect(marker).toMatchObject({ sourceRef: COMPUTER_USE_SOURCE_REF, path: pkgDir });
  });

  // 幂等是这个模块存在的主要理由：每次启动都预装，但装过就不该再碰包管理器。
  it("marker 命中且路径仍在 → 零包管理调用", async () => {
    writeFileSync(markerFile(), JSON.stringify({ sourceRef: COMPUTER_USE_SOURCE_REF, path: pkgDir, installedAt: 1 }));

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(pm.resolve).not.toHaveBeenCalled();
    expect(pm.install).not.toHaveBeenCalled();
  });

  it("marker 指向的包被外部删掉 → 重新安装", async () => {
    writeFileSync(
      markerFile(),
      JSON.stringify({ sourceRef: COMPUTER_USE_SOURCE_REF, path: join(pkgDir, "gone"), installedAt: 1 }),
    );
    pm.install.mockResolvedValue(pkgDir);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(pm.install).toHaveBeenCalled();
  });

  // 版本钉死在 sourceRef 里，bump 后旧 marker 必须失效，否则会一直用着老版本的包。
  it("sourceRef 变化（版本 bump）→ 旧 marker 失配,重新对账", async () => {
    writeFileSync(markerFile(), JSON.stringify({ sourceRef: "npm:pi-computer-use@0.0.1", path: pkgDir, installedAt: 1 }));
    // npm 源按包名定址，同名不同版本也会被 getInstalledPath 命中 → 走「已装」分支，不重装。
    pm.resolve.mockResolvedValue(pkgDir);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(pm.install).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(markerFile(), "utf-8")).sourceRef).toBe(COMPUTER_USE_SOURCE_REF);
  });

  it("用户先前手动装过（marker 缺失但包在库存里）→ 只补 marker,不重复 install", async () => {
    pm.resolve.mockResolvedValue(pkgDir);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(pm.resolve).toHaveBeenCalledWith(COMPUTER_USE_SOURCE_REF);
    expect(pm.install).not.toHaveBeenCalled();
  });

  // 失败不写 marker 是刻意的：下次启动要能自动重试（首启常见的失败原因是没网）。
  it("install 失败 → 返回 null 且不写 marker（下次启动重试）", async () => {
    pm.install.mockRejectedValue(new Error("network unreachable"));

    expect(await ensureComputerUsePackage()).toBeNull();
    expect(existsSync(markerFile())).toBe(false);
  });

  it("install 报成功但路径不是 pi-computer-use → 返回 null 且不写 marker", async () => {
    pm.install.mockResolvedValue("/somewhere/else/pi-other");

    expect(await ensureComputerUsePackage()).toBeNull();
    expect(existsSync(markerFile())).toBe(false);
  });

  // 运行时整体不可用（pi-coding-agent 加载失败）也必须降级成「不可用」，而不是拖垮启动。
  it("包管理运行时不可用 → 吞掉返回 null（绝不冒泡拖垮 whenReady）", async () => {
    pm.resolve.mockRejectedValue(new Error("pi 包管理运行时不可用"));
    expect(await ensureComputerUsePackage()).toBeNull();
  });

  it("非 macOS → 直接 null,不碰包管理器", async () => {
    setPlatform("win32");
    expect(await ensureComputerUsePackage()).toBeNull();
    expect(pm.resolve).not.toHaveBeenCalled();
    expect(pm.install).not.toHaveBeenCalled();
  });

  // whenReady 的 fire-and-forget 与设置页「重试」可能同时触发。
  it("在途去重:并发调用只跑一遍 install", async () => {
    pm.install.mockImplementation(async () => {
      await Promise.resolve();
      return pkgDir;
    });

    const [a, b, c] = await Promise.all([
      ensureComputerUsePackage(),
      ensureComputerUsePackage(),
      ensureComputerUsePackage(),
    ]);
    expect([a, b, c]).toEqual([pkgDir, pkgDir, pkgDir]);
    expect(pm.install).toHaveBeenCalledTimes(1);
  });
});

describe("peekComputerUsePackage", () => {
  it("只读探测:marker 有效则回路径,且不碰包管理器", () => {
    writeFileSync(markerFile(), JSON.stringify({ sourceRef: COMPUTER_USE_SOURCE_REF, path: pkgDir, installedAt: 1 }));
    expect(peekComputerUsePackage()).toBe(pkgDir);
    expect(pm.resolve).not.toHaveBeenCalled();
  });

  it("无 marker → null", () => {
    expect(peekComputerUsePackage()).toBeNull();
  });

  it("marker 是坏 JSON → 当作没装（不抛）", () => {
    writeFileSync(markerFile(), "{ not json");
    expect(peekComputerUsePackage()).toBeNull();
  });
});
