// 研究 MCP 工具集的注册与行为测试。
//
// 三个关注点：
//   1. 工具集随设置动态增减——关掉「深度研究」后 deep_research 必须从工具表里消失，
//      而不是留着等模型来调再报错（列在工具表里的东西，模型迟早会去调）；
//   2. Consumer 由 per-session 状态决定，未知会话回落到最窄的一档；
//   3. **不暴露任意 URL 的裸 fetch**——web_read 必须经 QuickRetrieval.prepare 过安全闸。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";
import type {
  DiscoveryRequest,
  DiscoveryResult,
  PreparedSourcesResult,
  PrepareSourcesRequest,
} from "@cortex-work/core/research/quick-types";

const settingsRef: { current: ResearchEngineSettings } = {
  current: {
    enabled: true,
    deepResearchEnabled: false,
    chatAutoRetrieve: false,
    slidesEnabled: false,
    writingEnabled: false,
    memoryEnabled: false,
    searchBackend: "direct",
  },
};
// 显式标注入参与返回类型：不写的话 vi.fn 推断出零参签名，
// mock.calls[0] 会是 never[]，断言拿不到入参。
const discover = vi.fn(
  async (_request: DiscoveryRequest): Promise<DiscoveryResult> => ({ leads: [], warnings: [] }),
);
const prepare = vi.fn(
  async (_request: PrepareSourcesRequest): Promise<PreparedSourcesResult> => ({
    documents: [],
    failures: [],
  }),
);

vi.mock("../../research/runtime", () => ({
  getResearchEngineSettings: () => settingsRef.current,
  getQuickRetrieval: () => ({ discover, prepare }),
  getResearchService: async () => ({ create: vi.fn(), run: vi.fn(), get: vi.fn() }),
}));

const { registerResearchTools, registerResearchSession, unregisterResearchSession } = await import(
  "./server"
);

/// McpServer 替身：只记录注册了哪些工具，并允许直接调用其 handler。
function fakeMcp() {
  const tools = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    tools,
    registerTool(name: string, _meta: unknown, handler: (args: unknown) => Promise<unknown>) {
      tools.set(name, handler);
    },
  };
}

beforeEach(() => {
  discover.mockClear();
  prepare.mockClear();
  settingsRef.current = { ...settingsRef.current, deepResearchEnabled: false };
  unregisterResearchSession("s1");
});

describe("registerResearchTools 工具集", () => {
  it("默认注册 web_search 与 web_read", () => {
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    expect([...mcp.tools.keys()]).toEqual(["web_search", "web_read"]);
  });

  it("深度研究开启时才注册 deep_research / research_status", () => {
    settingsRef.current = { ...settingsRef.current, deepResearchEnabled: true };
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    expect([...mcp.tools.keys()]).toEqual([
      "web_search",
      "web_read",
      "deep_research",
      "research_status",
    ]);
  });

  it("**不注册任何裸 fetch 工具**（SSRF 防线不能从工具表上开后门）", () => {
    settingsRef.current = { ...settingsRef.current, deepResearchEnabled: true };
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    for (const name of mcp.tools.keys()) {
      expect(name).not.toMatch(/^(fetch|http_request|curl|open_url)$/);
    }
  });
});

describe("Consumer 解析", () => {
  it("按 per-session 状态决定 Consumer", async () => {
    registerResearchSession("s1", "slides");
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    await mcp.tools.get("web_search")!({ query: "x" });
    expect(discover.mock.calls[0]![0]).toMatchObject({ consumer: "slides" });
  });

  it("未注册的会话回落到 chat（最窄的一档，不是最宽的）", async () => {
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "unknown-session" });
    await mcp.tools.get("web_search")!({ query: "x" });
    expect(discover.mock.calls[0]![0]).toMatchObject({ consumer: "chat" });
  });
});

