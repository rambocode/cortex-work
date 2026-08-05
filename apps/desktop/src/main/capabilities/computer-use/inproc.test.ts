// inproc.ts 的单测。
//
// 边界划分：五门控本身由 inject.test.ts 覆盖，这里**不重测**（重测等于把同一份判定抄两遍，
// 日后改一处必漏一处）。本文件只测「决策为注入之后怎么接上去」这一层：
//   · 路径怎么变成 additionalExtensionPaths；
//   · grounding 模型怎么落到 process.env（含「清空必须真能清掉」这条易漏的边界）；
//   · 决策抛错时是否真的降级为不注入而不是把会话打挂；
//   · 加载错误的归因与留痕。
// 外加两条**读源码的守卫**，守住「五门控不被复制/放宽」与「注入点不外溢到无审批路径」——
// 这两条是架构约束，类型系统表达不了，只能靠测试守（手法同 automation/inject-points.test.ts）。
//
// 刻意不碰真实 ~/.pi、不装包、不 spawn：inject 整个被替身掉。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComputerUseResolution } from "./inject";

const mocks = vi.hoisted(() => ({
  resolveComputerUse: vi.fn<() => Promise<unknown>>(),
  warn: vi.fn<(...args: unknown[]) => void>(),
}));

// GROUNDING_MODEL_ENV 是常量，替身里必须与真实值一致，否则测的是另一个变量名。
vi.mock("./inject", () => ({
  GROUNDING_MODEL_ENV: "PI_COMPUSE_GROUNDING_MODEL",
  resolveComputerUse: mocks.resolveComputerUse,
}));
vi.mock("../../log", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: mocks.warn, error: () => {} }),
}));

import {
  isComputerUseExtensionPath,
  reportComputerUseLoadErrors,
  resolveComputerUseInproc,
} from "./inproc";

const ENV_KEY = "PI_COMPUSE_GROUNDING_MODEL";
const PKG = "/Users/x/.pi/agent/npm/node_modules/pi-computer-use";

const injectable = (env: Record<string, string> = {}): ComputerUseResolution => ({ path: PKG, env });

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  mocks.resolveComputerUse.mockResolvedValue(injectable());
});

afterEach(() => {
  // 进程级变量必须复原，否则会串到同一 worker 里的其它测试文件。
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  vi.clearAllMocks();
});

describe("resolveComputerUseInproc:注入路径", () => {
  it("门控全过 → 把包目录放进 additionalExtensionPaths", async () => {
    const res = await resolveComputerUseInproc({ enabled: true });
    expect(res.additionalExtensionPaths).toEqual([PKG]);
    expect(res.reason).toBeUndefined();
  });

  it("门控未过 → 空数组 + 透传 reason（不注入不是错误）", async () => {
    mocks.resolveComputerUse.mockResolvedValue({ path: null, reason: "no-swiftc", env: {} });
    const res = await resolveComputerUseInproc({ enabled: true });
    expect(res.additionalExtensionPaths).toEqual([]);
    expect(res.reason).toBe("no-swiftc");
  });

  it("设置原样透传给 resolveComputerUse（本层不预处理、不放宽）", async () => {
    const settings = { enabled: true, groundingModel: "qwen-vl-max" };
    await resolveComputerUseInproc(settings);
    expect(mocks.resolveComputerUse).toHaveBeenCalledWith(settings);
  });

  // KTD5：in-process 没有子进程退出码，任何抛错都必须就地降级，绝不能冒泡把会话打挂。
  it("决策抛错 → 降级为不注入并留痕,不向上抛", async () => {
    mocks.resolveComputerUse.mockRejectedValue(new Error("TCC 查询超时"));
    const res = await resolveComputerUseInproc({ enabled: true });
    expect(res.additionalExtensionPaths).toEqual([]);
    expect(res.env).toEqual({});
    expect(mocks.warn).toHaveBeenCalled();
  });
});

