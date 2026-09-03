// 会话内前置检索的测试。
//
// 最关键的一条：**检索绝不阻断发送**。超时、报错、桥缺失都要静默降级，
// 而不是把异常抛回发送路径——那会让一次网络抖动变成"消息发不出去"。
import { describe, expect, it, vi } from "vitest";
import type { ResearchEngineSettings } from "./settings";
import type { GatherResult } from "./quick-types";

import { retrieveChatEvidence, retrieveChatEvidenceDetailed, shouldAutoRetrieve } from "./chat-retrieval";

const ON: ResearchEngineSettings = {
  enabled: true,
  deepResearchEnabled: false,
  chatAutoRetrieve: true,
  writingEnabled: false,
  memoryEnabled: false,
  searchBackend: "direct",
};

function gatherOk(documents: GatherResult["documents"]) {
  return vi.fn(async () => ({ documents, failures: [], warnings: [] }));
}

const DOC = {
  url: "https://a.com/p",
  title: "标题",
  text: "网页正文",
  truncated: false,
  fetchMethod: "http" as const,
};

describe("shouldAutoRetrieve", () => {
  it("总开关 + 会话级联网 + 自动检索三者全开才为 true", () => {
    expect(shouldAutoRetrieve(ON, true)).toBe(true);
  });

  it.each([
    ["总开关关闭", { enabled: false }],
    ["自动检索本身关闭", { chatAutoRetrieve: false }],
  ])("%s → false", (_name, patch) => {
    expect(shouldAutoRetrieve({ ...ON, ...patch }, true)).toBe(false);
  });

  it("settings 缺失 → false", () => {
    expect(shouldAutoRetrieve(undefined, true)).toBe(false);
  });

  /// 这条是信任边界：用户没在这个会话上打开「联网」，就不该有任何联网发生——
  /// 即便全局的「总是先检索再回答」开着。会话级开关是最终裁决者。
  it("chatAutoRetrieve 依赖会话级联网开关，后者关闭时前者不生效", () => {
    expect(shouldAutoRetrieve({ ...ON, chatAutoRetrieve: true }, false)).toBe(false);
  });
});

describe("retrieveChatEvidence 门控", () => {
  it("功能未开时返回 undefined，且一次检索都不发", async () => {
    const gather = gatherOk([DOC]);
    const result = await retrieveChatEvidence({
      gather,
      settings: { ...ON, chatAutoRetrieve: false },
      sessionWebSearch: true,
      query: "问题",
    });
    expect(result).toBeUndefined();
    expect(gather).not.toHaveBeenCalled();
  });

  /// 会话没开联网 → 一次检索都不发。全局开关再怎么开也越不过这一关。
  it("会话级联网关闭时返回 undefined，且一次检索都不发", async () => {
    const gather = gatherOk([DOC]);
    const result = await retrieveChatEvidence({
      gather,
      settings: ON,
      sessionWebSearch: false,
      query: "问题",
    });
    expect(result).toBeUndefined();
    expect(gather).not.toHaveBeenCalled();
  });

  it("桥没有 gather（Web 端 / 旧壳）→ undefined", async () => {
    expect(
      await retrieveChatEvidence({
        gather: undefined,
        settings: ON,
        sessionWebSearch: true,
        query: "问题",
      }),
    ).toBeUndefined();
  });

  it("空查询 → undefined，不发无意义的检索", async () => {
    const gather = gatherOk([DOC]);
    expect(
      await retrieveChatEvidence({ gather, settings: ON, sessionWebSearch: true, query: "   " }),
    ).toBeUndefined();
    expect(gather).not.toHaveBeenCalled();
  });
});

describe("retrieveChatEvidence 结果", () => {
  it("成功时返回含来源 URL 的证据段", async () => {
    const result = await retrieveChatEvidence({
      gather: gatherOk([DOC]),
      settings: ON,
      sessionWebSearch: true,
      query: "问题",
    });
    expect(result).toContain("网页正文");
    expect(result).toContain("https://a.com/p");
  });

  it("用消息原文当查询词，consumer 固定 chat", async () => {
    const gather = gatherOk([DOC]);
    await retrieveChatEvidence({
      gather,
      settings: ON,
      sessionWebSearch: true,
      query: "  今天的新闻  ",
    });
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: "今天的新闻" });
  });

  /// 开着功能却什么都没拿到时，**必须**让模型知道——否则它会像平时一样凭训练数据
  /// 回答时效性问题，而用户以为答案是刚查的（spec §15.1）。
  it("零结果时回「没能验证最新信息」的说明段，而不是 undefined", async () => {
    const result = await retrieveChatEvidence({
      gather: gatherOk([]),
      settings: ON,
      sessionWebSearch: true,
      query: "问题",
    });
    expect(result).toContain("没能验证最新信息");
  });
});