describe("web_search 行为", () => {
  it("透传 category / time_range / limit", async () => {
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    await mcp.tools.get("web_search")!({
      query: "cortex",
      category: "news",
      time_range: "week",
      limit: 3,
    });
    expect(discover.mock.calls[0]![0]).toMatchObject({
      query: "cortex",
      categories: ["news"],
      timeRange: "week",
      limit: 3,
    });
  });

  it("零结果时把搜索源的失败原因说出来（否则 agent 会当成「确实没有」）", async () => {
    discover.mockResolvedValueOnce({ leads: [], warnings: ["搜索源 brave 未返回结果（rate_limited）"] });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as {
      content: [{ text: string }];
    };
    expect(result.content[0].text).toContain("rate_limited");
  });

  it("底层抛错时回 isError 结果而不是把异常抛给 MCP 层", async () => {
    discover.mockRejectedValueOnce(new Error("研究引擎未开启，请在设置中启用"));
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as {
      isError?: boolean;
      content: [{ text: string }];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未开启");
  });
});

describe("web_read 行为", () => {
  it("URL 交给 QuickRetrieval.prepare（安全闸在那一层，工具不自己发请求）", async () => {
    prepare.mockResolvedValueOnce({
      documents: [
        { url: "https://a.com/p", title: "T", text: "正文", truncated: false, fetchMethod: "http" },
      ],
      failures: [],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_read")!({
      urls: ["https://a.com/p"],
      objective: "o",
    })) as { content: [{ text: string }] };

    expect(prepare.mock.calls[0]![0]).toMatchObject({
      urls: ["https://a.com/p"],
      objective: "o",
    });
    expect(result.content[0].text).toContain("正文");
    expect(result.content[0].text).toContain("https://a.com/p");
  });

  it("全部失败时回 isError 并逐条说明原因", async () => {
    prepare.mockResolvedValueOnce({
      documents: [],
      failures: [{ url: "http://127.0.0.1/x", reason: "禁止访问本机地址" }],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_read")!({ urls: ["http://127.0.0.1/x"] })) as {
      isError?: boolean;
      content: [{ text: string }];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("禁止访问本机地址");
  });

  it("部分成功时正文照给，失败的另附说明", async () => {
    prepare.mockResolvedValueOnce({
      documents: [
        { url: "https://a.com/p", text: "有正文", truncated: true, fetchMethod: "http" },
      ],
      failures: [{ url: "https://b.com/q", reason: "HTTP 403" }],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_read")!({
      urls: ["https://a.com/p", "https://b.com/q"],
    })) as { isError?: boolean; content: [{ text: string }] };

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("有正文");
    expect(result.content[0].text).toContain("正文已截断");
    expect(result.content[0].text).toContain("HTTP 403");
  });
});

// ── 限流必须与「真的没命中」分流 ──────────────────────────────────────────────
//
// 真实事故：上游 Brave 免费档被打限流，web_search 一律回「没有搜到相关结果」。模型据此
// 判断"这个词没有结果"，于是换个词继续搜——并发更多、限流更重，用户看到的是
// 「一轮对话反复出现多次没有搜索到结果」。
//
// 这两种情形给模型的信号必须相反：没命中 → 换个说法再试；限流 → 停下别再搜。
describe("web_search 上游限流分流", () => {
  it("限流时明确说明是上游限流，而不是「没有搜到相关结果」", async () => {
    discover.mockResolvedValueOnce({
      leads: [],
      warnings: ["搜索源 brave 未返回结果（rate_limited）"],
      providerErrors: [{ provider: "brave", code: "rate_limited" }],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as {
      isError?: boolean;
      content: [{ text: string }];
    };
    expect(result.content[0].text).toContain("限流");
    expect(result.content[0].text).not.toContain("没有搜到相关结果");
  });

  /// 关键一条：必须明确劝阻立即重搜。否则模型的默认反应就是换个词再来一次。
  it("限流时告知模型不要立即重复搜索", async () => {
    discover.mockResolvedValueOnce({
      leads: [],
      warnings: [],
      providerErrors: [{ provider: "brave", code: "rate_limited" }],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as {
      content: [{ text: string }];
    };
    expect(result.content[0].text).toMatch(/不要(立即)?(重复|再)/);
  });

  /// 上游故障应当以 isError 呈现：模型对失败与空结果的处置本就不同，
  /// 把故障伪装成成功是这次事故的起点。
  it("上游故障回 isError（空结果不是成功）", async () => {
    discover.mockResolvedValueOnce({
      leads: [],
      warnings: [],
      providerErrors: [{ provider: "brave", code: "rate_limited" }],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("非限流的上游错误（auth_failed）同样分流为故障，并带上错误码", async () => {
    discover.mockResolvedValueOnce({
      leads: [],
      warnings: [],
      providerErrors: [{ provider: "brave", code: "auth_failed" }],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as {
      isError?: boolean;
      content: [{ text: string }];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("auth_failed");
  });

  /// 真的没命中仍走原路径：这是正常结果，不是错误，模型该换个说法再试。
  it("零结果且无上游错误 → 仍是「没有搜到相关结果」且不是 isError", async () => {
    discover.mockResolvedValueOnce({ leads: [], warnings: [] });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as {
      isError?: boolean;
      content: [{ text: string }];
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("没有搜到相关结果");
  });

  /// 有结果时限流警告只是附注，绝不能把一次成功的搜索标成失败。
  it("有结果 + 限流警告 → 正常返回结果，不标 isError", async () => {
    discover.mockResolvedValueOnce({
      leads: [{ url: "https://a.com/p", title: "T", domain: "a.com" }],
      warnings: ["搜索源 brave 未返回结果（rate_limited）"],
      providerErrors: [{ provider: "brave", code: "rate_limited" }],
    });
    const mcp = fakeMcp();
    registerResearchTools(mcp as never, { sessionId: "s1" });
    const result = (await mcp.tools.get("web_search")!({ query: "x" })) as {
      isError?: boolean;
      content: [{ text: string }];
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("找到 1 条线索");
  });
});
