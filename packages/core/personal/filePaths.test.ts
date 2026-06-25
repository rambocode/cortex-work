import { describe, expect, it } from "vitest";
import { isLikelyFilePath, isLocalImagePath, resolveProjectFileRef } from "./filePaths";

describe("isLikelyFilePath", () => {
  it("识别项目内文件路径(正例)", () => {
    expect(isLikelyFilePath("packages/core/personal/messages.ts")).toBe(true);
    expect(isLikelyFilePath("docs/plans/x.md")).toBe(true);
    expect(isLikelyFilePath("src/a.ts")).toBe(true);
    expect(isLikelyFilePath("server/main.go")).toBe(true);
    expect(isLikelyFilePath("package.json")).toBe(true); // 无斜杠但带扩展名
    expect(isLikelyFilePath("src/components")).toBe(true); // 含斜杠的目录
  });

  it("排除非路径文本(反例)", () => {
    expect(isLikelyFilePath("hello world")).toBe(false); // 含空格
    expect(isLikelyFilePath("npm run test")).toBe(false); // 含空格
    expect(isLikelyFilePath("https://example.com")).toBe(false); // URL
    expect(isLikelyFilePath("mailto:a@b.com")).toBe(false); // mailto
    expect(isLikelyFilePath("1.5")).toBe(false); // 版本号
    expect(isLikelyFilePath("1.2.3")).toBe(false); // 版本号
    expect(isLikelyFilePath("e.g.")).toBe(false); // 缩写,尾点
    expect(isLikelyFilePath("README")).toBe(false); // 无扩展无斜杠
    expect(isLikelyFilePath("const x")).toBe(false); // 含空格
    expect(isLikelyFilePath("   ")).toBe(false); // 纯空白
    expect(isLikelyFilePath("")).toBe(false); // 空串
  });
});

describe("isLocalImagePath", () => {
  it("命中位图扩展名(绝对/相对/裸名)", () => {
    expect(isLocalImagePath("/Users/mike/.codex/generated_images/x/ig_a.png")).toBe(true);
    expect(isLocalImagePath("../outputs/photo.JPG")).toBe(true);
    expect(isLocalImagePath(".cortex/media/images/a.jpeg")).toBe(true);
    expect(isLocalImagePath("a.gif")).toBe(true);
    expect(isLocalImagePath("cover.webp")).toBe(true);
  });

  it("排除 svg / 远程图床 / data URI / 非图片", () => {
    expect(isLocalImagePath("/tmp/a.svg")).toBe(false); // svg 不内联(读侧也拒)
    expect(isLocalImagePath("https://cdn.example.com/a.png")).toBe(false); // 远程
    expect(isLocalImagePath("file:///Users/a.png")).toBe(false); // scheme://
    expect(isLocalImagePath("data:image/png;base64,iVBOR")).toBe(false); // data URI
    expect(isLocalImagePath("report.docx")).toBe(false); // 文档
    expect(isLocalImagePath("a.png b.png")).toBe(false); // 含空白
    expect(isLocalImagePath("")).toBe(false);
  });
});

describe("resolveProjectFileRef", () => {
  it("相对路径拼到项目根,within=true", () => {
    expect(resolveProjectFileRef("/proj", "src/a.ts")).toEqual({
      abs: "/proj/src/a.ts",
      name: "a.ts",
      within: true,
    });
  });

  it("绝对路径在项目内,within=true", () => {
    expect(resolveProjectFileRef("/proj", "/proj/src/a.ts")).toEqual({
      abs: "/proj/src/a.ts",
      name: "a.ts",
      within: true,
    });
  });

  it("绝对路径在项目外,within=false", () => {
    expect(resolveProjectFileRef("/proj", "/etc/passwd")).toEqual({
      abs: "/etc/passwd",
      name: "passwd",
      within: false,
    });
  });

  it("相对路径爬出项目,within=false", () => {
    const r = resolveProjectFileRef("/proj", "../../etc/passwd");
    expect(r.abs).toBe("/etc/passwd");
    expect(r.within).toBe(false);
  });

  it("末尾分隔符 / ./ 归一", () => {
    expect(resolveProjectFileRef("/proj/", "./src/a.ts")).toEqual({
      abs: "/proj/src/a.ts",
      name: "a.ts",
      within: true,
    });
  });

  it("前缀误判防护:按分隔符边界匹配,/proj 不误配 /project-other", () => {
    expect(resolveProjectFileRef("/proj", "/project-other/a.ts").within).toBe(false);
  });
});
