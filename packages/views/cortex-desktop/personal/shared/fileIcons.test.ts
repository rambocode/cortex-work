import { describe, expect, it } from "vitest";
import {
  fileIconSpec,
  inAppDocumentKind,
  isBinaryLike,
  isDocxLike,
  isOpenExternalLike,
  isSpreadsheetLike,
} from "./fileIcons";

describe("fileIconSpec 扩展名映射", () => {
  it("代码族返回品牌色徽章", () => {
    expect(fileIconSpec("main.ts")).toMatchObject({ shape: "badge", label: "TS", bg: "#3178C6" });
    expect(fileIconSpec("app.js")).toMatchObject({ shape: "badge", label: "JS", bg: "#F0DB4F" });
    expect(fileIconSpec("server.go")).toMatchObject({ shape: "badge", label: "GO" });
    expect(fileIconSpec("run.py")).toMatchObject({ shape: "badge", label: "PY" });
  });

  it("文档族返回折角页面", () => {
    expect(fileIconSpec("README.md")).toMatchObject({ shape: "doc", label: "MD" });
    expect(fileIconSpec("config.json")).toMatchObject({ shape: "doc", label: "{ }" });
    expect(fileIconSpec("ci.yaml")).toMatchObject({ shape: "doc" });
  });

  it("图片 / 压缩包族", () => {
    expect(fileIconSpec("logo.png")).toMatchObject({ shape: "image" });
    expect(fileIconSpec("photo.JPEG")).toMatchObject({ shape: "image" });
    expect(fileIconSpec("dist.zip")).toMatchObject({ shape: "archive" });
  });

  it("无扩展名特殊文件按全名匹配", () => {
    expect(fileIconSpec("Dockerfile")).toMatchObject({ shape: "badge" });
    expect(fileIconSpec("Makefile")).toMatchObject({ shape: "badge" });
    expect(fileIconSpec("go.mod")).toMatchObject({ shape: "badge", label: "GO" });
  });

  it("大小写不敏感", () => {
    expect(fileIconSpec("X.PNG")).toMatchObject({ shape: "image" });
    expect(fileIconSpec("Y.Ts")).toMatchObject({ shape: "badge", label: "TS" });
  });

  it("未知扩展名回退 null（调用方用通用文件图标）", () => {
    expect(fileIconSpec("a.zzz")).toBeNull();
    expect(fileIconSpec("noext")).toBeNull();
  });
});

describe("isBinaryLike", () => {
  it("图片 / 压缩包 / 媒体视为二进制", () => {
    expect(isBinaryLike("a.png")).toBe(true);
    expect(isBinaryLike("a.zip")).toBe(true);
    expect(isBinaryLike("a.mp4")).toBe(true);
  });
  it("文本 / 代码不是二进制", () => {
    expect(isBinaryLike("a.ts")).toBe(false);
    expect(isBinaryLike("a.md")).toBe(false);
    expect(isBinaryLike("Dockerfile")).toBe(false);
  });
});

describe("isOpenExternalLike", () => {
  it("office 文档 / pdf / 媒体 / 二进制 → 交系统默认应用打开", () => {
    expect(isOpenExternalLike("report.docx")).toBe(true);
    expect(isOpenExternalLike("slides.pptx")).toBe(true);
    expect(isOpenExternalLike("doc.pdf")).toBe(true);
    expect(isOpenExternalLike("logo.png")).toBe(true);
    expect(isOpenExternalLike("dist.zip")).toBe(true);
    expect(isOpenExternalLike("data.sqlite")).toBe(true);
    // .xls 老二进制格式:内置表格不接管(写回支持差),仍走系统打开。
    expect(isOpenExternalLike("legacy.xls")).toBe(true);
  });
  it("文本 / 代码 / 可内置打开的文本文档 → 不外部打开(走内置编辑器)", () => {
    expect(isOpenExternalLike("a.ts")).toBe(false);
    expect(isOpenExternalLike("a.md")).toBe(false);
    expect(isOpenExternalLike("a.csv")).toBe(false);
    expect(isOpenExternalLike("a.json")).toBe(false);
    expect(isOpenExternalLike("a.svg")).toBe(false);
    expect(isOpenExternalLike("Dockerfile")).toBe(false);
  });
  it("xlsx 有内置表格预览 → 不再交系统打开", () => {
    expect(isOpenExternalLike("monthly.xlsx")).toBe(false);
  });
});

describe("isSpreadsheetLike", () => {
  it("xlsx/csv 进内置表格预览;xls 与其它类型不进", () => {
    expect(isSpreadsheetLike("a.xlsx")).toBe(true);
    expect(isSpreadsheetLike("A.XLSX")).toBe(true);
    expect(isSpreadsheetLike("a.csv")).toBe(true);
    expect(isSpreadsheetLike("a.xls")).toBe(false);
    expect(isSpreadsheetLike("a.ts")).toBe(false);
  });
});

describe("isDocxLike", () => {
  it("仅现代 Word .docx 进入内置预览", () => {
    expect(isDocxLike("report.docx")).toBe(true);
    expect(isDocxLike("REPORT.DOCX")).toBe(true);
    expect(isDocxLike("legacy.doc")).toBe(false);
    expect(isDocxLike("slides.pptx")).toBe(false);
  });
});

describe("inAppDocumentKind", () => {
  it("识别可在应用内预览的现代文档格式", () => {
    expect(inAppDocumentKind("report.docx")).toBe("docx");
    expect(inAppDocumentKind("REPORT.PDF")).toBe("pdf");
    expect(inAppDocumentKind("slides.pptx")).toBe("pptx");
    expect(inAppDocumentKind("legacy.doc")).toBeNull();
    expect(inAppDocumentKind("legacy.ppt")).toBeNull();
  });
});
