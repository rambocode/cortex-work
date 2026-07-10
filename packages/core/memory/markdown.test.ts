// markdown 分区文件格式的往返/剥离测试（契约同 reply memory-files，独立命名空间）。
import { describe, expect, it } from "vitest";
import {
  parseUserMemoryMarkdown,
  renderUserMemoryMarkdown,
  stripUserMemoryComments,
  userMemoryFileTemplate,
  USER_MEMORY_AUTO_MARKER,
} from "./markdown";
import { USER_MEMORY_SCOPES } from "./memory";

describe("parse/render 往返", () => {
  it("标记行上方归 manual、下方归 auto", () => {
    const text = `我是一名前端工程师\n\n${USER_MEMORY_AUTO_MARKER}\n\n- 喜欢用 pnpm`;
    expect(parseUserMemoryMarkdown(text)).toEqual({
      manual: "我是一名前端工程师",
      auto: "- 喜欢用 pnpm",
    });
  });

  it("无标记行时全文归 manual（手动创建的纯笔记文件）", () => {
    expect(parseUserMemoryMarkdown("随手写的内容")).toEqual({ manual: "随手写的内容", auto: "" });
  });

  it("标记行后缀被用户改动仍按前缀识别", () => {
    const text = `手写\n## ⟨auto⟩ 我自己改了说明\n- 要点`;
    expect(parseUserMemoryMarkdown(text)).toEqual({ manual: "手写", auto: "- 要点" });
  });

  it("render → parse 严格往返", () => {
    const file = { manual: "手写内容\n第二行", auto: "- 学到的要点" };
    expect(parseUserMemoryMarkdown(renderUserMemoryMarkdown(file))).toEqual(file);
  });

  it("auto 为空也写标记行，保证往返稳定", () => {
    const rendered = renderUserMemoryMarkdown({ manual: "只有手写", auto: "" });
    expect(rendered).toContain(USER_MEMORY_AUTO_MARKER);
    expect(parseUserMemoryMarkdown(rendered)).toEqual({ manual: "只有手写", auto: "" });
  });
});

describe("模板与注释剥离", () => {
  it("每个分区模板剥离注释后为空（不污染 prompt）", () => {
    for (const scope of USER_MEMORY_SCOPES) {
      const parsed = parseUserMemoryMarkdown(userMemoryFileTemplate(scope));
      expect(stripUserMemoryComments(parsed.manual)).toBe("");
      expect(parsed.auto).toBe("");
    }
  });

  it("剥离 HTML 注释并收敛多余空行", () => {
    const text = "<!-- 引导 -->\n\n\n\n真实内容\n<!-- 尾注 -->";
    expect(stripUserMemoryComments(text)).toBe("真实内容");
  });
});
