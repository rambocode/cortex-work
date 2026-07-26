// 会话内前置检索的测试。
//
// 最关键的一条：**检索绝不阻断发送**。超时、报错、桥缺失都要静默降级，
// 而不是把异常抛回发送路径——那会让一次网络抖动变成"消息发不出去"。
import { describe, expect, it, vi } from "vitest";
import type { ResearchEngineSettings } from "./settings";
import type { GatherResult } from "./quick-types";

import { retrieveChatEvidence, shouldAutoRetrieve } from "./chat-retrieval";

const ON: ResearchEngineSettings = {
  enabled: true,
  deepResearchEnabled: false,
  chatEnabled: true,
  chatAutoRetrieve: true,
  slidesEnabled: false,
  writingEnabled: false,
  memoryEnabled: false,
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
  it("三个开关全开才为 true", () => {
    expect(shouldAutoRetrieve(ON)).toBe(true);
  });

  it.each([
    ["总开关关闭", { enabled: false }],
    ["会话内检索关闭", { chatEnabled: false }],
    ["自动检索本身关闭", { chatAutoRetrieve: false }],
  ])("%s → false", (_name, patch) => {
    expect(shouldAutoRetrieve({ ...ON, ...patch })).toBe(false);
  });

  it("settings 缺失 → false", () => {
    expect(shouldAutoRetrieve(undefined)).toBe(false);
  });

  /// 这条是信任边界：用户在 UI 上关掉了「会话内检索」，就不该再有任何联网发生。
  it("chatAutoRetrieve 依赖 chatEnabled，后者关掉时前者不生效", () => {
    expect(shouldAutoRetrieve({ ...ON, chatEnabled: false, chatAutoRetrieve: true })).toBe(false);
  });
});

describe("retrieveChatEvidence 门控", () => {
  it("功能未开时返回 undefined，且一次检索都不发", async () => {
    const gather = gatherOk([DOC]);
    const result = await retrieveChatEvidence({
      gather,
      settings: { ...ON, chatAutoRetrieve: false },
      query: "问题",
    });
    expect(result).toBeUndefined();
    expect(gather).not.toHaveBeenCalled();
  });

  it("桥没有 gather（Web 端 / 旧壳）→ undefined", async () => {
    expect(
      await retrieveChatEvidence({ gather: undefined, settings: ON, query: "问题" }),
    ).toBeUndefined();
  });

  it("空查询 → undefined，不发无意义的检索", async () => {
    const gather = gatherOk([DOC]);
    expect(await retrieveChatEvidence({ gather, settings: ON, query: "   " })).toBeUndefined();
    expect(gather).not.toHaveBeenCalled();
  });
});

describe("retrieveChatEvidence 结果", () => {
  it("成功时返回含来源 URL 的证据段", async () => {
    const result = await retrieveChatEvidence({
      gather: gatherOk([DOC]),
      settings: ON,
      query: "问题",
    });
    expect(result).toContain("网页正文");
    expect(result).toContain("https://a.com/p");
  });

  it("用消息原文当查询词，consumer 固定 chat", async () => {
    const gather = gatherOk([DOC]);
    await retrieveChatEvidence({ gather, settings: ON, query: "  今天的新闻  " });
    expect(gather).toHaveBeenCalledWith({ consumer: "chat", query: "今天的新闻" });
  });

  /// 开着功能却什么都没拿到时，**必须**让模型知道——否则它会像平时一样凭训练数据
  /// 回答时效性问题，而用户以为答案是刚查的（spec §15.1）。
  it("零结果时回「没能验证最新信息」的说明段，而不是 undefined", async () => {
    const result = await retrieveChatEvidence({
      gather: gatherOk([]),
      settings: ON,
      query: "问题",
    });
    expect(result).toContain("没能验证最新信息");
  });
});

describe("retrieveChatEvidence 不阻断发送", () => {
  it("底层抛错时吞掉，回说明段而不是把异常抛给发送路径", async () => {
    const gather = vi.fn(async () => {
      throw new Error("尚未配置研究搜索服务");
    });
    const result = await retrieveChatEvidence({ gather, settings: ON, query: "问题" });
    expect(result).toContain("没能验证最新信息");
  });

  it("超时后照常返回说明段，不无限等待", async () => {
    vi.useFakeTimers();
    try {
      const gather = vi.fn(() => new Promise<GatherResult>(() => {})); // 永不 resolve
      const promise = retrieveChatEvidence({
        gather,
        settings: ON,
        query: "问题",
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(await promise).toContain("没能验证最新信息");
    } finally {
      vi.useRealTimers();
    }
  });
});
