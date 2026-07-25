import { describe, expect, it } from "vitest";

import { parsePlannerDecision, parseResearchPlan } from "./plan-schema";

/// 一份「模型本该输出的」合法 plan。各用例在其上做局部污染，验证清洗行为。
function validRawPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    objective: "评估开源桌面 AI Agent 的现状",
    scope: { language: "zh", timeRange: "year", regions: ["CN"] },
    subquestions: [
      { id: "sq_01", text: "有哪些开源桌面 Agent", rationale: "先摸清全景" },
      { id: "sq_02", text: "它们的安全模型如何" },
    ],
    initialQueries: [
      { queryId: "q_01", subquestionId: "sq_01", text: "open source desktop AI agent" },
      {
        queryId: "q_02",
        subquestionId: "sq_02",
        text: "desktop agent sandbox security",
        language: "en",
        categories: ["general"],
        timeRange: "month",
        domainAllowlist: ["example.com"],
        domainBlocklist: ["spam.example"],
        limit: 10,
      },
    ],
    budget: {
      maxRounds: 3,
      maxQueries: 16,
      maxCandidates: 60,
      maxDocuments: 24,
      maxBrowserFetches: 5,
      maxDurationMs: 600_000,
      maxEvidenceCharsToModel: 120_000,
    },
    completion: {
      minSourcesPerSubquestion: 2,
      minIndependentDomains: 2,
      requirePrimarySource: true,
      requireContradiction: false,
      minimumRelevance: 0.5,
    },
  };
}

const baseCtx = { mode: "standard" } as const;

/// 断言是成功结果并收窄类型，失败时把 errors 打进断言消息方便定位。
function expectOk(result: ReturnType<typeof parseResearchPlan>) {
  if (!result.ok) throw new Error(`期望解析成功，实际失败：${result.errors.join(" | ")}`);
  return result;
}

describe("parseResearchPlan：完全合法的 plan 原样通过", () => {
  it("字段全部保留且没有 warning", () => {
    const result = expectOk(parseResearchPlan(validRawPlan(), baseCtx));
    expect(result.warnings).toEqual([]);
    expect(result.plan.schemaVersion).toBe(1);
    expect(result.plan.objective).toBe("评估开源桌面 AI Agent 的现状");
    expect(result.plan.subquestions.map((item) => item.id)).toEqual(["sq_01", "sq_02"]);
    expect(result.plan.initialQueries).toHaveLength(2);
    expect(result.plan.initialQueries[1]).toMatchObject({
      queryId: "q_02",
      subquestionId: "sq_02",
      text: "desktop agent sandbox security",
      language: "en",
      categories: ["general"],
      timeRange: "month",
      limit: 10,
    });
    expect(result.plan.completion.minimumRelevance).toBe(0.5);
  });

  it("scope 缺省时给出空对象而非 undefined", () => {
    const raw = validRawPlan();
    delete raw.scope;
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.scope).toEqual({});
  });
});

describe("清洗 1：丢弃模型给出的任何 URL 字段", () => {
  it("plan 与 query 上的 url / urls / sources / links 被静默删除并记 warning", () => {
    const raw = validRawPlan();
    raw.sources = ["https://evil.example/inject"];
    raw.links = ["https://evil.example"];
    const queries = raw.initialQueries as Record<string, unknown>[];
    queries[0]!.url = "https://evil.example/a";
    queries[1]!.urls = ["https://evil.example/b"];

    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.initialQueries[0]).not.toHaveProperty("url");
    expect(result.plan).not.toHaveProperty("sources");
    const dropped = result.warnings.filter((w) => w.startsWith("[plan.url_dropped]"));
    expect(dropped).toHaveLength(4);
    expect(dropped.join(" ")).toContain("initialQueries[0].url");
  });

  it("嵌套在 subquestion 里的 href 也被删除", () => {
    const raw = validRawPlan();
    (raw.subquestions as Record<string, unknown>[])[0]!.href = "https://evil.example";
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.subquestions[0]).not.toHaveProperty("href");
    expect(result.warnings.some((w) => w.includes("subquestions[0].href"))).toBe(true);
  });

  it("domainAllowlist 不会被 URL 清洗误伤", () => {
    const result = expectOk(parseResearchPlan(validRawPlan(), baseCtx));
    expect(result.plan.initialQueries[1]!.domainAllowlist).toEqual(["example.com"]);
  });
});

