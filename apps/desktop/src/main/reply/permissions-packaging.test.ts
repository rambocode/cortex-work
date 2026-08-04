import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const builderConfigPath = fileURLToPath(new URL("../../../electron-builder.yml", import.meta.url));

describe("reply macOS 权限打包配置", () => {
  it("声明日历与语音识别用途描述，否则系统不会把 Cortex 正常列入授权面板", () => {
    const raw = readFileSync(builderConfigPath, "utf8");

    expect(raw).toContain("NSCalendarsUsageDescription");
    expect(raw).toContain("NSCalendarsFullAccessUsageDescription");
    expect(raw).toContain("NSSpeechRecognitionUsageDescription");
  });

  // 产品现在会经 create_calendar_event 写入系统日历。用途描述若还停留在「只读忙碌时间」，
  // 就是描述与实际行为不符（审核与用户信任问题）。这条测试防止后来者改回只读措辞。
  it("日历用途描述覆盖写入语义", () => {
    const raw = readFileSync(builderConfigPath, "utf8");
    const lines = raw
      .split("\n")
      .filter((l) => l.includes("NSCalendars") && l.includes("UsageDescription:"));

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/创建日程/);
    }
  });
});
