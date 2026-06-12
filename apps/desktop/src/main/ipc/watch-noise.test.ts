import { describe, expect, it } from "vitest";
import { isNoisyChange } from "./watch-noise";

describe("isNoisyChange", () => {
  it("构建/依赖/系统目录视为噪声", () => {
    expect(isNoisyChange(".git/index")).toBe(true);
    expect(isNoisyChange("node_modules/x/y.js")).toBe(true);
    expect(isNoisyChange("packages/app/dist/main.js")).toBe(true);
    expect(isNoisyChange(".DS_Store")).toBe(true);
    expect(isNoisyChange("src/.DS_Store")).toBe(true);
  });

  it("编辑器临时文件视为噪声", () => {
    expect(isNoisyChange("src/a.ts.swp")).toBe(true);
    expect(isNoisyChange("src/a.ts~")).toBe(true);
    expect(isNoisyChange(".com.apple.foo")).toBe(true);
  });

  it("正常源码变更不是噪声", () => {
    expect(isNoisyChange("src/a.ts")).toBe(false);
    expect(isNoisyChange("README.md")).toBe(false);
    expect(isNoisyChange("tasks/2026-06-12-x.md")).toBe(false);
  });

  it("filename 为空时不算噪声（宁可多刷一次）", () => {
    expect(isNoisyChange(null)).toBe(false);
    expect(isNoisyChange("")).toBe(false);
  });
});
