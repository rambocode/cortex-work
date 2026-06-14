import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendLog, cleanupOldLogs, logFileName, redactSensitive } from "./logger";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cortex-logs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("redactSensitive", () => {
  it("脱敏 apiKey / token / secret 的值", () => {
    expect(redactSensitive('apiKey: "sk-secret123"')).not.toContain("sk-secret123");
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

describe("appendLog", () => {
  it("写入 logs/<date>.log 含级别与消息", () => {
    const d = new Date(2026, 5, 14, 10);
    appendLog(dir, true, "info", "启动", d);
    expect(readFileSync(join(dir, logFileName(d)), "utf8")).toContain("[info] 启动");
  });
  it("on=false 不写文件", () => {
    appendLog(dir, false, "info", "x", new Date(2026, 5, 14));
    expect(readdirSync(dir)).toEqual([]);
  });
  it("写入时对敏感字段脱敏", () => {
    const d = new Date(2026, 5, 14);
    appendLog(dir, true, "error", 'apiKey="sk-xyz"', d);
    expect(readFileSync(join(dir, logFileName(d)), "utf8")).not.toContain("sk-xyz");
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
