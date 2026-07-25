// 通用词法检索原语(BM25 + 关键词加成 + 片段开窗)的表驱动单测。
// 这些函数从 desktop 的写作检索上移到 core,写作侧的既有测试继续做「零行为变更」的回归证明;
// 本文件只针对通用语义独立立约,避免两边测试互相耦合。
import { describe, expect, it } from "vitest";
import {
  bestSnippetText,
  bm25Score,
  buildQueryModelFromText,
  keywordScore,
  tokenizeRetrievalText,
  type LexicalChunk,
  type LexicalCorpusStats,
  type LexicalQueryModel,
} from "./lexical";

// 造一个满足打分所需字段的块;未指定的字段由 text 派生,减少用例噪音。
function makeChunk(partial: Partial<LexicalChunk> & { text?: string }): LexicalChunk {
  const text = partial.text ?? "";
  const tokens = partial.tokens ?? tokenizeRetrievalText(text);
  const termFrequency = new Map<string, number>();
  for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  return {
    text,
    lowerText: partial.lowerText ?? text.toLowerCase(),
    tokens,
    termFrequency: partial.termFrequency ?? termFrequency,
    titleTokens: partial.titleTokens ?? new Set<string>(),
    pathTokens: partial.pathTokens ?? new Set<string>(),
  };
}

// 造一个只含 BM25 统计量的语料快照(chunks 只用到 length)。
function makeStats(chunkCount: number, averageLength: number, df: Record<string, number>): LexicalCorpusStats {
  return {
    chunks: Array.from({ length: chunkCount }, () => ({})),
    averageLength,
    documentFrequency: new Map(Object.entries(df)),
  };
}

// 造一个查询模型(默认每个词权重 1,便于直接对照公式)。
function makeQuery(terms: string[], weights?: Record<string, number>, phrases: string[] = []): LexicalQueryModel {
  return {
    text: terms.join(" "),
    terms,
    weights: new Map(terms.map((term) => [term, weights?.[term] ?? 1])),
    phrases,
  };
}

describe("tokenizeRetrievalText", () => {
  it.each([
    ["空字符串无词项", "", []],
    ["纯空白无词项", "   \n\t ", []],
    ["单字符拉丁词被丢弃(正则要求 >=2 字符)", "a b cd", ["cd"]],
    ["停用词被剔除", "the and with alpha", ["alpha"]],
    ["纯数字不作为独立词项", "2024 beta", ["beta"]],
    ["含数字的混合词保留", "gpt4 v2", ["gpt4", "v2"]],
    ["全角大写经 NFKC + 小写归一", "ＰＨＯＴＯ", ["photo"]],
    ["连字符/下划线属于词内字符", "write-ahead log_file", ["write-ahead", "log_file"]],
    ["单个汉字整体成词", "光", ["光"]],
  ])("%s", (_name, input, expected) => {
    expect(tokenizeRetrievalText(input as string)).toEqual(expected);
  });

  it("汉字段做 2..4-gram 滑窗(顺序:先 2-gram 再 3-gram 再 4-gram)", () => {
    expect(tokenizeRetrievalText("光合作用")).toEqual([
      "光合",
      "合作",
      "作用",
      "光合作",
      "合作用",
      "光合作用",
    ]);
  });

  it("单个汉字段最多取前 120 字,防超长段落把词表撑爆", () => {
    const tokens = tokenizeRetrievalText("国".repeat(200));
    // n=120 时 2/3/4-gram 数量为 119 + 118 + 117 = 354
    expect(tokens).toHaveLength(354);
  });

  it("中英混合:先输出全部拉丁词,再输出汉字 n-gram", () => {
    const tokens = tokenizeRetrievalText("alpha 光合");
    expect(tokens).toEqual(["alpha", "光合"]);
  });
});

