// quick-types 的夹取纯函数测试。这些函数是窄面预算的唯一执行点——
// 它们放行多少，就有多少内容进模型上下文，所以边界必须逐条锁住。
import { describe, expect, it } from "vitest";

import {
  QUICK_RETRIEVAL_LIMITS,
  clampLeadLimit,
  clampPrepareUrls,
  clipPreparedDocuments,
} from "./quick-types";

describe("clampLeadLimit", () => {
  it.each([
    [undefined, QUICK_RETRIEVAL_LIMITS.maxLeads],
    [Number.NaN, QUICK_RETRIEVAL_LIMITS.maxLeads],
    [Infinity, QUICK_RETRIEVAL_LIMITS.maxLeads],
    [0, 1],
    [-5, 1],
    [3, 3],
    [3.4, 3],
    [999, QUICK_RETRIEVAL_LIMITS.maxLeads],
  ])("%s → %s", (input, expected) => {
    expect(clampLeadLimit(input)).toBe(expected);
  });
});

describe("clampPrepareUrls", () => {
  it("按 maxUrls 截断", () => {
    const urls = Array.from({ length: QUICK_RETRIEVAL_LIMITS.maxUrls + 3 }, (_v, i) => `https://a.com/${i}`);
    expect(clampPrepareUrls(urls)).toHaveLength(QUICK_RETRIEVAL_LIMITS.maxUrls);
  });

  it("去重并保持首次出现顺序（LLM 生成的参数很容易带重复项）", () => {
    expect(clampPrepareUrls(["https://b.com", "https://a.com", "https://b.com"])).toEqual([
      "https://b.com",
      "https://a.com",
    ]);
  });

  it("裁掉首尾空白，丢弃空串", () => {
    expect(clampPrepareUrls(["  https://a.com  ", "", "   "])).toEqual(["https://a.com"]);
  });

  it("去重发生在截断之前（重复项不该白占名额）", () => {
    const dup = Array.from({ length: 10 }, () => "https://same.com");
    expect(clampPrepareUrls([...dup, "https://other.com"])).toEqual([
      "https://same.com",
      "https://other.com",
    ]);
  });
});

describe("clipPreparedDocuments", () => {
  const base = { url: "https://a.com", fetchMethod: "http" as const };

  it("单篇超长时按 maxCharsPerDocument 截断并标 truncated", () => {
    const [doc] = clipPreparedDocuments([
      { ...base, text: "x".repeat(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument + 100) },
    ]);
    expect(doc!.text).toHaveLength(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument);
    expect(doc!.truncated).toBe(true);
  });

  it("未超长时原样保留且 truncated=false", () => {
    const [doc] = clipPreparedDocuments([{ ...base, text: "short" }]);
    expect(doc!.text).toBe("short");
    expect(doc!.truncated).toBe(false);
  });

  it("总量上限生效：所有文档的正文之和不超过 maxTotalChars", () => {
    const docs = Array.from({ length: 5 }, (_v, i) => ({
      ...base,
      url: `https://a.com/${i}`,
      text: "x".repeat(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument),
    }));
    const clipped = clipPreparedDocuments(docs);
    const total = clipped.reduce((sum, d) => sum + d.text.length, 0);
    expect(total).toBeLessThanOrEqual(QUICK_RETRIEVAL_LIMITS.maxTotalChars);
  });

  it("总额度耗尽后不再收录后续文档（而不是收一个空壳）", () => {
    // 单篇上限低于总上限，所以要几篇满额文档才吃得完总额度：
    // ceil(maxTotalChars / maxCharsPerDocument) 篇之后余额归零。
    const eaters = Math.ceil(
      QUICK_RETRIEVAL_LIMITS.maxTotalChars / QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument,
    );
    const docs = [
      ...Array.from({ length: eaters }, (_v, i) => ({
        ...base,
        url: `https://a.com/${i}`,
        text: "x".repeat(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument),
      })),
      { ...base, url: "https://a.com/overflow", text: "still here" },
    ];
    const clipped = clipPreparedDocuments(docs);
    expect(clipped.map((d) => d.url)).not.toContain("https://a.com/overflow");
    expect(clipped).toHaveLength(eaters);
    // 最后一篇被总额度截短，不是整篇丢掉——多来源本身就是引用可信度的来源。
    expect(clipped.at(-1)!.truncated).toBe(true);
  });

  it("按 code point 截断，不切坏代理对", () => {
    const [doc] = clipPreparedDocuments([
      { ...base, text: "😀".repeat(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument + 10) },
    ]);
    expect([...doc!.text]).toHaveLength(QUICK_RETRIEVAL_LIMITS.maxCharsPerDocument);
    expect(doc!.text.endsWith("😀")).toBe(true);
  });

  it("空列表回空列表", () => {
    expect(clipPreparedDocuments([])).toEqual([]);
  });
});
