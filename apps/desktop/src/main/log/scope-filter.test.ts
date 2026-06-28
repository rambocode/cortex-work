import { beforeEach, describe, expect, it, vi } from "vitest";

// 隔离 electron-log：scope-filter 只需要 log.hooks 数组可被 push。
const { hooks } = vi.hoisted(() => ({ hooks: [] as Array<(m: { level: string; scope?: string }) => unknown> }));
vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("../paths", () => ({ logsDir: () => "/fake/logs" }));
vi.mock("electron-log/main", () => ({
  default: {
    initialize: vi.fn(),
    scope: vi.fn((n: string) => ({ name: n })),
    functions: {},
    hooks,
    transports: { file: { transforms: [] }, console: {} },
  },
}));

import {
  __resetScopeFilterForTests,
  installScopeFilter,
  setDebugScopes,
  shouldPass,
} from "./scope-filter";

beforeEach(() => {
  hooks.length = 0;
  __resetScopeFilterForTests();
});

describe("shouldPass", () => {
  it("info 及以上始终放行（不受 scope 白名单约束）", () => {
    setDebugScopes(["cli"]);
    expect(shouldPass("info", "pi-rpc")).toBe(true);
    expect(shouldPass("error", "pi-rpc")).toBe(true);
    expect(shouldPass("warn", undefined)).toBe(true);
  });

  it("空白名单时细粒度日志全放行（交给全局阈值）", () => {
    setDebugScopes([]);
    expect(shouldPass("debug", "anything")).toBe(true);
    expect(shouldPass("silly", undefined)).toBe(true);
  });

  it("非空白名单时仅放行白名单内 scope 的细粒度日志", () => {
    setDebugScopes(["cli", "pi-rpc"]);
    expect(shouldPass("debug", "cli")).toBe(true);
    expect(shouldPass("debug", "pi-rpc")).toBe(true);
    expect(shouldPass("debug", "automation")).toBe(false);
    expect(shouldPass("verbose", undefined)).toBe(false);
  });
});

describe("installScopeFilter", () => {
  it("装一个 hook 且幂等", () => {
    installScopeFilter();
    installScopeFilter();
    expect(hooks.length).toBe(1);
  });

  it("hook 对被过滤的细粒度日志返回 false", () => {
    setDebugScopes(["cli"]);
    installScopeFilter();
    const hook = hooks[0];
    expect(hook({ level: "debug", scope: "automation" })).toBe(false);
    expect(hook({ level: "debug", scope: "cli" })).toMatchObject({ level: "debug" });
    expect(hook({ level: "error", scope: "automation" })).toMatchObject({ level: "error" });
  });
});
