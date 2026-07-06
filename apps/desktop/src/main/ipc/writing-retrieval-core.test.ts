// 写作检索打分核心的纯函数单测(U4):锁分词与 top-k 排序正确性。
// 覆盖:中英分词、关键词命中排序、多文档相对排序、空查询/空索引不产出。
import { describe, expect, it } from "vitest";
import {
  buildQueryModelFromText,
  buildWritingIndex,
  chunkWritingMarkdown,
  clampSnippetCount,
  retrieveFromIndex,
  tokenizeWritingRetrievalText,
  type WritingIndexInput,
} from "./writing-retrieval-core";

// 便捷:构造索引并跑查询,返回 top-k 片段。
function retrieve(inputs: WritingIndexInput[], query: string, k = 3) {
  const index = buildWritingIndex(inputs);
  return { index, snippets: retrieveFromIndex(index, buildQueryModelFromText(query), clampSnippetCount(k)) };
}

const PHOTO: WritingIndexInput = {
  path: "/ws/alpha.md",
  relativePath: "alpha.md",
  content:
    "# Photosynthesis\n\n" +
    "Photosynthesis lets green plants turn sunlight into chemical energy. " +
    "Chlorophyll inside the leaf captures light and drives photosynthesis every day.\n",
};

const DATABASE: WritingIndexInput = {
  path: "/ws/beta.md",
  relativePath: "beta.md",
  content:
    "# Database Indexes\n\n" +
    "A database index speeds up queries. Building an index on a column lets the " +
    "query planner avoid a full scan, so index maintenance is a common database task.\n",
};

describe("tokenizeWritingRetrievalText", () => {
  it("拆拉丁词、剔除停用词与纯数字、保留 >=2 长度词", () => {
    const tokens = tokenizeWritingRetrievalText("The photosynthesis of 2024 plants");
    expect(tokens).toContain("photosynthesis");
    expect(tokens).toContain("plants");
    expect(tokens).not.toContain("the"); // 停用词
    expect(tokens).not.toContain("2024"); // 纯数字
  });

  it("汉字段做 2..4-gram 滑窗", () => {
    const tokens = tokenizeWritingRetrievalText("光合作用");
    // 2-gram 至少含「光合」「合作」「作用」
    expect(tokens).toContain("光合");
    expect(tokens).toContain("作用");
  });
});

describe("chunkWritingMarkdown", () => {
  it("按标题起块并记录标题与行号定位", () => {
    const chunks = chunkWritingMarkdown(PHOTO.path, PHOTO.relativePath, PHOTO.content);
    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0];
    expect(chunk.title).toBe("Photosynthesis");
    expect(chunk.location.kind).toBe("text");
  });
});

describe("retrieveFromIndex 排序正确性", () => {
  it("关键词命中的文档排在最前,并回报命中关键词", () => {
    const { snippets } = retrieve([PHOTO, DATABASE], "photosynthesis chlorophyll");
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0].path).toBe("alpha.md");
    expect(snippets[0].keywords).toContain("photosynthesis");
    // 与查询无关的数据库文档不应挤到首位(通常直接被阈值过滤掉)。
    expect(snippets[0].path).not.toBe("beta.md");
  });

  it("多文档:命中更强的文档相对排序更靠前", () => {
    const { snippets } = retrieve([PHOTO, DATABASE], "database index query");
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0].path).toBe("beta.md");
  });

  it("空查询 → 无片段", () => {
    const { snippets } = retrieve([PHOTO, DATABASE], "   ");
    expect(snippets).toHaveLength(0);
  });

  it("空索引 → 无片段", () => {
    const { snippets } = retrieve([], "photosynthesis");
    expect(snippets).toHaveLength(0);
  });

  it("无命中(查询词不在任何文档)→ 无片段", () => {
    const { snippets } = retrieve([PHOTO, DATABASE], "spacecraft propulsion telemetry");
    expect(snippets).toHaveLength(0);
  });
});

describe("clampSnippetCount", () => {
  it("默认 3,夹取到 1..8", () => {
    expect(clampSnippetCount(undefined)).toBe(3);
    expect(clampSnippetCount(0)).toBe(1);
    expect(clampSnippetCount(99)).toBe(8);
    expect(clampSnippetCount(5)).toBe(5);
  });
});