describe("bm25Score", () => {
  const chunk = makeChunk({ tokens: ["alpha", "alpha", "beta"], text: "" });

  it("查询词不在块内 → 0 分", () => {
    const stats = makeStats(10, 3, { gamma: 1 });
    expect(bm25Score(chunk, stats, makeQuery(["gamma"]))).toBe(0);
  });

  it("idf 单调:文档频率越高的词得分越低", () => {
    const rare = makeStats(100, 3, { alpha: 1 });
    const common = makeStats(100, 3, { alpha: 80 });
    expect(bm25Score(chunk, rare, makeQuery(["alpha"]))).toBeGreaterThan(
      bm25Score(chunk, common, makeQuery(["alpha"])),
    );
  });

  it("tf 饱和:词频翻倍带来的增益小于翻倍(k1=1.2)", () => {
    const stats = makeStats(100, 3, { alpha: 5 });
    // 两个块 token 总长相同,只是 alpha 出现次数不同,隔离长度归一的影响
    const once = makeChunk({ tokens: ["alpha", "beta", "beta", "beta"] });
    const twice = makeChunk({ tokens: ["alpha", "alpha", "beta", "beta"] });
    const scoreOnce = bm25Score(once, stats, makeQuery(["alpha"]));
    const scoreTwice = bm25Score(twice, stats, makeQuery(["alpha"]));
    expect(scoreTwice).toBeGreaterThan(scoreOnce);
    expect(scoreTwice).toBeLessThan(scoreOnce * 2);
  });

  it("块越长得分越低(b=0.72 的长度归一)", () => {
    const stats = makeStats(100, 4, { alpha: 5 });
    const short = makeChunk({ tokens: ["alpha", "beta"] });
    const long = makeChunk({ tokens: ["alpha", ...Array.from({ length: 40 }, () => "beta")] });
    expect(bm25Score(short, stats, makeQuery(["alpha"]))).toBeGreaterThan(
      bm25Score(long, stats, makeQuery(["alpha"])),
    );
  });

  it("查询词权重线性放大得分", () => {
    const stats = makeStats(100, 3, { alpha: 5 });
    const base = bm25Score(chunk, stats, makeQuery(["alpha"], { alpha: 1 }));
    const doubled = bm25Score(chunk, stats, makeQuery(["alpha"], { alpha: 2 }));
    expect(doubled).toBeCloseTo(base * 2, 10);
  });

  it("空语料兜底:chunks 为空、averageLength 为 0 也不产生 NaN", () => {
    const stats = makeStats(0, 0, {});
    expect(Number.isFinite(bm25Score(chunk, stats, makeQuery(["alpha"])))).toBe(true);
  });
});

describe("keywordScore", () => {
  it("未命中任何查询词 → 0 分且无关键词", () => {
    const chunk = makeChunk({ text: "alpha beta" });
    expect(keywordScore(chunk, makeQuery(["gamma"]))).toEqual({ score: 0, keywords: [] });
  });

  it("命中数量的平方根加成(0.18/根)", () => {
    const chunk = makeChunk({ text: "alpha beta" });
    const one = keywordScore(chunk, makeQuery(["alpha"]));
    const two = keywordScore(chunk, makeQuery(["alpha", "beta"]));
    expect(one.score).toBeCloseTo(0.18, 10);
    expect(two.score).toBeCloseTo(Math.sqrt(2) * 0.18, 10);
    expect(two.keywords).toEqual(["alpha", "beta"]);
  });

  it("命中标题加 0.35×权重,命中路径加 0.18×权重,可叠加", () => {
    const chunk = makeChunk({
      text: "alpha beta",
      titleTokens: new Set(["alpha"]),
      pathTokens: new Set(["alpha"]),
    });
    const { score } = keywordScore(chunk, makeQuery(["alpha"], { alpha: 2 }));
    expect(score).toBeCloseTo(0.35 * 2 + 0.18 * 2 + 0.18, 10);
  });

  it("长短语(>=8 字符)精确命中重奖 0.9,短短语不加成", () => {
    const chunk = makeChunk({ text: "the quick brown fox", lowerText: "the quick brown fox" });
    const long = keywordScore(chunk, makeQuery(["quick"], undefined, ["quick brown"]));
    const short = keywordScore(chunk, makeQuery(["quick"], undefined, ["quick"]));
    expect(long.score - short.score).toBeCloseTo(0.9, 10);
  });

  it("短语未出现在正文时不加成", () => {
    const chunk = makeChunk({ text: "alpha beta", lowerText: "alpha beta" });
    const { score } = keywordScore(chunk, makeQuery(["alpha"], undefined, ["gamma delta epsilon"]));
    expect(score).toBeCloseTo(0.18, 10);
  });

  it("回报的关键词最多 8 个,但加成按全部命中数计算", () => {
    const terms = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh", "ii", "jj"];
    const chunk = makeChunk({ tokens: terms });
    const { score, keywords } = keywordScore(chunk, makeQuery(terms));
    expect(keywords).toHaveLength(8);
    expect(score).toBeCloseTo(Math.sqrt(10) * 0.18, 10);
  });
});

