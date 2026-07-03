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
});
