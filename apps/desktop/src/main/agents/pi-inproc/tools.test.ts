// 工具集构造单测。重点守 KTD3:createCodingTools 只给四个,grep/find/ls 必须单独造——
// 漏掉的表现是「plan 档工具不存在」而不报错,单测是唯一能提前抓住它的地方。

import { describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));

import { PI_PLAN_TOOL_WHITELIST } from "../../ipc/types";
import {
  applyActiveTools,
  createBuiltinTools,
  PI_BUILTIN_TOOL_NAMES,
  PI_CODING_TOOL_NAMES,
  PI_EXTRA_BUILTIN_TOOL_NAMES,
  resolveToolWhitelist,
} from "./tools";
import type { PiCodingAgentModule } from "./runtime";

// pi 模块替身:每个工厂返回一个带 name 的哑对象,便于断言「造了哪些工具」。
function fakeMod(): PiCodingAgentModule {
  return {
    createCodingTools: (cwd: string) => ["read", "bash", "edit", "write"].map((name) => ({ name, cwd })),
    createGrepTool: (cwd: string) => ({ name: "grep", cwd }),
    createFindTool: (cwd: string) => ({ name: "find", cwd }),
    createLsTool: (cwd: string) => ({ name: "ls", cwd }),
  } as unknown as PiCodingAgentModule;
}

describe("createBuiltinTools", () => {
  it("补齐 createCodingTools 缺的 grep/find/ls(KTD3)", () => {
    const tools = createBuiltinTools(fakeMod(), "/proj") as Array<{ name: string; cwd: string }>;
    expect(tools.map((t) => t.name)).toEqual([...PI_BUILTIN_TOOL_NAMES]);
    // cwd 必须透传给每个工厂,否则工具会落到 process.cwd()(dev 下 = apps/desktop/)。
    expect(tools.every((t) => t.cwd === "/proj")).toBe(true);
  });

  it("不产生重名工具(不能用 createReadOnlyTools 拼,那样会有两个 read)", () => {
    const tools = createBuiltinTools(fakeMod(), "/proj") as Array<{ name: string }>;
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("PI_PLAN_TOOL_WHITELIST 依赖的三个只读工具全部在补齐清单里", () => {
    // 这条把「plan 档能不能用」和 KTD3 直接绑起来:任一被删掉,这里立刻红。
    for (const name of PI_EXTRA_BUILTIN_TOOL_NAMES) {
      expect(PI_PLAN_TOOL_WHITELIST).toContain(name);
    }
    expect([...PI_CODING_TOOL_NAMES, ...PI_EXTRA_BUILTIN_TOOL_NAMES]).toEqual([...PI_BUILTIN_TOOL_NAMES]);
  });
});

describe("resolveToolWhitelist", () => {
  it("无白名单 → 不收窄(等价于不下发 --tools)", () => {
    expect(resolveToolWhitelist({})).toEqual({ nonBuiltin: [] });
    expect(resolveToolWhitelist({ toolWhitelist: [] })).toEqual({ nonBuiltin: [] });
  });

  it("去重、剔空并标出非内建工具", () => {
    const r = resolveToolWhitelist({ toolWhitelist: ["read", " grep ", "read", "", "browser_navigate"] });
    expect(r.tools).toEqual(["read", "grep", "browser_navigate"]);
    // browser_* 要等 U3 的 customTools 注册后才存在,不是错误,但必须可观测。
    expect(r.nonBuiltin).toEqual(["browser_navigate"]);
  });

  it("plan 档白名单原样保留内建三件套", () => {
    const r = resolveToolWhitelist({ toolWhitelist: [...PI_PLAN_TOOL_WHITELIST] });
    expect(r.tools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    expect(r.tools).not.toContain("write");
    expect(r.tools).not.toContain("bash");
  });
});

describe("applyActiveTools", () => {
  function fakeSession(available: string[]) {
    const applied: string[][] = [];
    return {
      getAllTools: () => available.map((name) => ({ name })),
      setActiveToolsByName: (names: string[]) => applied.push(names),
      applied,
    };
  }

  it("只启用已注册的工具,并把落差记为 missing(pi 侧是静默忽略)", () => {
    const s = fakeSession(["read", "grep", "find", "ls"]);
    const r = applyActiveTools(s, ["read", "grep", "browser_navigate"]);
    expect(r.applied).toEqual(["read", "grep"]);
    expect(r.missing).toEqual(["browser_navigate"]);
    expect(s.applied).toEqual([["read", "grep"]]);
    expect(logMocks.logger.warn).toHaveBeenCalled();
  });

  it("传 undefined 回到 pi 默认的四个 coding 工具", () => {
    const s = fakeSession([...PI_BUILTIN_TOOL_NAMES]);
    const r = applyActiveTools(s, undefined);
    expect(r.applied).toEqual([...PI_CODING_TOOL_NAMES]);
    expect(r.missing).toEqual([]);
  });
});
