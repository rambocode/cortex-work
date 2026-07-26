// 候选选择器的表驱动测试：去重、blocklist、域名多样性、预算截断。
import { describe, expect, it } from "vitest";
import type { SearchCandidate } from "@cortex-work/core/research/evidence";
import { MODE_BUDGETS } from "@cortex-work/core/research/budget";
import type { ResearchBudget } from "@cortex-work/core/research/types";
import { selectCandidates, toSearchCandidates } from "./candidate-selector";

/// 造一条候选。默认公网信任区（Search Server 只检索公网）。
function candidate(partial: Partial<SearchCandidate> & { candidateId: string; url: string }): SearchCandidate {
  return {
    queryId: "q1",
    title: partial.candidateId,
    domain: new URL(partial.url).hostname,
    engines: ["google"],
    serverScore: 0.5,
    trustZone: "public_web",
    ...partial,
  };
}

function budgetWith(overrides: Partial<ResearchBudget>): ResearchBudget {
  return { ...MODE_BUDGETS.standard, ...overrides };
}

interface Case {
  name: string;
  candidates: SearchCandidate[];
  alreadyFetched?: string[];
  blockedDomains?: string[];
  budget?: Partial<ResearchBudget>;
  maxPerDomain?: number;
  expected: string[];
}

const CASES: Case[] = [
  {
    name: "同一 URL 的不同写法（tracking 参数 / fragment）只保留分数最高的一条",
    candidates: [
      candidate({ candidateId: "a", url: "https://x.com/p?utm_source=news", serverScore: 0.4 }),
      candidate({ candidateId: "b", url: "https://x.com/p#section", serverScore: 0.9 }),
    ],
    expected: ["b"],
  },
  {
    name: "已抓取过的 canonical URL 被跳过",
    candidates: [
      candidate({ candidateId: "a", url: "https://x.com/p", serverScore: 0.9 }),
      candidate({ candidateId: "b", url: "https://y.com/p", serverScore: 0.1 }),
    ],
    alreadyFetched: ["https://x.com/p"],
    expected: ["b"],
  },
  {
    name: "blocklist 命中域名与其子域一并剔除",
    candidates: [
      candidate({ candidateId: "a", url: "https://spam.com/1", serverScore: 0.9 }),
      candidate({ candidateId: "b", url: "https://mirror.spam.com/1", serverScore: 0.8 }),
      candidate({ candidateId: "c", url: "https://ok.com/1", serverScore: 0.1 }),
    ],
    blockedDomains: ["spam.com"],
    expected: ["c"],
  },
  {
    name: "非 http(s) 的 URL 一律剔除（canonicalizeUrl 返回 null）",
    candidates: [
      candidate({ candidateId: "a", url: "https://ok.com/1", serverScore: 0.2 }),
      { ...candidate({ candidateId: "b", url: "https://ok.com/2" }), url: "ftp://ok.com/2", domain: "ok.com" },
    ],
    expected: ["a"],
  },
  {
    name: "同域名最多取 N 条",
    candidates: [
      candidate({ candidateId: "a1", url: "https://a.com/1", serverScore: 0.99 }),
      candidate({ candidateId: "a2", url: "https://a.com/2", serverScore: 0.98 }),
      candidate({ candidateId: "a3", url: "https://a.com/3", serverScore: 0.97 }),
      candidate({ candidateId: "b1", url: "https://b.com/1", serverScore: 0.1 }),
    ],
    maxPerDomain: 2,
    expected: ["a1", "b1", "a2"],
  },
  {
    name: "域名多样性优先：新域名的次高分排在同域第二条之前",
    candidates: [
      candidate({ candidateId: "a1", url: "https://a.com/1", serverScore: 0.99 }),
      candidate({ candidateId: "a2", url: "https://a.com/2", serverScore: 0.98 }),
      candidate({ candidateId: "b1", url: "https://b.com/1", serverScore: 0.5 }),
      candidate({ candidateId: "c1", url: "https://c.com/1", serverScore: 0.4 }),
    ],
    expected: ["a1", "b1", "c1", "a2"],
  },
  {
    name: "截断到剩余预算（maxDocuments）",
    candidates: [
      candidate({ candidateId: "a", url: "https://a.com/1", serverScore: 0.9 }),
      candidate({ candidateId: "b", url: "https://b.com/1", serverScore: 0.8 }),
      candidate({ candidateId: "c", url: "https://c.com/1", serverScore: 0.7 }),
    ],
    budget: { maxDocuments: 2 },
    expected: ["a", "b"],
  },
  {
    name: "候选已发现后只受文档额度限制，不再受候选发现额度限制",
    candidates: [
      candidate({ candidateId: "a", url: "https://a.com/1", serverScore: 0.9 }),
      candidate({ candidateId: "b", url: "https://b.com/1", serverScore: 0.8 }),
    ],
    budget: { maxDocuments: 5, maxCandidates: 1 },
    expected: ["a", "b"],
  },
  {
    name: "预算为 0 时不选任何候选",
    candidates: [candidate({ candidateId: "a", url: "https://a.com/1" })],
    budget: { maxDocuments: 0 },
    expected: [],
  },
];

