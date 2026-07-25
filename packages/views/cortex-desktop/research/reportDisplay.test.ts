// reportDisplay 的展示层约定测试：
// - 与目标重复的标题（h1 / 首个 h2）在展示时剥掉，原始 markdown 不动；
// - [^chunkId] 引用标记转成首次出现顺序的编号链接，尾随的（来源：…）一并收编；
// - 围栏代码块与行内代码里的同形文本绝不转换（与 core/research/citation 的词法约定一致）。
import { describe, expect, it } from "vitest";
import type { CitationRef } from "@cortex-work/core/research/evidence";
import { prepareReportMarkdown } from "./reportDisplay";

/// 造一条 CitationRef。
function makeCitation(chunkId: string, patch: Partial<CitationRef> = {}): CitationRef {
  return {
    chunkId,
    documentId: "d1",
    title: `标题-${chunkId}`,
    url: `https://example.com/${chunkId}`,
    retrievedAt: "2026-07-25T02:30:00.000Z",
    textHash: "th",
    ...patch,
  };
}

describe("prepareReportMarkdown：标题去重", () => {
  it("剥掉与目标完全相同的开头 h1", () => {
    const out = prepareReportMarkdown({
      markdown: "# 调查 Rust 异步运行时\n\n## 现状\n\n正文。",
      objective: "调查 Rust 异步运行时",
      citations: [],
    });
    expect(out.markdown).not.toContain("# 调查 Rust 异步运行时");
    expect(out.markdown).toContain("## 现状");
  });

  it("h1 与目标不同则保留", () => {
    const out = prepareReportMarkdown({
      markdown: "# 不一样的标题\n\n正文。",
      objective: "调查 Rust 异步运行时",
      citations: [],
    });
    expect(out.markdown).toContain("# 不一样的标题");
  });

  it("首个与目标相同的 h2 也剥掉（单子问题与目标同名时 h1/h2 会连着重复）", () => {
    const out = prepareReportMarkdown({
      markdown: "# 调查 A\n\n## 调查 A\n\n正文。",
      objective: "调查 A",
      citations: [],
    });
    expect(out.markdown).not.toContain("## 调查 A");
    expect(out.markdown).toContain("正文。");
  });

  it("目标为空串时不做任何标题剥除", () => {
    const out = prepareReportMarkdown({
      markdown: "# \n\n正文。",
      objective: "",
      citations: [],
    });
    expect(out.markdown).toContain("#");
  });
});

describe("prepareReportMarkdown：引用编号化", () => {
  it("按首次出现顺序编号，同一 chunkId 复用编号", () => {
    const out = prepareReportMarkdown({
      markdown: "甲[^b]。乙[^a]。再引甲[^b]。",
      objective: "目标",
      citations: [makeCitation("a"), makeCitation("b")],
    });
    expect(out.markdown).toContain("甲[[1]](#cite-1");
    expect(out.markdown).toContain("乙[[2]](#cite-2");
    expect(out.markdown).toContain("再引甲[[1]](#cite-1");
    expect(out.refs.map((r) => r.chunkId)).toEqual(["b", "a"]);
  });

  it("收编尾随的（来源：…），tooltip 用 citations 里的标题", () => {
    const out = prepareReportMarkdown({
      markdown: "结论[^c1]（来源：Tokio 教程）",
      objective: "目标",
      citations: [makeCitation("c1", { title: "Tokio 教程" })],
    });
    expect(out.markdown).not.toContain("（来源：");
    expect(out.markdown).toContain('[[1]](#cite-1 "Tokio 教程")');
    expect(out.refs[0]?.title).toBe("Tokio 教程");
    expect(out.refs[0]?.url).toBe("https://example.com/c1");
  });

  it("citations 里查不到时，退用行内（来源：…）的标题", () => {
    const out = prepareReportMarkdown({
      markdown: "结论[^c9]（来源：某文档）",
      objective: "目标",
      citations: [],
    });
    expect(out.markdown).toContain('[[1]](#cite-1 "某文档")');
    expect(out.refs[0]?.title).toBe("某文档");
  });

  it("围栏代码块内的同形文本不转换", () => {
    const out = prepareReportMarkdown({
      markdown: "```\nlist[^idx] = 1\n```\n\n正文[^c1]。",
      objective: "目标",
      citations: [makeCitation("c1")],
    });
    expect(out.markdown).toContain("list[^idx] = 1");
    expect(out.markdown).toContain("正文[[1]](#cite-1");
  });

  it("行内代码里的同形文本不转换", () => {
    const out = prepareReportMarkdown({
      markdown: "见 `arr[^i]` 的用法[^c1]。",
      objective: "目标",
      citations: [makeCitation("c1")],
    });
    expect(out.markdown).toContain("`arr[^i]`");
    expect(out.refs).toHaveLength(1);
  });

  it("tooltip 标题里的双引号被剔除，避免破坏 markdown 链接语法", () => {
    const out = prepareReportMarkdown({
      markdown: "结论[^c1]",
      objective: "目标",
      citations: [makeCitation("c1", { title: 'He said "hi"' })],
    });
    expect(out.markdown).toContain('[[1]](#cite-1 "He said hi")');
  });
});
