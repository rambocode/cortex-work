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

// 市场那边的 spawn 不能真跑（会去 npm 拉包），但 parsePiList 是纯函数、要用真的：
// 它是「pi list 输出 → 路径」这条契约的唯一实现，替身掉就等于没测。
vi.mock("../../ipc/pi-extensions-market", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ipc/pi-extensions-market")>();
  return { parsePiList: real.parsePiList, runPiCli: vi.fn() };
});

import { ensureComputerUsePackage, peekComputerUsePackage, findComputerUsePath, __setRunnerForTest } from "./install";
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

// pi list 的真实输出形状（缩进 4 空格的绝对路径行）。
const listOutput = (p: string) => `User packages:\n  ${COMPUTER_USE_SOURCE_REF}\n    ${p}\n`;
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

beforeEach(() => {
  setPlatform("darwin");
  userData = mkdtempSync(join(tmpdir(), "cu-userdata-"));
  pkgRoot = mkdtempSync(join(tmpdir(), "cu-pkg-"));
  pkgDir = join(pkgRoot, "node_modules", "pi-computer-use");
  mkdirSync(pkgDir, { recursive: true });
});

afterEach(() => {
  __setRunnerForTest(null);
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  rmSync(userData, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("findComputerUsePath", () => {
  it("从 pi list 路径集里认出 pi-computer-use", () => {
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
  it("首次:跑 install,从 pi list 定位路径并写 marker", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(ok("No packages installed.")) // 装前 list：没有
      .mockResolvedValueOnce(ok("")) // install
      .mockResolvedValueOnce(ok(listOutput(pkgDir))); // 装后 list
    __setRunnerForTest(runner);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(runner.mock.calls[1]?.[0]).toEqual(["install", COMPUTER_USE_SOURCE_REF]);
    const marker = JSON.parse(readFileSync(markerFile(), "utf-8"));
    expect(marker).toMatchObject({ sourceRef: COMPUTER_USE_SOURCE_REF, path: pkgDir });
  });

  // 幂等是这个模块存在的主要理由：每次启动都预装，但装过就不该再 spawn 任何东西。
  it("marker 命中且路径仍在 → 零 spawn", async () => {
    writeFileSync(
      markerFile(),
      JSON.stringify({ sourceRef: COMPUTER_USE_SOURCE_REF, path: pkgDir, installedAt: 1 }),
    );
    const runner = vi.fn();
    __setRunnerForTest(runner);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(runner).not.toHaveBeenCalled();
  });

  it("marker 指向的包被外部删掉 → 重新安装", async () => {
    writeFileSync(
      markerFile(),
      JSON.stringify({ sourceRef: COMPUTER_USE_SOURCE_REF, path: join(pkgDir, "gone"), installedAt: 1 }),
    );
    const runner = vi
      .fn()
      .mockResolvedValueOnce(ok("No packages installed."))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(listOutput(pkgDir)));
    __setRunnerForTest(runner);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(runner).toHaveBeenCalled();
  });

  // 版本钉死在 sourceRef 里，bump 后旧 marker 必须失效，否则会一直用着老版本的包。
  it("sourceRef 变化（版本 bump）→ 旧 marker 失配,重新对账", async () => {
    writeFileSync(
      markerFile(),
      JSON.stringify({ sourceRef: "npm:pi-computer-use@0.0.1", path: pkgDir, installedAt: 1 }),
    );
    // 库存里已有包 → 走「已装」分支，只 list 不 install。
    const runner = vi.fn().mockResolvedValueOnce(ok(listOutput(pkgDir)));
    __setRunnerForTest(runner);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(markerFile(), "utf-8")).sourceRef).toBe(COMPUTER_USE_SOURCE_REF);
  });

  it("用户先前手动装过（marker 缺失但包在库存里）→ 只补 marker,不重复 install", async () => {
    const runner = vi.fn().mockResolvedValueOnce(ok(listOutput(pkgDir)));
    __setRunnerForTest(runner);

    expect(await ensureComputerUsePackage()).toBe(pkgDir);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toEqual(["list"]);
  });

  // 失败不写 marker 是刻意的：下次启动要能自动重试（首启常见的失败原因是没网）。
  it("install 失败 → 返回 null 且不写 marker（下次启动重试）", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(ok("No packages installed."))
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "network unreachable" });
    __setRunnerForTest(runner);

    expect(await ensureComputerUsePackage()).toBeNull();
    expect(existsSync(markerFile())).toBe(false);
  });

  it("install 报成功但 list 里找不到 → 返回 null 且不写 marker", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(ok("No packages installed."))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok("No packages installed."));
    __setRunnerForTest(runner);

    expect(await ensureComputerUsePackage()).toBeNull();
    expect(existsSync(markerFile())).toBe(false);
  });

  it("runner 抛异常 → 吞掉返回 null（绝不冒泡拖垮 whenReady）", async () => {
    __setRunnerForTest(vi.fn().mockRejectedValue(new Error("boom")));
    expect(await ensureComputerUsePackage()).toBeNull();
  });

  it("非 macOS → 直接 null,不 spawn", async () => {
    setPlatform("win32");
    const runner = vi.fn();
    __setRunnerForTest(runner);
    expect(await ensureComputerUsePackage()).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  // whenReady 的 fire-and-forget 与设置页「重试」可能同时触发。
  it("在途去重:并发调用只跑一遍 install", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(ok("No packages installed."))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(listOutput(pkgDir)));
    __setRunnerForTest(runner);

    const [a, b, c] = await Promise.all([
      ensureComputerUsePackage(),
      ensureComputerUsePackage(),
      ensureComputerUsePackage(),
    ]);
    expect([a, b, c]).toEqual([pkgDir, pkgDir, pkgDir]);
    expect(runner.mock.calls.filter((c2) => c2[0]?.[0] === "install")).toHaveLength(1);
  });
});

describe("peekComputerUsePackage", () => {
  it("只读探测:marker 有效则回路径,且不 spawn", () => {
    writeFileSync(
      markerFile(),
      JSON.stringify({ sourceRef: COMPUTER_USE_SOURCE_REF, path: pkgDir, installedAt: 1 }),
    );
    const runner = vi.fn();
    __setRunnerForTest(runner);
    expect(peekComputerUsePackage()).toBe(pkgDir);
    expect(runner).not.toHaveBeenCalled();
  });

  it("无 marker → null", () => {
    expect(peekComputerUsePackage()).toBeNull();
  });

  it("marker 是坏 JSON → 当作没装（不抛）", () => {
    writeFileSync(markerFile(), "{ not json");
    expect(peekComputerUsePackage()).toBeNull();
  });
});
