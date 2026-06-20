import { describe, it, expect } from "vitest";
import { extractSection } from "./extract-release-notes.mjs";

const CHANGELOG = `# 更新日志

## [0.2.0] - 2026-07-01

- 新增更新内容弹窗
- 修复 A

## 0.1.9

- 关闭自动下载

## [0.1.8]

- 首个版本
`;

describe("extractSection", () => {
  it("提取中间版本段,不含相邻版本", () => {
    const out = extractSection(CHANGELOG, "0.2.0");
    expect(out).toContain("新增更新内容弹窗");
    expect(out).toContain("修复 A");
    expect(out).not.toContain("关闭自动下载");
    expect(out).not.toContain("0.1.9");
  });

  it("标题三种写法均命中：`## [x] - date` / `## x` / `## [x]`", () => {
    expect(extractSection(CHANGELOG, "0.2.0")).toContain("新增更新内容弹窗"); // ## [x] - date
    expect(extractSection(CHANGELOG, "0.1.9")).toContain("关闭自动下载"); // ## x
    expect(extractSection(CHANGELOG, "0.1.8")).toContain("首个版本"); // ## [x]
  });

  it("末个版本段提取到文件结尾", () => {
    expect(extractSection(CHANGELOG, "0.1.8")).toBe("- 首个版本");
  });

  it("版本号前缀不误命中（0.1.8 不匹配 0.1.80）", () => {
    const cl = "## [0.1.80]\n\n- 别的版本\n";
    expect(extractSection(cl, "0.1.8")).toBeNull();
  });

  it("缺段返回 null", () => {
    expect(extractSection(CHANGELOG, "9.9.9")).toBeNull();
  });
});