describe("清洗 2：预算夹取", () => {
  it("模型给出的离谱预算被夹到模式硬上限内", () => {
    const raw = validRawPlan();
    raw.budget = { maxRounds: 9999, maxDocuments: 100000, maxDurationMs: 86_400_000 };
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.budget.maxRounds).toBeLessThan(9999);
    expect(result.plan.budget.maxDocuments).toBeLessThan(100000);
    expect(result.plan.budget.maxDurationMs).toBeLessThan(86_400_000);
  });

  it("budget 缺失或类型非法时回落为模式默认预算（不拒绝整体）", () => {
    const raw = validRawPlan();
    delete raw.budget;
    const withoutBudget = expectOk(parseResearchPlan(raw, baseCtx));

    const raw2 = validRawPlan();
    raw2.budget = "lots";
    const withGarbage = expectOk(parseResearchPlan(raw2, baseCtx));

    for (const plan of [withoutBudget.plan, withGarbage.plan]) {
      for (const value of Object.values(plan.budget)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it("不同模式给出不同预算", () => {
    const raw = validRawPlan();
    delete raw.budget;
    const quick = expectOk(parseResearchPlan(raw, { mode: "quick" })).plan.budget;
    const deep = expectOk(parseResearchPlan(validRawPlan(), { mode: "deep" })).plan.budget;
    expect(deep.maxRounds).toBeGreaterThanOrEqual(quick.maxRounds);
  });
});

describe("清洗 3：同一 subquestion 下的重复查询去重", () => {
  it("归一化后重复的 query 只留第一条并记 warning", () => {
    const raw = validRawPlan();
    raw.initialQueries = [
      { queryId: "q_01", subquestionId: "sq_01", text: "Open Source  Desktop Agent" },
      { queryId: "q_02", subquestionId: "sq_01", text: "  open source desktop agent " },
      { queryId: "q_03", subquestionId: "sq_01", text: "open\tsource\ndesktop   agent" },
    ];
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.initialQueries.map((item) => item.queryId)).toEqual(["q_01"]);
    expect(result.warnings.filter((w) => w.startsWith("[plan.duplicate_query]"))).toHaveLength(2);
  });

  it("文本相同但归属不同 subquestion 的查询都保留", () => {
    const raw = validRawPlan();
    raw.initialQueries = [
      { queryId: "q_01", subquestionId: "sq_01", text: "same text" },
      { queryId: "q_02", subquestionId: "sq_02", text: "same text" },
    ];
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.initialQueries).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });
});

describe("清洗 4：query → subquestion 归属校验", () => {
  it("引用了不存在的 subquestionId 时整体拒绝", () => {
    const raw = validRawPlan();
    (raw.initialQueries as Record<string, unknown>[])[0]!.subquestionId = "sq_ghost";
    const result = parseResearchPlan(raw, baseCtx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("sq_ghost");
  });
});

describe("清洗 5：domain allowlist / blocklist 范围校验", () => {
  it("超出 ctx.allowedDomains 的 allowlist 条目被删除并记 warning", () => {
    const raw = validRawPlan();
    (raw.initialQueries as Record<string, unknown>[])[1]!.domainAllowlist = [
      "example.com",
      "docs.example.com",
      "evil.example",
    ];
    const result = expectOk(
      parseResearchPlan(raw, { mode: "standard", allowedDomains: ["example.com"] }),
    );
    // 子域视为落在允许域内，同级的另一个域则被剔除。
    expect(result.plan.initialQueries[1]!.domainAllowlist).toEqual([
      "example.com",
      "docs.example.com",
    ]);
    expect(result.warnings.some((w) => w.startsWith("[plan.domain_dropped]"))).toBe(true);
    expect(result.warnings.join(" ")).toContain("evil.example");
  });

  it("命中 ctx.blockedDomains 的 allowlist 条目被删除", () => {
    const raw = validRawPlan();
    (raw.initialQueries as Record<string, unknown>[])[1]!.domainAllowlist = [
      "example.com",
      "spam.example",
    ];
    const result = expectOk(
      parseResearchPlan(raw, { mode: "standard", blockedDomains: ["spam.example"] }),
    );
    expect(result.plan.initialQueries[1]!.domainAllowlist).toEqual(["example.com"]);
  });

  it("伪装成域名的完整 URL 被删除（防止绕过「模型不得生成 URL」）", () => {
    const raw = validRawPlan();
    (raw.initialQueries as Record<string, unknown>[])[1]!.domainAllowlist = [
      "https://evil.example/path?x=1",
      "example.com",
    ];
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.initialQueries[1]!.domainAllowlist).toEqual(["example.com"]);
  });

  it("blocklist 只做格式清洗，收紧范围永远安全", () => {
    const raw = validRawPlan();
    (raw.initialQueries as Record<string, unknown>[])[1]!.domainBlocklist = [
      "Spam.Example",
      "https://bad.example/x",
    ];
    const result = expectOk(
      parseResearchPlan(raw, { mode: "standard", allowedDomains: ["example.com"] }),
    );
    expect(result.plan.initialQueries[1]!.domainBlocklist).toEqual(["spam.example"]);
  });
});

describe("清洗 6：拒绝空结构与未知枚举", () => {
  it.each([
    [
      "空 subquestions",
      (raw: Record<string, unknown>) => {
        raw.subquestions = [];
      },
    ],
    [
      "空 initialQueries",
      (raw: Record<string, unknown>) => {
        raw.initialQueries = [];
      },
    ],
    [
      "objective 为空白",
      (raw: Record<string, unknown>) => {
        raw.objective = "   ";
      },
    ],
    [
      "objective 缺失",
      (raw: Record<string, unknown>) => {
        delete raw.objective;
      },
    ],
    [
      "未知 timeRange 枚举",
      (raw: Record<string, unknown>) => {
        (raw.initialQueries as Record<string, unknown>[])[0]!.timeRange = "forever";
      },
    ],
    [
      "scope.timeRange 未知枚举",
      (raw: Record<string, unknown>) => {
        raw.scope = { timeRange: "forever" };
      },
    ],
    [
      "schemaVersion 不是 1",
      (raw: Record<string, unknown>) => {
        raw.schemaVersion = 2;
      },
    ],
    [
      "subquestion id 重复",
      (raw: Record<string, unknown>) => {
        (raw.subquestions as Record<string, unknown>[])[1]!.id = "sq_01";
      },
    ],
    [
      "subquestion id 为空",
      (raw: Record<string, unknown>) => {
        (raw.subquestions as Record<string, unknown>[])[0]!.id = "";
      },
    ],
  ])("拒绝：%s", (_name, mutate) => {
    const raw = validRawPlan();
    mutate(raw);
    const result = parseResearchPlan(raw, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, "plan", 42, []])("非对象输入 %s 被拒绝", (raw) => {
    const result = parseResearchPlan(raw, baseCtx);
    expect(result.ok).toBe(false);
  });

  it("schemaVersion 缺失时补 1 并记 warning", () => {
    const raw = validRawPlan();
    delete raw.schemaVersion;
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.schemaVersion).toBe(1);
    expect(result.warnings.some((w) => w.startsWith("[plan.schema_version_filled]"))).toBe(true);
  });
});

describe("清洗 7：单条查询文本超长截断", () => {
  it("超过 512 字符按 code point 截断并记 warning", () => {
    const raw = validRawPlan();
    raw.initialQueries = [{ queryId: "q_01", subquestionId: "sq_01", text: "字".repeat(600) }];
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect([...result.plan.initialQueries[0]!.text].length).toBe(512);
    expect(result.warnings.some((w) => w.startsWith("[plan.query_truncated]"))).toBe(true);
  });

  it("刚好 512 字符不触发 warning", () => {
    const raw = validRawPlan();
    raw.initialQueries = [{ queryId: "q_01", subquestionId: "sq_01", text: "字".repeat(512) }];
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.warnings).toEqual([]);
  });
});

