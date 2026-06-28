import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// electron-log / electron / 依赖模块整体 mock：logger.ts 现在是 electron-log 之上的契约层，
// 这里验证 logLine 路由到对应级别、setLogEnabled 映射文件 transport 级别、纯函数行为。
const { logFns } = vi.hoisted(() => ({
  logFns: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
    initialize: vi.fn(),
    scope: vi.fn((n: string) => ({ name: n })),
    functions: {},
    hooks: [] as unknown[],
    transports: { file: { level: "debug" as unknown, maxSize: 0, transforms: [] }, console: { level: "debug" as unknown } },
  },
}));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() },
}));
vi.mock("./paths", () => ({ logsDir: () => "/fake/logs" }));
vi.mock("./ipc/store", () => ({ getPersistedState: vi.fn(async () => ({ generalSettings: { log: { enabled: true, retentionDays: 2 } } })) }));
vi.mock("electron-log/main", () => ({ default: logFns }));

import { cleanupOldLogs, logFileName, logLine, redactSensitive, setLogEnabled } from "./logger";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cortex-logs-"));
  logFns.error.mockClear();
  logFns.warn.mockClear();
  logFns.info.mockClear();
  logFns.debug.mockClear();
  logFns.transports.file.level = "debug";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("redactSensitive（再导出 redactString）", () => {
  it("脱敏 apiKey / token 的值", () => {
    expect(redactSensitive('apiKey: "sk-secret123"')).toContain("***");
    expect(redactSensitive("token=abc.def")).toContain("***");
  });
  it("普通文本不动", () => {
    expect(redactSensitive("hello world")).toBe("hello world");
  });
});

describe("logFileName", () => {
  it("按本地日期生成 YYYY-MM-DD.log", () => {
    expect(logFileName(new Date(2026, 5, 14))).toBe("2026-06-14.log");
  });
});

describe("logLine", () => {
  it("按 level 路由到 electron-log 对应方法", () => {
    logLine("error", "boom");
    logLine("warn", "careful");
    logLine("debug", "trace");
    expect(logFns.error).toHaveBeenCalledWith("boom");
    expect(logFns.warn).toHaveBeenCalledWith("careful");
    expect(logFns.debug).toHaveBeenCalledWith("trace");
  });
  it("非法 level 回退 info", () => {
    logLine("bogus", "x");
    expect(logFns.info).toHaveBeenCalledWith("x");
  });
});

describe("setLogEnabled", () => {
  it("关=文件 transport 级别置 false", () => {
    setLogEnabled(false);
    expect(logFns.transports.file.level).toBe(false);
  });
  it("开=恢复 dev 级别 debug", () => {
    setLogEnabled(false);
    setLogEnabled(true);
    expect(logFns.transports.file.level).toBe("debug");
  });
});

describe("cleanupOldLogs", () => {
  it("删除超过保留天数的 .log,保留期内留存", () => {
    const now = Date.UTC(2026, 5, 14);
    const day = 24 * 60 * 60 * 1000;
    const old = join(dir, "2026-06-08.log");
    const fresh = join(dir, "2026-06-13.log");
    writeFileSync(old, "x");
    writeFileSync(fresh, "y");
    utimesSync(old, new Date(now - 5 * day), new Date(now - 5 * day));
    utimesSync(fresh, new Date(now - 1 * day), new Date(now - 1 * day));
    cleanupOldLogs(dir, 2, now);
    const left = readdirSync(dir);
    expect(left).toContain("2026-06-13.log");
    expect(left).not.toContain("2026-06-08.log");
  });
});