describe("retrieveChatEvidence 不阻断发送", () => {
  /// 故障 ≠ 搜到 0 条。故障时**不能**注入声称"检索已执行"的说明段：模型的工具记录里没有
  /// 任何检索动作，读到那种提示会转而向用户解释系统提示的来源（上线首日的真实事故）。
  it("底层抛错时吞掉，回故障说明段并带上原因", async () => {
    const gather = vi.fn(async () => {
      throw new Error("尚未配置研究搜索服务");
    });
    const result = await retrieveChatEvidence({
      gather,
      settings: ON,
      sessionWebSearch: true,
      query: "问题",
    });
    expect(result).toContain("没有执行成功");
    expect(result).toContain("尚未配置研究搜索服务"); // 原因透出，用户才有排查线索
    expect(result).not.toContain("已执行联网检索");
  });

  it("超时回故障说明段（而不是「搜到 0 条」），不无限等待", async () => {
    vi.useFakeTimers();
    try {
      const gather = vi.fn(() => new Promise<GatherResult>(() => {})); // 永不 resolve
      const promise = retrieveChatEvidence({
        gather,
        settings: ON,
        sessionWebSearch: true,
        query: "问题",
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;
      expect(result).toContain("没有执行成功");
      expect(result).toContain("超时");
    } finally {
      vi.useRealTimers();
    }
  });

  /// 真的搜到 0 条走另一段：检索确实跑过，说"已执行"是准确的。
  it("搜到 0 条时回零结果说明段，与故障段区分", async () => {
    const result = await retrieveChatEvidence({
      gather: gatherOk([]),
      settings: ON,
      sessionWebSearch: true,
      query: "问题",
    });
    expect(result).toContain("已执行联网检索");
    expect(result).not.toContain("没有执行成功");
  });
});

describe("retrieveChatEvidenceDetailed（结构化旁路）", () => {
  it("功能关/无桥/空查询 → disabled + 无 append（与旧 undefined 语义一一对应）", async () => {
    const off = await retrieveChatEvidenceDetailed({
      gather: gatherOk([]),
      settings: { ...ON, chatAutoRetrieve: false },
      sessionWebSearch: true,
      query: "q",
    });
    expect(off).toEqual({ append: undefined, outcome: "disabled", documentCount: 0 });

    const noBridge = await retrieveChatEvidenceDetailed({
      gather: undefined,
      settings: ON,
      sessionWebSearch: true,
      query: "q",
    });
    expect(noBridge.outcome).toBe("disabled");
  });

  it("命中 N 条 → ok + documentCount，append 与旧函数逐字一致", async () => {
    const gather = gatherOk([DOC]);
    const detailed = await retrieveChatEvidenceDetailed({
      gather,
      settings: ON,
      sessionWebSearch: true,
      query: "q",
    });
    expect(detailed.outcome).toBe("ok");
    expect(detailed.documentCount).toBe(1);
    const legacy = await retrieveChatEvidence({
      gather: gatherOk([DOC]),
      settings: ON,
      sessionWebSearch: true,
      query: "q",
    });
    expect(detailed.append).toBe(legacy);
  });

  it("零结果 → empty（append 为零结果说明,非 undefined）", async () => {
    const detailed = await retrieveChatEvidenceDetailed({
      gather: gatherOk([]),
      settings: ON,
      sessionWebSearch: true,
      query: "q",
    });
    expect(detailed.outcome).toBe("empty");
    expect(detailed.documentCount).toBe(0);
    expect(detailed.append).toBeDefined();
  });

  it("gather 抛错 → failed（append 为故障说明）", async () => {
    const detailed = await retrieveChatEvidenceDetailed({
      gather: async () => {
        throw new Error("网络失败");
      },
      settings: ON,
      sessionWebSearch: true,
      query: "q",
    });
    expect(detailed.outcome).toBe("failed");
    expect(detailed.append).toContain("网络失败");
  });
});