describe("parseResearchPlan：其它健壮性", () => {
  it("缺失的 queryId 被自动补齐并记 warning", () => {
    const raw = validRawPlan();
    raw.initialQueries = [{ subquestionId: "sq_01", text: "a" }, { subquestionId: "sq_02", text: "b" }];
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    const ids = result.plan.initialQueries.map((item) => item.queryId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(result.warnings.some((w) => w.startsWith("[plan.query_id_assigned]"))).toBe(true);
  });

  it("重复的 queryId 被改写为唯一值", () => {
    const raw = validRawPlan();
    raw.initialQueries = [
      { queryId: "q_dup", subquestionId: "sq_01", text: "a" },
      { queryId: "q_dup", subquestionId: "sq_02", text: "b" },
    ];
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    const ids = result.plan.initialQueries.map((item) => item.queryId);
    expect(new Set(ids).size).toBe(2);
  });

  it("limit 超出 1..20 时被夹取并记 warning", () => {
    const raw = validRawPlan();
    (raw.initialQueries as Record<string, unknown>[])[0]!.limit = 500;
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.initialQueries[0]!.limit).toBe(20);
    expect(result.warnings.some((w) => w.startsWith("[plan.limit_clamped]"))).toBe(true);
  });

  it("completion 缺失时补默认阈值", () => {
    const raw = validRawPlan();
    delete raw.completion;
    const result = expectOk(parseResearchPlan(raw, baseCtx));
    expect(result.plan.completion.minSourcesPerSubquestion).toBeGreaterThan(0);
    expect(result.plan.completion.minimumRelevance).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PlannerDecision
// ---------------------------------------------------------------------------

const decisionCtx = {
  knownCandidateIds: ["c_1", "c_2"],
  subquestionIds: ["sq_01", "sq_02"],
} as const;

/// 断言 decision 解析成功并收窄类型。
function expectDecisionOk(result: ReturnType<typeof parsePlannerDecision>) {
  if (!result.ok) throw new Error(`期望解析成功，实际失败：${result.errors.join(" | ")}`);
  return result;
}

describe("parsePlannerDecision", () => {
  it("finish 决策原样通过", () => {
    const result = expectDecisionOk(
      parsePlannerDecision({ action: "finish", reason: "覆盖已足够" }, decisionCtx),
    );
    expect(result.decision).toEqual({ action: "finish", reason: "覆盖已足够" });
    expect(result.warnings).toEqual([]);
  });

  it("search_more 决策的合法查询原样通过", () => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        {
          action: "search_more",
          reason: "sq_02 缺一手来源",
          queries: [{ queryId: "q_10", subquestionId: "sq_02", text: "sandbox threat model" }],
        },
        decisionCtx,
      ),
    );
    expect(result.decision.action).toBe("search_more");
    if (result.decision.action !== "search_more") return;
    expect(result.decision.queries).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ["数组形式", ["c_1", "c_2"] as readonly string[]],
    ["Set 形式", new Set(["c_1", "c_2"]) as ReadonlySet<string>],
  ])("fetch_more 删除未知 candidateId（knownCandidateIds 为%s）", (_name, known) => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        { action: "fetch_more", reason: "补抓", candidateIds: ["c_1", "c_ghost", "c_2"] },
        { knownCandidateIds: known, subquestionIds: ["sq_01"] },
      ),
    );
    expect(result.decision.action).toBe("fetch_more");
    if (result.decision.action !== "fetch_more") return;
    expect(result.decision.candidateIds).toEqual(["c_1", "c_2"]);
    expect(result.warnings.some((w) => w.startsWith("[decision.unknown_candidate]"))).toBe(true);
  });

  it("fetch_more 的 candidateIds 去重", () => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        { action: "fetch_more", reason: "补抓", candidateIds: ["c_1", "c_1"] },
        decisionCtx,
      ),
    );
    if (result.decision.action !== "fetch_more") throw new Error("应为 fetch_more");
    expect(result.decision.candidateIds).toEqual(["c_1"]);
  });

  it("fetch_more 的 candidateIds 全部未知时降级为 finish", () => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        { action: "fetch_more", reason: "补抓", candidateIds: ["c_ghost"] },
        decisionCtx,
      ),
    );
    expect(result.decision.action).toBe("finish");
    expect(result.warnings.some((w) => w.startsWith("[decision.downgraded_to_finish]"))).toBe(true);
  });

  it("search_more 里引用未知 subquestionId 的查询被删除", () => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        {
          action: "search_more",
          reason: "补查",
          queries: [
            { queryId: "q_10", subquestionId: "sq_ghost", text: "a" },
            { queryId: "q_11", subquestionId: "sq_01", text: "b" },
          ],
        },
        decisionCtx,
      ),
    );
    if (result.decision.action !== "search_more") throw new Error("应为 search_more");
    expect(result.decision.queries.map((item) => item.queryId)).toEqual(["q_11"]);
    expect(result.warnings.some((w) => w.startsWith("[decision.invalid_subquestion]"))).toBe(true);
  });

  it("search_more 的查询被删空后降级为 finish", () => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        {
          action: "search_more",
          reason: "补查",
          queries: [{ queryId: "q_10", subquestionId: "sq_ghost", text: "a" }],
        },
        decisionCtx,
      ),
    );
    expect(result.decision.action).toBe("finish");
    expect(result.warnings.some((w) => w.startsWith("[decision.downgraded_to_finish]"))).toBe(true);
  });

  it("决策里的 URL 字段同样被丢弃", () => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        {
          action: "search_more",
          reason: "补查",
          urls: ["https://evil.example"],
          queries: [{ queryId: "q_10", subquestionId: "sq_01", text: "a", url: "https://evil.example" }],
        },
        decisionCtx,
      ),
    );
    expect(result.decision).not.toHaveProperty("urls");
    expect(result.warnings.some((w) => w.startsWith("[plan.url_dropped]"))).toBe(true);
  });

  it("search_more 的查询同样受 512 字符与去重约束", () => {
    const result = expectDecisionOk(
      parsePlannerDecision(
        {
          action: "search_more",
          reason: "补查",
          queries: [
            { queryId: "q_10", subquestionId: "sq_01", text: "字".repeat(600) },
            { queryId: "q_11", subquestionId: "sq_01", text: "DUP  text" },
            { queryId: "q_12", subquestionId: "sq_01", text: "dup text" },
          ],
        },
        decisionCtx,
      ),
    );
    if (result.decision.action !== "search_more") throw new Error("应为 search_more");
    expect([...result.decision.queries[0]!.text].length).toBe(512);
    expect(result.decision.queries.map((item) => item.queryId)).toEqual(["q_10", "q_11"]);
  });

  it.each([
    ["未知 action", { action: "hack_the_planet", reason: "x" }],
    ["缺 action", { reason: "x" }],
    ["非对象", "finish"],
    ["null", null],
  ])("拒绝：%s", (_name, raw) => {
    const result = parsePlannerDecision(raw, decisionCtx);
    expect(result.ok).toBe(false);
  });

  it("reason 缺失时补空串而不是拒绝", () => {
    const result = expectDecisionOk(parsePlannerDecision({ action: "finish" }, decisionCtx));
    expect(result.decision.reason).toBe("");
  });
});
