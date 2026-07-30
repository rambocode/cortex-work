import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// env / install 都替身掉：本文件只测「五门控的判定与优先级」这一件事，不测 spawn swiftc、
// 不测 TCC 查询、不测 npm 安装（那些各有自己的边界，混进来会让用例慢且脆）。
const mocks = vi.hoisted(() => ({
  hasSwiftc: vi.fn<() => Promise<boolean>>(),
  hasScreenPermissions: vi.fn<() => Promise<{ accessibility: boolean; screenRecording: boolean }>>(),
  peek: vi.fn<() => string | null>(),
}));

vi.mock("./env", () => ({
  hasSwiftc: mocks.hasSwiftc,
  hasScreenPermissions: mocks.hasScreenPermissions,
}));
vi.mock("./install", () => ({ peekComputerUsePackage: mocks.peek }));
vi.mock("../../log", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { resolveComputerUse, GROUNDING_MODEL_ENV } from "./inject";

const PKG = "/Users/x/.pi/agent/npm/node_modules/pi-computer-use";

// process.platform 是只读属性，用 defineProperty 临时改写并在 afterEach 复原。
const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  setPlatform("darwin");
  mocks.peek.mockReturnValue(PKG);
  mocks.hasSwiftc.mockResolvedValue(true);
  mocks.hasScreenPermissions.mockResolvedValue({ accessibility: true, screenRecording: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.clearAllMocks();
});

describe("resolveComputerUse:五门控", () => {
  it("全部满足 → 返回落盘路径", async () => {
    const res = await resolveComputerUse({ enabled: true });
    expect(res.path).toBe(PKG);
    expect(res.reason).toBeUndefined();
  });

  it("缺省(undefined 设置)视为启用 —— 产品决策是默认开箱即用", async () => {
    expect((await resolveComputerUse(undefined)).path).toBe(PKG);
    expect((await resolveComputerUse({})).path).toBe(PKG);
  });

  it("非 macOS → not-macos", async () => {
    setPlatform("win32");
    const res = await resolveComputerUse({ enabled: true });
    expect(res).toEqual({ path: null, reason: "not-macos", env: {} });
  });

  it("显式关闭 → disabled（只有显式 false 才算关）", async () => {
    expect((await resolveComputerUse({ enabled: false })).reason).toBe("disabled");
  });

  it("未装好 → not-installed", async () => {
    mocks.peek.mockReturnValue(null);
    expect((await resolveComputerUse({ enabled: true })).reason).toBe("not-installed");
  });

  it("缺 swiftc → no-swiftc（编不出原生 helper,所有 gui_* 都会失败）", async () => {
    mocks.hasSwiftc.mockResolvedValue(false);
    expect((await resolveComputerUse({ enabled: true })).reason).toBe("no-swiftc");
  });

  it("未授权辅助功能 → no-accessibility", async () => {
    mocks.hasScreenPermissions.mockResolvedValue({ accessibility: false, screenRecording: true });
    expect((await resolveComputerUse({ enabled: true })).reason).toBe("no-accessibility");
  });

  it("未授权屏幕录制 → no-screen-recording", async () => {
    mocks.hasScreenPermissions.mockResolvedValue({ accessibility: true, screenRecording: false });
    expect((await resolveComputerUse({ enabled: true })).reason).toBe("no-screen-recording");
  });

  // 权限被撤销是最危险的失效方向:必须每次都重新问,不能缓存。
  it("权限查询每次调用都重新发起（不缓存,授权可被随时撤销）", async () => {
    await resolveComputerUse({ enabled: true });
    await resolveComputerUse({ enabled: true });
    expect(mocks.hasScreenPermissions).toHaveBeenCalledTimes(2);
  });

  // 门控短路顺序:便宜的判断在前,避免非 mac / 已关闭时还去 spawn swiftc、查 TCC。
  it("平台/开关不满足时不做昂贵探测", async () => {
    setPlatform("win32");
    await resolveComputerUse({ enabled: true });
    setPlatform("darwin");
    await resolveComputerUse({ enabled: false });
    expect(mocks.hasSwiftc).not.toHaveBeenCalled();
    expect(mocks.hasScreenPermissions).not.toHaveBeenCalled();
  });

  it("未装好时不查权限（没有包就没有工具,查了也没用）", async () => {
    mocks.peek.mockReturnValue(null);
    await resolveComputerUse({ enabled: true });
    expect(mocks.hasScreenPermissions).not.toHaveBeenCalled();
  });
});

describe("resolveComputerUse:grounding 模型 env", () => {
  it("配了定位模型 → 注入 PI_COMPUSE_GROUNDING_MODEL", async () => {
    const res = await resolveComputerUse({ enabled: true, groundingModel: "qwen-vl-max" });
    expect(res.env).toEqual({ [GROUNDING_MODEL_ENV]: "qwen-vl-max" });
  });

  it("未配 → 不注入任何 env（由该 package 回退到会话模型）", async () => {
    expect((await resolveComputerUse({ enabled: true })).env).toEqual({});
  });

  it("空白串等同未配（避免把空值塞进 env 让 package 拿到空模型名）", async () => {
    expect((await resolveComputerUse({ enabled: true, groundingModel: "   " })).env).toEqual({});
  });

  it("两侧空白被裁掉", async () => {
    const res = await resolveComputerUse({ enabled: true, groundingModel: "  gpt-4o  " });
    expect(res.env[GROUNDING_MODEL_ENV]).toBe("gpt-4o");
  });

  it("不可注入时 env 恒为空", async () => {
    mocks.hasSwiftc.mockResolvedValue(false);
    const res = await resolveComputerUse({ enabled: true, groundingModel: "qwen-vl-max" });
    expect(res).toEqual({ path: null, reason: "no-swiftc", env: {} });
  });
});
