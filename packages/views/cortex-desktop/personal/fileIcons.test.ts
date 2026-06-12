import { describe, expect, it } from "vitest";
import { fileIconSpec, isBinaryLike } from "./fileIcons";

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