describe("selectCandidates", () => {
  it.each(CASES)("$name", (testCase) => {
    const selected = selectCandidates({
      candidates: testCase.candidates,
      alreadyFetched: new Set(testCase.alreadyFetched ?? []),
      budget: budgetWith(testCase.budget ?? {}),
      ...(testCase.blockedDomains ? { blockedDomains: testCase.blockedDomains } : {}),
      ...(testCase.maxPerDomain === undefined ? {} : { maxPerDomain: testCase.maxPerDomain }),
    });
    expect(selected.map((item) => item.candidateId)).toEqual(testCase.expected);
  });

  it("不修改入参数组", () => {
    const input = [candidate({ candidateId: "a", url: "https://a.com/1" })];
    const snapshot = [...input];
    selectCandidates({ candidates: input, alreadyFetched: new Set(), budget: MODE_BUDGETS.quick });
    expect(input).toEqual(snapshot);
  });

  it("按子问题轮询分配抓取名额，低分子问题不会被高分子问题饿死", () => {
    const input = [
      candidate({ candidateId: "a1", queryId: "q1", url: "https://a.com/1", serverScore: 0.99 }),
      candidate({ candidateId: "b1", queryId: "q1", url: "https://b.com/1", serverScore: 0.98 }),
      candidate({ candidateId: "c1", queryId: "q1", url: "https://c.com/1", serverScore: 0.97 }),
      candidate({ candidateId: "d1", queryId: "q2", url: "https://d.com/1", serverScore: 0.1 }),
    ];
    const selected = selectCandidates({
      candidates: input,
      alreadyFetched: new Set(),
      budget: budgetWith({ maxDocuments: 2 }),
      subquestionByQueryId: new Map([
        ["q1", "sq1"],
        ["q2", "sq2"],
      ]),
      prioritySubquestionIds: ["sq1", "sq2"],
    });

    expect(selected.map((item) => item.candidateId)).toEqual(["a1", "d1"]);
  });
});

describe("toSearchCandidates", () => {
  it("把 snake_case 的搜索响应映射成领域候选，并注入稳定 id", () => {
    let seq = 0;
    const candidates = toSearchCandidates(
      {
        request_id: "req_1",
        results: [
          {
            query_id: "q1",
            items: [
              {
                url: "https://x.com/a",
                title: "标题",
                snippet: "摘要",
                domain: "x.com",
                engines: ["google", "bing"],
                published_at: "2026-01-01T00:00:00.000Z",
                score: 0.75,
                canonical_url: "https://x.com/a?utm_source=x",
              },
            ],
            errors: [],
          },
        ],
        stats: {
          provider_count: 1,
          raw_result_count: 1,
          returned_result_count: 1,
          cache_hit: false,
          duration_ms: 3,
        },
      },
      { newId: () => `cand_${(seq += 1)}` },
    );

    expect(candidates).toEqual([
      {
        candidateId: "cand_1",
        queryId: "q1",
        title: "标题",
        url: "https://x.com/a",
        canonicalUrl: "https://x.com/a?utm_source=x",
        snippet: "摘要",
        domain: "x.com",
        engines: ["google", "bing"],
        publishedAt: "2026-01-01T00:00:00.000Z",
        serverScore: 0.75,
        trustZone: "public_web",
      },
    ]);
  });
});
