import { describe, expect, it } from "vitest";

import {
  chunkPagedText,
  chunkPlainText,
  chunkStructuredText,
  normalizeExtractedText,
  type ChunkDraft,
} from "./chunking";

/// offset 往返一致性：这是「引用可回溯」的根基，任何切块函数都必须满足。
function expectOffsetRoundTrip(source: string, chunks: ChunkDraft[]): void {
  for (const chunk of chunks) {
    expect(source.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    expect(chunk.startOffset).toBeLessThan(chunk.endOffset);
  }
}

describe("normalizeExtractedText", () => {
  it.each([
    ["统一 CRLF 换行", "a\r\nb\rc", "a\nb\nc"],
    ["\u53bb\u96f6\u5bbd\u5b57\u7b26", "a\u200Bb\uFEFFc", "abc"],
    ["折叠行内连续空白", "a   \t  b", "a b"],
    ["3 个以上换行压成一个空行", "a\n\n\n\n\nb", "a\n\nb"],
    ["去掉行尾行首空白", "a  \n   b", "a\nb"],
    ["首尾整体 trim", "  \n hello \n  ", "hello"],
    ["空白输入归零", "   \n\n\t ", ""],
    ["保留单个空行的段落边界", "p1\n\np2", "p1\n\np2"],
  ])("%s", (_name, raw, expected) => {
    expect(normalizeExtractedText(raw)).toBe(expected);
  });

  it("是幂等的", () => {
    const raw = "标题\r\n\r\n\r\n正文   有   空白​。\n\n\n下一段";
    const once = normalizeExtractedText(raw);
    expect(normalizeExtractedText(once)).toBe(once);
  });
});

describe("chunkPlainText", () => {
  it("按段落边界切分并保持 offset 往返一致", () => {
    const p1 = "A".repeat(600);
    const p2 = "B".repeat(600);
    const p3 = "C".repeat(600);
    const text = `${p1}\n\n${p2}\n\n${p3}`;

    const chunks = chunkPlainText(text);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.text)).toEqual([p1, p2, p3]);
    expectOffsetRoundTrip(text, chunks);
  });

  it("合并相邻小段落直到接近 maxChars", () => {
    const text = "一段。\n\n二段。\n\n三段。";
    const chunks = chunkPlainText(text, { minChars: 1 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expectOffsetRoundTrip(text, chunks);
  });

  it("超长无段落文本被强切成多块", () => {
    const text = "字".repeat(2500);
    const chunks = chunkPlainText(text, { maxChars: 1000 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1000);
    }
    expectOffsetRoundTrip(text, chunks);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("中英混排在空白处优先断开，且不丢字符", () => {
    const sentence = "Cortex Research Engine 是一个本地优先的研究编排层。";
    const text = sentence.repeat(60);
    const chunks = chunkPlainText(text, { maxChars: 200 });

    expectOffsetRoundTrip(text, chunks);
    // 断点只允许落在空白上：把块拼回去后，仅可能少掉断点处的空白
    const rejoined = chunks.map((c) => c.text).join(" ");
    expect(rejoined.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("小于 minChars 的尾部碎片并入前一块", () => {
    const big = "甲".repeat(880);
    const tail = "尾巴";
    const text = `${big}\n\n${tail}`;
    const chunks = chunkPlainText(text, { maxChars: 900, minChars: 48 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expectOffsetRoundTrip(text, chunks);
  });

  it("没有前一块的短碎片被丢弃", () => {
    expect(chunkPlainText("短", { minChars: 48 })).toEqual([]);
    expect(chunkPlainText("a")).toEqual([]);
  });

  it.each([
    ["空字符串", ""],
    ["纯空白", "   \n\n\t  "],
    ["纯换行", "\n\n\n"],
  ])("%s 返回空数组", (_name, input) => {
    expect(chunkPlainText(input)).toEqual([]);
  });

  it("overlapChars 让后续块向前重叠且仍满足 offset 往返", () => {
    const text = "字".repeat(2000);
    const chunks = chunkPlainText(text, { maxChars: 500, overlapChars: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    expectOffsetRoundTrip(text, chunks);
    expect(chunks[1]!.startOffset).toBe(chunks[0]!.endOffset - 50);
  });

  it("plain 模式下 headingPath 为空数组", () => {
    const chunks = chunkPlainText("这是一段足够长的正文内容，用来产生一个正常的块。".repeat(4));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual([]);
      expect(chunk.page).toBeUndefined();
    }
  });
});

describe("chunkStructuredText", () => {
  // 四段正文各带唯一标记，方便按标记定位「这段正文落在哪个块」。
  const bodyOf = (marker: string): string => `${marker}正文`.repeat(20);
  const bodyA = bodyOf("甲");
  const bodyB = bodyOf("乙");
  const bodyC = bodyOf("丙");
  const bodyD = bodyOf("丁");

  const text = [
    `# 一级标题\n\n${bodyA}`,
    `## 二级标题\n\n${bodyB}`,
    `### 三级标题\n\n${bodyC}`,
    `## 另一个二级\n\n${bodyD}`,
  ].join("\n\n");

  const headings = [
    { offset: text.indexOf("# 一级标题"), level: 1, title: "一级标题" },
    { offset: text.indexOf("## 二级标题"), level: 2, title: "二级标题" },
    { offset: text.indexOf("### 三级标题"), level: 3, title: "三级标题" },
    { offset: text.indexOf("## 另一个二级"), level: 2, title: "另一个二级" },
  ];

  const pathOf = (chunks: ChunkDraft[], needle: string): string[] | undefined => {
    const offset = text.indexOf(needle);
    return chunks.find((c) => c.startOffset <= offset && offset < c.endOffset)?.headingPath;
  };

  it("为每块计算所处的 heading 层级路径", () => {
    const chunks = chunkStructuredText({ text, headings }, { maxChars: 120 });

    expectOffsetRoundTrip(text, chunks);
    expect(pathOf(chunks, bodyA)).toEqual(["一级标题"]);
    expect(pathOf(chunks, bodyB)).toEqual(["一级标题", "二级标题"]);
    expect(pathOf(chunks, bodyC)).toEqual(["一级标题", "二级标题", "三级标题"]);
    // 回到二级时必须弹出三级，而不是越堆越深
    expect(pathOf(chunks, bodyD)).toEqual(["一级标题", "另一个二级"]);
  });

  it("首个标题之前的块 headingPath 为空", () => {
    const preface = "前言".repeat(60);
    const withPreface = `${preface}\n\n# 标题\n\n${bodyA}`;
    const chunks = chunkStructuredText(
      {
        text: withPreface,
        headings: [{ offset: withPreface.indexOf("# 标题"), level: 1, title: "标题" }],
      },
      { maxChars: 120 },
    );

    expect(chunks[0]!.headingPath).toEqual([]);
    expectOffsetRoundTrip(withPreface, chunks);
  });

  it("没有 heading 时等价于 chunkPlainText", () => {
    expect(chunkStructuredText({ text, headings: [] }, { maxChars: 120 })).toEqual(
      chunkPlainText(text, { maxChars: 120 }),
    );
  });

  it("乱序 heading 也能得到正确层级", () => {
    const chunks = chunkStructuredText(
      { text, headings: [...headings].reverse() },
      { maxChars: 120 },
    );
    expect(pathOf(chunks, bodyC)).toEqual(["一级标题", "二级标题", "三级标题"]);
  });
});

describe("chunkPagedText", () => {
  it("每块带页码，offset 相对该页文本", () => {
    const pageOne = "第一页正文".repeat(40);
    const pageTwo = "第二页正文".repeat(40);
    const chunks = chunkPagedText(
      [
        { page: 1, text: pageOne },
        { page: 2, text: pageTwo },
      ],
      { maxChars: 120 },
    );

    expect(chunks.some((c) => c.page === 1)).toBe(true);
    expect(chunks.some((c) => c.page === 2)).toBe(true);

    expectOffsetRoundTrip(pageOne, chunks.filter((c) => c.page === 1));
    expectOffsetRoundTrip(pageTwo, chunks.filter((c) => c.page === 2));
  });

  it("跳过空白页", () => {
    const chunks = chunkPagedText([
      { page: 1, text: "   \n\n " },
      { page: 2, text: "有效正文内容".repeat(20) },
    ]);
    expect(chunks.every((c) => c.page === 2)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
