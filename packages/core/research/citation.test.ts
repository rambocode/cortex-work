import { describe, expect, it } from "vitest";

import { collectCitedChunkIds, stripAllCitations, validateCitations } from "./citation";

const FENCE = "```";

describe("validateCitations", () => {
  it("全部合法引用时原样保留", () => {
    const markdown = "地球是圆的[^c1]。\n\n月亮绕地球[^c2]。";
    const result = validateCitations({ markdown, knownChunkIds: ["c1", "c2"] });

    expect(result.markdown).toBe(markdown);
    expect(result.removedChunkIds).toEqual([]);
    expect(result.citedChunkIds).toEqual(["c1", "c2"]);
    expect(result.unsupportedSpans).toEqual([]);
  });

  it("全部非法引用时全部删除，并把事实段标为 unsupported", () => {
    const markdown = "地球是圆的[^ghost1]。\n\n月亮绕地球[^ghost2]。";
    const result = validateCitations({ markdown, knownChunkIds: new Set<string>() });

    expect(result.markdown).toBe("地球是圆的。\n\n月亮绕地球。");
    expect(result.removedChunkIds).toEqual(["ghost1", "ghost2"]);
    expect(result.citedChunkIds).toEqual([]);
    expect(result.unsupportedSpans).toHaveLength(2);
    for (const span of result.unsupportedSpans) {
      expect(result.markdown.slice(span.start, span.end)).toBe(span.text);
    }
    expect(result.unsupportedSpans.map((s) => s.text)).toEqual(["地球是圆的。", "月亮绕地球。"]);
  });

  it("混合引用只删非法的，合法段不被标 unsupported", () => {
    const markdown = "第一句是真的[^c1]。\n\n第二句是编的[^fake]。";
    const result = validateCitations({ markdown, knownChunkIds: ["c1"] });

    expect(result.markdown).toBe("第一句是真的[^c1]。\n\n第二句是编的。");
    expect(result.removedChunkIds).toEqual(["fake"]);
    expect(result.citedChunkIds).toEqual(["c1"]);
    expect(result.unsupportedSpans.map((s) => s.text)).toEqual(["第二句是编的。"]);
  });

  it("同一段里同时有合法与非法引用时该段仍算有支撑", () => {
    const markdown = "一句话有两个引用[^c1][^fake]。";
    const result = validateCitations({ markdown, knownChunkIds: ["c1"] });

    expect(result.markdown).toBe("一句话有两个引用[^c1]。");
    expect(result.removedChunkIds).toEqual(["fake"]);
    expect(result.unsupportedSpans).toEqual([]);
  });

  it("同一 chunkId 重复引用只在 citedChunkIds 出现一次", () => {
    const markdown = "甲[^c1]。乙也[^c1]。\n\n丙[^c2] 与 [^c1]。";
    const result = validateCitations({ markdown, knownChunkIds: ["c1", "c2"] });

    expect(result.citedChunkIds).toEqual(["c1", "c2"]);
    expect(result.markdown).toBe(markdown);
  });

  it("重复的非法引用在 removedChunkIds 里去重", () => {
    const markdown = "甲[^x]。乙[^x]。";
    const result = validateCitations({ markdown, knownChunkIds: [] });

    expect(result.removedChunkIds).toEqual(["x"]);
    expect(result.markdown).toBe("甲。乙。");
  });

  it("代码块内的假引用不被当真，也不被删除", () => {
    const markdown = [
      "正文有据[^c1]。",
      [FENCE + "ts", "const a = list[^fake];", FENCE].join("\n"),
      "行内代码 `[^alsoFake]` 也不算。",
    ].join("\n\n");
    const result = validateCitations({ markdown, knownChunkIds: ["c1"] });

    expect(result.markdown).toBe(markdown);
    expect(result.removedChunkIds).toEqual([]);
    expect(result.citedChunkIds).toEqual(["c1"]);
    // 代码块本身不是事实段；含行内代码的那段没有有效引用，应被标 unsupported
    expect(result.unsupportedSpans.map((s) => s.text)).toEqual(["行内代码 `[^alsoFake]` 也不算。"]);
  });

  it("标题、列表、代码块、分隔线都不算事实段", () => {
    const markdown = [
      "# 研究报告",
      "## 小节标题",
      "- 列表项一\n- 列表项二",
      "1. 有序列表项",
      "---",
      [FENCE, "plain code", FENCE].join("\n"),
    ].join("\n\n");
    const result = validateCitations({ markdown, knownChunkIds: [] });

    expect(result.unsupportedSpans).toEqual([]);
    expect(result.markdown).toBe(markdown);
  });

  it("完全没有引用的事实段也算 unsupported", () => {
    const markdown = "# 标题\n\n这是一段没有任何引用的断言。";
    const result = validateCitations({ markdown, knownChunkIds: ["c1"] });

    expect(result.unsupportedSpans.map((s) => s.text)).toEqual(["这是一段没有任何引用的断言。"]);
  });

  it("knownChunkIds 传数组与传 Set 结果一致", () => {
    const markdown = "甲[^c1]。乙[^bad]。";
    const fromArray = validateCitations({ markdown, knownChunkIds: ["c1"] });
    const fromSet = validateCitations({ markdown, knownChunkIds: new Set(["c1"]) });
    expect(fromArray).toEqual(fromSet);
  });

  it.each([
    ["空 markdown", ""],
    ["纯空白", "   \n\n  "],
  ])("%s 不产生任何结果", (_name, markdown) => {
    const result = validateCitations({ markdown, knownChunkIds: ["c1"] });
    expect(result.removedChunkIds).toEqual([]);
    expect(result.citedChunkIds).toEqual([]);
    expect(result.unsupportedSpans).toEqual([]);
  });

  it("删除引用时顺带清理多余空格", () => {
    const result = validateCitations({
      markdown: "见文献 [^a] 与 [^b]，另有说明 [^c]。",
      knownChunkIds: [],
    });
    expect(result.markdown).toBe("见文献 与，另有说明。");
  });
});

describe("stripAllCitations", () => {
  it.each([
    ["行内标记", "地球是圆的[^c1]。", "地球是圆的。"],
    ["多个标记", "甲[^c1]乙[^c2]丙", "甲乙丙"],
    ["空格前的标记", "见文献 [^c1]。", "见文献。"],
    ["无标记原样返回", "普通文本。", "普通文本。"],
  ])("%s", (_name, input, expected) => {
    expect(stripAllCitations(input)).toBe(expected);
  });

  it("不动代码块里的伪标记", () => {
    const markdown = [FENCE, "const a = b[^fake];", FENCE].join("\n");
    expect(stripAllCitations(markdown)).toBe(markdown);
  });
});

describe("collectCitedChunkIds", () => {
  it("去重且保持出现顺序", () => {
    expect(collectCitedChunkIds("A[^c2]B[^c1]C[^c2]D[^c3]")).toEqual(["c2", "c1", "c3"]);
  });

  it("忽略代码块内的伪标记", () => {
    const markdown = ["正文[^c1]", [FENCE, "x[^fake]", FENCE].join("\n")].join("\n\n");
    expect(collectCitedChunkIds(markdown)).toEqual(["c1"]);
  });

  it("没有引用时返回空数组", () => {
    expect(collectCitedChunkIds("纯文本")).toEqual([]);
  });
});