describe("bestSnippetText", () => {
  it("短于上限的块整体返回(仅 trim 与换行归一)", () => {
    expect(bestSnippetText({ text: "  hello\r\nworld  " }, [])).toBe("hello\nworld");
  });

  it("超长块以首个命中关键词为中心开窗,两侧补省略号", () => {
    const text = `${"x".repeat(600)}needle${"y".repeat(600)}`;
    const snippet = bestSnippetText({ text }, ["needle"]);
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet).toContain("needle");
    // 窗口宽度固定 520 字符(不含两侧省略号)
    expect(snippet.length).toBe(520 + 6);
  });

  it("关键词在开头时不补前缀省略号", () => {
    const text = `needle${"y".repeat(1200)}`;
    const snippet = bestSnippetText({ text }, ["needle"]);
    expect(snippet.startsWith("needle")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
  });

  it("取最靠前的命中关键词作为窗口中心", () => {
    const text = `${"x".repeat(100)}early${"x".repeat(900)}late${"x".repeat(100)}`;
    const snippet = bestSnippetText({ text }, ["late", "early"]);
    expect(snippet).toContain("early");
    expect(snippet).not.toContain("late");
  });

  it("无关键词命中时以块中点开窗", () => {
    const text = `${"x".repeat(600)}middle${"y".repeat(600)}`;
    const snippet = bestSnippetText({ text }, ["absent"]);
    expect(snippet).toContain("middle");
  });
});

describe("buildQueryModelFromText", () => {
  it("按词权重排序取前 N 词项,权重为出现次数×2", () => {
    const model = buildQueryModelFromText("alpha alpha beta");
    expect(model.terms[0]).toBe("alpha");
    expect(model.weights.get("alpha")).toBe(4);
    expect(model.weights.get("beta")).toBe(2);
  });

  it("查询文本压缩空白并截断到 240 字符", () => {
    const model = buildQueryModelFromText(`  alpha   beta  ${"c".repeat(400)}`);
    expect(model.text.startsWith("alpha beta ")).toBe(true);
    expect(model.text).toHaveLength(240);
  });

  it("压缩后长度 >=8 才产出短语,且短语取尾部 80 字符并小写化", () => {
    expect(buildQueryModelFromText("alpha").phrases).toEqual([]);
    expect(buildQueryModelFromText("Alpha Beta Gamma").phrases).toEqual(["alpha beta gamma"]);
    const long = buildQueryModelFromText("Z".repeat(200));
    expect(long.phrases[0]).toBe("z".repeat(80));
  });

  it("最多保留 36 个词项", () => {
    const words = Array.from({ length: 50 }, (_, index) => `w${index}x`).join(" ");
    expect(buildQueryModelFromText(words).terms).toHaveLength(36);
  });
});
