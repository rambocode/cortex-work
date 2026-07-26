// 研究 MCP 注入配置的门控测试。
//
// 这是「agent 联网」的开关闸。两条门控各自防一类问题：
//   - 开关门控：用户关掉的东西必须真的关得掉（灰度开关是按 Consumer 分的）；
//   - 后端门控：搜索后端没配好时**不注入**，而不是注入一个每次调用都失败的工具——
//     后者会让 agent 反复重试把整轮对话烧掉，用户只看到"联网坏了"。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";

import { buildResearchMcpServerConfig } from "./inject";
import { RESEARCH_SERVER_ID, unregisterResearchSession } from "./server";

/// host handle 替身：默认可用。
const handle = { port: 51234, token: "host-token", serverAvailable: true };
vi.mock("./server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server")>();
  return {
    ...actual,
    getResearchHostHandle: () => handleRef.current,
  };
});
const handleRef: { current: typeof handle | null } = { current: handle };

const CONFIGURED_SERVER: ResearchEngineSettings["searchServer"] = {
  baseUrl: "https://search.example.com",
  workspaceId: "ws-1",
  encryptedToken: "CIPHER",
};

function settings(overrides: Partial<ResearchEngineSettings> = {}): ResearchEngineSettings {
  return {
    enabled: true,
    deepResearchEnabled: false,
    chatEnabled: true,
    chatAutoRetrieve: false,
    slidesEnabled: false,
    writingEnabled: false,
    memoryEnabled: false,
    searchServer: CONFIGURED_SERVER,
    ...overrides,
  };
}

beforeEach(() => {
  handleRef.current = handle;
  unregisterResearchSession("s1");
});

describe("buildResearchMcpServerConfig 开关门控", () => {
  it("配置齐全时返回注入配置", () => {
    const config = buildResearchMcpServerConfig(settings(), "s1");
    expect(config?.id).toBe(RESEARCH_SERVER_ID);
    expect(config?.transport).toBe("http");
    expect(config?.url).toContain("127.0.0.1:51234");
  });

  it("settings 整体缺失（旧配置 / 全新 profile）→ null", () => {
    expect(buildResearchMcpServerConfig(undefined, "s1")).toBeNull();
  });

  it("总开关关闭 → null", () => {
    expect(buildResearchMcpServerConfig(settings({ enabled: false }), "s1")).toBeNull();
  });

  it("会话内检索开关关闭 → null（chat consumer 受 chatEnabled 约束）", () => {
    expect(buildResearchMcpServerConfig(settings({ chatEnabled: false }), "s1")).toBeNull();
  });

  it("slides consumer 看 slidesEnabled，不看 chatEnabled", () => {
    const onlyChat = settings({ chatEnabled: true, slidesEnabled: false });
    expect(buildResearchMcpServerConfig(onlyChat, "s1", "slides")).toBeNull();

    const onlySlides = settings({ chatEnabled: false, slidesEnabled: true });
    expect(buildResearchMcpServerConfig(onlySlides, "s1", "slides")).not.toBeNull();
  });

  it("writing consumer 看 writingEnabled", () => {
    expect(buildResearchMcpServerConfig(settings(), "s1", "writing")).toBeNull();
    expect(
      buildResearchMcpServerConfig(settings({ writingEnabled: true }), "s1", "writing"),
    ).not.toBeNull();
  });
});

describe("buildResearchMcpServerConfig 后端门控", () => {
  it("完全没配搜索后端 → null（不给 agent 一个必然失败的工具）", () => {
    const bare = settings();
    delete bare.searchServer;
    expect(buildResearchMcpServerConfig(bare, "s1")).toBeNull();
  });

  it("Search Server 只配了一半（缺令牌）→ null", () => {
    const half = settings({
      searchServer: { baseUrl: "https://search.example.com", workspaceId: "ws-1" },
    });
    expect(buildResearchMcpServerConfig(half, "s1")).toBeNull();
  });

  it("只配了直连搜索也算配好了（逃生阀的全部意义）", () => {
    const direct = settings({ directSearch: { provider: "brave", encryptedApiKey: "CIPHER" } });
    delete direct.searchServer;
    expect(buildResearchMcpServerConfig(direct, "s1")).not.toBeNull();
  });

  it("直连搜索只选了供应商没填密钥 → null", () => {
    const direct = settings({ directSearch: { provider: "brave" } });
    delete direct.searchServer;
    expect(buildResearchMcpServerConfig(direct, "s1")).toBeNull();
  });
});

describe("buildResearchMcpServerConfig host 门控与鉴权", () => {
  it("host 未起 → null", () => {
    handleRef.current = null;
    expect(buildResearchMcpServerConfig(settings(), "s1")).toBeNull();
  });

  it("host 不可用 / 端口非法 → null", () => {
    handleRef.current = { ...handle, serverAvailable: false };
    expect(buildResearchMcpServerConfig(settings(), "s1")).toBeNull();
    handleRef.current = { ...handle, port: 0 };
    expect(buildResearchMcpServerConfig(settings(), "s1")).toBeNull();
  });

  it("token 走 Authorization 头，**不进 URL**（URL 会泄进日志与进程参数）", () => {
    const config = buildResearchMcpServerConfig(settings(), "s1");
    expect(config?.headers?.Authorization).toBe("Bearer host-token");
    expect(config?.url).not.toContain("host-token");
  });

  it("sessionId 经 X-Cortex-Session 头传给 server（供其查本会话的 Consumer）", () => {
    const config = buildResearchMcpServerConfig(settings(), "s1");
    expect(config?.headers?.["X-Cortex-Session"]).toBe("s1");
  });

  it("无 sessionId 时不发该头（server 端会回落到最窄的 chat）", () => {
    const config = buildResearchMcpServerConfig(settings(), undefined);
    expect(config?.headers?.["X-Cortex-Session"]).toBeUndefined();
  });
});
