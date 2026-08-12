import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  markdownLivePreviewTestInternals,
  writeMarkdownSourceExtensions,
} from "./markdownLivePreview";
import { highlightingFor } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { renderFallbackCodeHtml } from "./markdownLiveWidgets";

// 信任边界回归(code-review:security):代码块渲染前必须转义,防止 note 正文注入 HTML/脚本。
describe("renderFallbackCodeHtml 转义", () => {
  it("转义 < > & 防止注入,不产生真实标签", () => {
    const html = renderFallbackCodeHtml('</code><img src=x onerror=alert(1)><script>bad()</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("markdown live preview", () => {
  // 抖动回归:非空选区必须与空 caret 一样揭示触及行。若改回「非空选区隐藏一切」,
  // 拖拽选择时 conceal 状态会在空↔非空选区间振荡,行内宽度来回变化导致无法精准选中。
  it("reveals source on lines touched by a non-empty selection", () => {
    const state = EditorState.create({
      doc: "**Bold** text",
      selection: EditorSelection.range(2, 6),
    });

    const lines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, true);

    expect([...lines]).toEqual([1]);
  });

  it("reveals every line a multi-line selection touches", () => {
    const state = EditorState.create({
      doc: "**Bold** text\nsecond *em* line\nthird line",
      selection: EditorSelection.range(4, 20),
    });

    const lines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, true);
    const blurredLines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, false);

    expect([...lines].sort()).toEqual([1, 2]);
    // 失焦时即便有选区也全部渲染成品(原有行为不变)。
    expect(blurredLines.size).toBe(0);
  });

  it("reveals source marks on the caret line only when the editor is focused", () => {
    const state = EditorState.create({
      doc: "**Bold** text",
      selection: EditorSelection.cursor(4),
    });

    const focusedLines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, true);
    const blurredLines = markdownLivePreviewTestInternals.collectRevealLinesFromState(state, false);

    expect([...focusedLines]).toEqual([1]);
    expect(blurredLines.size).toBe(0);
  });

  it("does not treat a visible closing fence as a new code block opener", () => {
    const state = EditorState.create({
      doc: ["```python", 'python("hello world")', "```", "", "呀", "nihao"].join("\n"),
    });
    const closingFence = state.doc.line(3);

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      closingFence.from,
      state.doc.length,
      new Set(),
    );

    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      from: state.doc.line(1).from,
      to: closingFence.to,
      block: {
        language: "python",
        code: 'python("hello world")',
      },
    });
  });

  it("does not leak code block ranges into following prose", () => {
    const state = EditorState.create({
      doc: ["```python", 'python("hello world")', "```", "", "呀", "nihao"].join("\n"),
    });
    const proseLine = state.doc.line(5);

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      proseLine.from,
      state.doc.length,
      new Set(),
    );

    expect(ranges).toHaveLength(0);
  });

  it("keeps prose between adjacent language-less fences out of code blocks", () => {
    const state = EditorState.create({
      doc: [
        "现代文本补全几乎全部基于**自回归语言模型**。",
        "",
        "```",
        "P(w1, w2, ..., wn) = ∏ P(wt | w1, w2, ..., wt-1)",
        "```",
        "",
        "你好",
        "",
        "```",
        "输入: [我] [爱] [深] [度] [学] [习]",
        "掩码: 1 0 0 0 0 0",
        "```",
      ].join("\n"),
    });
    const firstClosingFence = state.doc.line(5);

    const ranges = markdownLivePreviewTestInternals.collectMarkdownCodeBlockRangesFromState(
      state,
      firstClosingFence.from,
      state.doc.length,
      new Set(),
    );

    expect(ranges).toHaveLength(2);
    expect(ranges.map((range) => range.block)).toEqual([
      {
        language: "",
        code: "P(w1, w2, ..., wn) = ∏ P(wt | w1, w2, ..., wt-1)",
      },
      {
        language: "",
        code: "输入: [我] [爱] [深] [度] [学] [习]\n掩码: 1 0 0 0 0 0",
      },
    ]);
  });

  // 剥离后:仅远程 / data URI 内联渲染,本地相对路径退化为普通文本(返回 null,KTD6)。
  it("inlines remote and data-uri images, degrades local paths to null", () => {
    expect(
      markdownLivePreviewTestInternals.markdownImageFromSource("![logo](https://example.com/a.png)"),
    ).toEqual({ alt: "logo", src: "https://example.com/a.png" });

    expect(
      markdownLivePreviewTestInternals.markdownImageFromSource("![](data:image/png;base64,aGVybw==)"),
    ).toEqual({ alt: "", src: "data:image/png;base64,aGVybw==" });

    // 本地相对路径 → null(交由普通 markdown 文本渲染,不接 workspace 图片解析)。
    expect(markdownLivePreviewTestInternals.markdownImageFromSource("![hero](img/hero.png)")).toBeNull();
    expect(markdownLivePreviewTestInternals.markdownImageFromSource("not an image")).toBeNull();
  });
});


// 源码模式着色:标题走品牌紫(--accent),`#` 作为标题子节点继承同色;
// 列表/引用等同属 processingInstruction 的记号不在标题内,不应被染色。
describe("源码模式 markdown 着色", () => {
  const state = EditorState.create({
    doc: "# 标题\n- 列表项\n",
    extensions: [markdown({ base: markdownLanguage }), writeMarkdownSourceExtensions()],
  });

  it("标题标签有着色类,普通正文没有", () => {
    expect(highlightingFor(state, [tags.heading1])).toBeTruthy();
    expect(highlightingFor(state, [tags.heading3])).toBeTruthy();
    expect(highlightingFor(state, [tags.content])).toBeFalsy();
  });

  it("不给 processingInstruction 单独配色(否则列表/引用记号会被一起染紫)", () => {
    expect(highlightingFor(state, [tags.processingInstruction])).toBeFalsy();
  });
});
