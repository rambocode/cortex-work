// 写作排版数据模型单测:字体栈解析、行距夹取+snap、预设归一化。
import { describe, it, expect } from "vitest";
import {
  WRITING_LINE_HEIGHT_DEFAULT,
  WRITING_LINE_HEIGHT_MAX,
  WRITING_LINE_HEIGHT_MIN,
  clampWritingLineHeight,
  normalizeWritingFontPreset,
  writingFontStackFor,
} from "./typography";

describe("writing typography", () => {
  it("预设 → 具体字体栈(含中文回退)", () => {
    expect(writingFontStackFor("pingfang", "")).toContain("PingFang SC");
    expect(writingFontStackFor("kaiti", "")).toContain("KaiTi");
    expect(writingFontStackFor("system", "")).toContain("sans-serif");
    // 默认预设:随包思源宋体的 FontFace 注册名居首,系统衬线兜底。
    expect(writingFontStackFor("sourceHanSerif", "")).toContain("Source Han Serif Cortex");
    expect(writingFontStackFor("sourceHanSerif", "")).toContain("serif");
  });

  it("custom:用 customFontFamily;空则回落 system", () => {
    expect(writingFontStackFor("custom", "'LXGW WenKai', serif")).toBe("'LXGW WenKai', serif");
    expect(writingFontStackFor("custom", "   ")).toContain("sans-serif"); // 空 → system
  });

  it("行距夹取到 [1.4,2.2] 并 snap 到 1 位小数;非数值回默认", () => {
    expect(clampWritingLineHeight(1.0)).toBe(WRITING_LINE_HEIGHT_MIN);
    expect(clampWritingLineHeight(9)).toBe(WRITING_LINE_HEIGHT_MAX);
    expect(clampWritingLineHeight(1.83)).toBe(1.8); // snap
    expect(clampWritingLineHeight(undefined)).toBe(WRITING_LINE_HEIGHT_DEFAULT);
    expect(clampWritingLineHeight(Number.NaN)).toBe(WRITING_LINE_HEIGHT_DEFAULT);
  });

  it("预设归一化:非法值 → 当前默认(sourceHanSerif)", () => {
    expect(normalizeWritingFontPreset("kaiti")).toBe("kaiti");
    expect(normalizeWritingFontPreset("system")).toBe("system");
    expect(normalizeWritingFontPreset("nope")).toBe("sourceHanSerif");
    expect(normalizeWritingFontPreset(undefined)).toBe("sourceHanSerif");
  });
});