describe("resolveComputerUseInproc:grounding 模型 env", () => {
  it("配了定位模型 → 写进主进程 process.env（in-process 无子进程可传 env）", async () => {
    mocks.resolveComputerUse.mockResolvedValue(injectable({ [ENV_KEY]: "qwen-vl-max" }));
    const res = await resolveComputerUseInproc({ enabled: true, groundingModel: "qwen-vl-max" });
    expect(process.env[ENV_KEY]).toBe("qwen-vl-max");
    expect(res.env).toEqual({ [ENV_KEY]: "qwen-vl-max" });
  });

  // 只写不删会让上一轮的模型名永久粘住：用户清空输入框却仍打在旧模型上，且毫无提示。
  it("用户清空设置 → 上一轮写下的 env 必须被删掉", async () => {
    mocks.resolveComputerUse.mockResolvedValue(injectable({ [ENV_KEY]: "qwen-vl-max" }));
    await resolveComputerUseInproc({ enabled: true, groundingModel: "qwen-vl-max" });

    mocks.resolveComputerUse.mockResolvedValue(injectable());
    const res = await resolveComputerUseInproc({ enabled: true });
    expect(ENV_KEY in process.env).toBe(false);
    expect(res.env).toEqual({});
  });

  // 门控未过 ≠ 用户清空了配置：不该顺手把别的活跃会话的 grounding 模型抹掉。
  it("门控未过 → 不碰 env（保持既有值）", async () => {
    process.env[ENV_KEY] = "gpt-4o";
    mocks.resolveComputerUse.mockResolvedValue({ path: null, reason: "disabled", env: {} });
    await resolveComputerUseInproc({ enabled: false });
    expect(process.env[ENV_KEY]).toBe("gpt-4o");
  });

  it("决策抛错 → 同样不碰 env", async () => {
    process.env[ENV_KEY] = "gpt-4o";
    mocks.resolveComputerUse.mockRejectedValue(new Error("boom"));
    await resolveComputerUseInproc({ enabled: true });
    expect(process.env[ENV_KEY]).toBe("gpt-4o");
  });
});

describe("加载失败的留痕与归因", () => {
  // SDK 加载 extension 失败时不抛，只收进 errors 数组 —— 不主动留痕就彻底沉默。
  it("属于本包的加载错误 → warn 留痕并计数", () => {
    const n = reportComputerUseLoadErrors([
      { path: `${PKG}/src/index.ts`, error: "Cannot find module '@sinclair/typebox'" },
    ]);
    expect(n).toBe(1);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("别人的加载错误不归到本包头上", () => {
    const n = reportComputerUseLoadErrors([{ path: "/tmp/some-other-ext/index.ts", error: "boom" }]);
    expect(n).toBe(0);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("errors 为空/缺省时安全返回 0", () => {
    expect(reportComputerUseLoadErrors(undefined)).toBe(0);
    expect(reportComputerUseLoadErrors([])).toBe(0);
  });

  // SDK 报回来的是清单展开后的入口文件路径，不是我们传进去的目录路径，故不能用等值比较。
  it("路径归因认包目录与其下的入口文件,不误伤同名前缀", () => {
    expect(isComputerUseExtensionPath(PKG)).toBe(true);
    expect(isComputerUseExtensionPath(`${PKG}/src/index.ts`)).toBe(true);
    expect(isComputerUseExtensionPath("/x/pi-computer-use-fork/index.ts")).toBe(false);
    expect(isComputerUseExtensionPath("/x/my-pi-computer-use/index.ts")).toBe(false);
  });
});

// ── 架构守卫（读源码断言，手法同 automation/inject-points.test.ts）──────────────
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("守卫:五门控只有 inject.ts 一处", () => {
  const src = read("./inproc.ts");

  it("in-process 适配层委托 resolveComputerUse,不自己判定", () => {
    expect(src).toContain("resolveComputerUse(settings)");
  });

  // 任何一条门控被复制到这里，都意味着日后改 inject.ts 会漏改这份副本 ——
  // 而漏改的方向是「本该不注入却注入了」，即在没有 swiftc / 没授权时把 gui_* 交给 Agent。
  it.each(["hasSwiftc", "hasScreenPermissions", "peekComputerUsePackage", "process.platform"])(
    "%s 不得出现在 inproc.ts（门控不许有第二份实现）",
    (symbol) => {
      expect(src).not.toContain(symbol);
    },
  );
});

describe("守卫:注入点不得外溢到无审批路径", () => {
  // 单发路径与无人值守路径没有审批 UI，在那里放开鼠标键盘等于让 Agent 无监督操作用户电脑。
  // 这条约束旧路径靠「只有 preparePiOpenRequest 调 resolveComputerUse」维持，
  // in-process 化后同样只能靠纪律 —— 故用一条测试把纪律钉住。
  it.each([
    ["../../ipc/cli.ts", "cli.ts:claude/codex 与 pi 单发路径"],
    ["../../agents/pi.ts", "pi.ts:单发 json 模式"],
    ["../../automation/runner.ts", "automation/runner.ts:无人值守定时任务"],
  ])("%s 不得引用 in-process 注入入口（%s）", (rel) => {
    expect(read(rel)).not.toContain("resolveComputerUseInproc");
  });
});
