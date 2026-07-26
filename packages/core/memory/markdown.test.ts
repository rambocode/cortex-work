// markdown 分区文件格式的往返/剥离测试（契约同 reply memory-files，独立命名空间）。
import { describe, expect, it } from "vitest";
import {
  parseUserMemoryMarkdown,
  renderUserMemoryMarkdown,
  stripUserMemoryComments,
  userMemoryFileTemplate,
  USER_MEMORY_AUTO_MARKER,
  USER_MEMORY_RESEARCH_MARKER,
} from "./markdown";
import { USER_MEMORY_SCOPES } from "./memory";

describe("parse/render 往返", () => {
  it("标记行上方归 manual、下方归 auto", () => {
    const text = `我是一名前端工程师\n\n${USER_MEMORY_AUTO_MARKER}\n\n- 喜欢用 pnpm`;
    expect(parseUserMemoryMarkdown(text)).toEqual({
      manual: "我是一名前端工程师",
      auto: "- 喜欢用 pnpm",
      research: "",
    });
  });

  it("无标记行时全文归 manual（手动创建的纯笔记文件）", () => {
    expect(parseUserMemoryMarkdown("随手写的内容")).toEqual({ manual: "随手写的内容", auto: "", research: "" });
  });

  it("标记行后缀被用户改动仍按前缀识别", () => {
    const text = `手写\n## ⟨auto⟩ 我自己改了说明\n- 要点`;
    expect(parseUserMemoryMarkdown(text)).toEqual({ manual: "手写", auto: "- 要点", research: "" });
  });

  it("render → parse 严格往返", () => {
    const file = { manual: "手写内容\n第二行", auto: "- 学到的要点", research: "" };
    expect(parseUserMemoryMarkdown(renderUserMemoryMarkdown(file))).toEqual(file);
  });

  it("auto 为空也写标记行，保证往返稳定", () => {
    const rendered = renderUserMemoryMarkdown({ manual: "只有手写", auto: "", research: "" });
    expect(rendered).toContain(USER_MEMORY_AUTO_MARKER);
    expect(parseUserMemoryMarkdown(rendered)).toEqual({ manual: "只有手写", auto: "", research: "" });
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

describe("研究记忆区（三段化，spec §14.2）", () => {
  it("三段各归各位", () => {
    const text = [
      "手写内容",
      "",
      USER_MEMORY_AUTO_MARKER,
      "",
      "- 做梦学到的",
      "",
      USER_MEMORY_RESEARCH_MARKER,
      "",
      "- 已批准的研究结论",
    ].join("\n");
    expect(parseUserMemoryMarkdown(text)).toEqual({
      manual: "手写内容",
      auto: "- 做梦学到的",
      research: "- 已批准的研究结论",
    });
  });

  /// 向后兼容硬约束：三段化之前写下的文件只有 auto 一条标记行，
  /// 必须原样读出来而不是把 auto 内容错读成 research。
  it("旧格式文件（只有 auto 标记行）照常解析，research 为空", () => {
    const text = `手写\n\n${USER_MEMORY_AUTO_MARKER}\n\n- 旧的自动要点`;
    expect(parseUserMemoryMarkdown(text)).toEqual({
      manual: "手写",
      auto: "- 旧的自动要点",
      research: "",
    });
  });

  it("用户手工调换了两段顺序时仍各归各位（按标记行先后切段，不假定顺序）", () => {
    const text = [
      "手写",
      "",
      USER_MEMORY_RESEARCH_MARKER,
      "- 研究结论",
      "",
      USER_MEMORY_AUTO_MARKER,
      "- 自动要点",
    ].join("\n");
    expect(parseUserMemoryMarkdown(text)).toEqual({
      manual: "手写",
      auto: "- 自动要点",
      research: "- 研究结论",
    });
  });

  it("research 为空也写标记行，往返稳定", () => {
    const rendered = renderUserMemoryMarkdown({ manual: "只有手写", auto: "", research: "" });
    expect(rendered).toContain(USER_MEMORY_RESEARCH_MARKER);
    expect(parseUserMemoryMarkdown(rendered)).toEqual({
      manual: "只有手写",
      auto: "",
      research: "",
    });
  });

  it("三段都有内容时 render → parse 严格往返", () => {
    const file = { manual: "手写\n第二行", auto: "- 自动", research: "- 研究\n- 第二条" };
    expect(parseUserMemoryMarkdown(renderUserMemoryMarkdown(file))).toEqual(file);
  });

  /// 回归：render 少写一条标记行会让下一次 parse 把两段并成一段。
  it("只有 research 有内容时，auto 标记行仍在且 auto 解析为空", () => {
    const rendered = renderUserMemoryMarkdown({ manual: "", auto: "", research: "- 研究结论" });
    const parsed = parseUserMemoryMarkdown(rendered);
    expect(parsed.auto).toBe("");
    expect(parsed.research).toBe("- 研究结论");
  });
});
