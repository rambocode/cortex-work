import { beforeEach, describe, expect, it, vi } from "vitest";

// electron / electron-log 在测试环境整体 mock：app.isPackaged 控制 dev/prod 分支，
// electron-log 用一个可断言的桩，验证 initLog 的接线（transport 级别、resolvePathFn、
// console 接管）。
let isPackaged = false;
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return isPackaged;
    },
  },
}));

vi.mock("../paths", () => ({
  logsDir: () => "/fake/logs",
}));

// electron-log 桩：scope 返回带 functions 的对象，transports 可被 initLog 写入。
// 用 vi.hoisted 提升到 mock 工厂之前，避免「mock 工厂引用顶层变量」的初始化顺序错误。
const { initializeMock, scopeFns, scopeMock, logStub } = vi.hoisted(() => {
  const initializeMock = vi.fn();
  const scopeFns = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
    log: vi.fn(),
  };
  const scopeMock = vi.fn((name: string) => ({ ...scopeFns, name })) as unknown as {
    (name: string): unknown;
    labelPadding: boolean;
  };
  scopeMock.labelPadding = true;
  const logStub = {
    initialize: initializeMock,
    scope: scopeMock,
    functions: scopeFns,
    transports: {
      file: {
        resolvePathFn: undefined as unknown,
        maxSize: 1048576,
        level: "silly" as unknown,
        // 用两个占位内置 transform 模拟真实 electron-log 的 [removeStyles, ..., toString]
        // 顺序，验证脱敏 transform 是 unshift 到最前而非 push 到末尾。
        transforms: [
          () => "builtin-placeholder",
        ] as Array<(arg: { data: unknown[] }) => unknown>,
      },
      console: { level: "silly" as unknown },
    },
  };
  return { initializeMock, scopeFns, scopeMock, logStub };
});
vi.mock("electron-log/main", () => ({ default: logStub }));

import {
  consoleLevelFor,
  createLogger,
  fileLevelFor,
  initLog,
  isDevEnv,
  resolveLogFilePath,
} from "./index";

beforeEach(() => {
  isPackaged = false;
  initializeMock.mockClear();
  (scopeMock as unknown as { mockClear: () => void }).mockClear();
  logStub.transports.file.resolvePathFn = undefined;
  logStub.transports.file.maxSize = 1048576;
  logStub.transports.file.level = "silly";
  logStub.transports.console.level = "silly";
  logStub.transports.file.transforms = [() => "builtin-placeholder"];
});

describe("resolveLogFilePath", () => {
  it("按天生成 cortex-YYYY-MM-DD.log", () => {
    expect(resolveLogFilePath("/logs", new Date(2026, 5, 8))).toBe("/logs/cortex-2026-06-08.log");
  });
});

describe("级别决策", () => {
  it("dev 文件落 debug、控制台 debug", () => {
    expect(fileLevelFor(true)).toBe("debug");
    expect(consoleLevelFor(true)).toBe("debug");
  });
  it("prod 文件落 info、控制台关闭", () => {
    expect(fileLevelFor(false)).toBe("info");
    expect(consoleLevelFor(false)).toBe(false);
  });
});

describe("isDevEnv", () => {
  it("未打包视为 dev", () => {
    isPackaged = false;
    expect(isDevEnv()).toBe(true);
  });
  it("已打包视为 prod", () => {
    isPackaged = true;
    expect(isDevEnv()).toBe(false);
  });
});

describe("createLogger", () => {
  it("返回 electron-log 的 scoped logger", () => {
    createLogger("cli");
    expect(scopeMock).toHaveBeenCalledWith("cli");
  });
});

describe("initLog", () => {
  // 测试间共享同一 logStub，且 initLog 内部 initialized 标志为模块级 —— 用动态 import
  // 隔离会更彻底，但此处通过断言「首调用接线、再调用幂等」覆盖关键行为。
  it("接线 transport：resolvePathFn 按天、maxSize=0、dev 级别", () => {
    initLog();
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(logStub.transports.file.maxSize).toBe(0);
    expect(logStub.transports.file.level).toBe("debug");
    expect(logStub.transports.console.level).toBe("debug");
    expect(typeof logStub.transports.file.resolvePathFn).toBe("function");
    const p = (logStub.transports.file.resolvePathFn as () => string)();
    expect(p).toMatch(/\/fake\/logs\/cortex-\d{4}-\d{2}-\d{2}\.log$/);

    // 脱敏 transform 必须排在内置 transforms 最前面（unshift 而非 push）：内置的最后一步
    // 会把 data 数组拼成字符串，若脱敏排在其后对字符串调 .map 会抛错（见 index.ts 注释）。
    expect(logStub.transports.file.transforms.length).toBe(2);
    const redactTransform = logStub.transports.file.transforms[0];
    expect(redactTransform({ data: ["hello", "token=abc123"] })).toEqual(["hello", "token=***"]);
  });

  it("幂等：重复调用不重复 initialize", () => {
    const before = initializeMock.mock.calls.length;
    initLog();
    expect(initializeMock.mock.calls.length).toBe(before);
  });

  it("接管 console：console.log 指向 electron-log 管线", () => {
    initLog();
    // initLog 已在前面的用例执行过（幂等），console 已被 Object.assign 接管。
    expect(console.log).toBe(scopeFns.log);
    expect(console.error).toBe(scopeFns.error);
  });
});
