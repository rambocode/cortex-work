// 研究 MCP 注入配置的门控测试。
//
// 这是「agent 联网」的开关闸。三条门控各自防一类问题：
//   - 开关门控：用户关掉的东西必须真的关得掉。chat 看会话级 sessionOptIn（用户在该会话
//     输入框上的明确选择），其余 Consumer 看各自的全局灰度开关；
//   - 后端门控：搜索后端没配好时**不注入**，而不是注入一个每次调用都失败的工具——
//     后者会让 agent 反复重试把整轮对话烧掉，用户只看到"联网坏了"；
//   - host 门控：host 没起来时不注入，避免给 agent 一个连不上的 url。
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

/// 基线：选中 Search Server 后端且它配全了。searchBackend 必须与所配的那一条**自洽** ——
/// 后端是单选，hasSearchBackend 只看选中的那条，「选 direct 却只配了 server」是配不出来的状态。
function settings(overrides: Partial<ResearchEngineSettings> = {}): ResearchEngineSettings {
  return {
    enabled: true,
    deepResearchEnabled: false,
    chatAutoRetrieve: false,
    slidesEnabled: false,
    writingEnabled: false,
    memoryEnabled: false,
    searchBackend: "server",
    searchServer: CONFIGURED_SERVER,
    ...overrides,
  };
}

/// chat consumer 的常规调用：本会话已由用户在输入框上明确开启联网。
/// 后端 / host / 鉴权那几组用例关心的都不是会话开关本身，用它把噪音收敛掉；
/// 会话开关的门控另有一组用例专测。
///
/// sessionId 刻意**没有默认值**：默认参数会把显式传入的 undefined 也替换掉，
/// 让「无 sessionId」那条用例静默测到 "s1"（踩过一次）。
function buildChat(
  s: ResearchEngineSettings | undefined,
  sessionId: string | undefined,
): ReturnType<typeof buildResearchMcpServerConfig> {
  return buildResearchMcpServerConfig(s, sessionId, "chat", true);
}

beforeEach(() => {
  handleRef.current = handle;
  unregisterResearchSession("s1");
});

describe("buildResearchMcpServerConfig 开关门控", () => {
  it("配置齐全 + 会话已开联网 → 返回注入配置", () => {
    const config = buildChat(settings(), "s1");
    expect(config?.id).toBe(RESEARCH_SERVER_ID);
    expect(config?.transport).toBe("http");
    expect(config?.url).toContain("127.0.0.1:51234");
  });

  it("settings 整体缺失（旧配置 / 全新 profile）→ null", () => {
    expect(buildChat(undefined, "s1")).toBeNull();
  });

  it("总开关关闭 → null（会话开了联网也不越过总开关）", () => {
    expect(buildChat(settings({ enabled: false }), "s1")).toBeNull();
  });

  /// chat 的准入完全由会话级选择决定：全局已不再有 chat 灰度开关。
  it("会话未开联网 → null", () => {
    expect(buildResearchMcpServerConfig(settings(), "s1", "chat", false)).toBeNull();
  });

  /// 缺省必须是「不注入」：出站能力的默认要落在保守那一侧，
  /// 漏传参数的调用点应当退化为「没有联网」而不是「悄悄联网」。
  it("sessionOptIn 缺省（未传第 4 参）→ null", () => {
    expect(buildResearchMcpServerConfig(settings(), "s1")).toBeNull();
    expect(buildResearchMcpServerConfig(settings(), "s1", "chat")).toBeNull();
  });

  it("slides consumer 看 slidesEnabled，不受会话级联网开关影响", () => {
    const noSlides = settings({ slidesEnabled: false });
    expect(buildResearchMcpServerConfig(noSlides, "s1", "slides", true)).toBeNull();

    const onlySlides = settings({ slidesEnabled: true });
    expect(buildResearchMcpServerConfig(onlySlides, "s1", "slides", false)).not.toBeNull();
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
    expect(buildChat(bare, "s1")).toBeNull();
  });

  it("Search Server 只配了一半（缺令牌）→ null", () => {
    const half = settings({
      searchServer: { baseUrl: "https://search.example.com", workspaceId: "ws-1" },
    });
    expect(buildChat(half, "s1")).toBeNull();
  });

  it("选直连 + 密钥已配 → 注入", () => {
    const direct = settings({
      searchBackend: "direct",
      directSearch: { provider: "brave", encryptedApiKey: "CIPHER" },
    });
    delete direct.searchServer;
    expect(buildChat(direct, "s1")).not.toBeNull();
  });

  it("选直连 + 只选了供应商没填密钥 → null", () => {
    const direct = settings({ searchBackend: "direct", directSearch: { provider: "brave" } });
    delete direct.searchServer;
    expect(buildChat(direct, "s1")).toBeNull();
  });

  /// 后端单选：**没选中的那条配得再全也不算**。这两条守的是「设置页显示的后端与实际注入
  /// 判定同源」——否则会出现 pill 可点、agent 拿到工具、调用时才报「搜索服务未配置」。
  it("选直连但只配了 Search Server → null（不看没选中的那条）", () => {
    expect(buildChat(settings({ searchBackend: "direct" }), "s1")).toBeNull();
  });

  /// **入参按原始磁盘值对待、内部归一化**。调用方（cli.ts / pi-session.ts）拿到的是
  /// getPersistedState() 的原始切片，`searchBackend` 这个键在所有升级上来的配置里都不存在
  /// （用户没动过设置页就一直没有）。若不归一化，`raw.searchBackend === "server"` 恒为 false，
  /// 判定会掉进直连分支——而实际执行侧的 createSearchClient 用的是归一化快照、走 Search Server。
  /// 两侧认定的后端不是同一条，就会出现「注入了工具但调用时报未配置」或反过来「明明配好了却没工具」。
  it("searchBackend 缺失（旧配置）+ Search Server 配全 → 按迁移推断注入", () => {
    const legacy = settings();
    delete (legacy as { searchBackend?: unknown }).searchBackend;
    expect(buildChat(legacy, "s1")).not.toBeNull();
  });

  it("searchBackend 缺失 + 只配了直连密钥 → 按迁移推断（direct）注入", () => {
    const legacy = settings({ directSearch: { provider: "brave", encryptedApiKey: "CIPHER" } });
    delete (legacy as { searchBackend?: unknown }).searchBackend;
    delete legacy.searchServer;
    expect(buildChat(legacy, "s1")).not.toBeNull();
  });

  /// 脏值（手改过的配置文件）同样不能绕过判定：归一化把非法枚举折回推断值。
  it("searchBackend 是非法值 + 两条都没配 → null", () => {
    const dirty = settings({ searchBackend: "elasticsearch" as never });
    delete dirty.searchServer;
    expect(buildChat(dirty, "s1")).toBeNull();
  });

  it("选 Search Server 但只配了直连密钥 → null", () => {
    const s = settings({
      searchBackend: "server",
      directSearch: { provider: "brave", encryptedApiKey: "CIPHER" },
    });
    delete s.searchServer;
    expect(buildChat(s, "s1")).toBeNull();
  });
});

describe("buildResearchMcpServerConfig host 门控与鉴权", () => {
  it("host 未起 → null", () => {
    handleRef.current = null;
    expect(buildChat(settings(), "s1")).toBeNull();
  });

  it("host 不可用 / 端口非法 → null", () => {
    handleRef.current = { ...handle, serverAvailable: false };
    expect(buildChat(settings(), "s1")).toBeNull();
    handleRef.current = { ...handle, port: 0 };
    expect(buildChat(settings(), "s1")).toBeNull();
  });

  it("token 走 Authorization 头，**不进 URL**（URL 会泄进日志与进程参数）", () => {
    const config = buildChat(settings(), "s1");
    expect(config?.headers?.Authorization).toBe("Bearer host-token");
    expect(config?.url).not.toContain("host-token");
  });

  it("sessionId 经 X-Cortex-Session 头传给 server（供其查本会话的 Consumer）", () => {
    const config = buildChat(settings(), "s1");
    expect(config?.headers?.["X-Cortex-Session"]).toBe("s1");
  });

  it("无 sessionId 时不发该头（server 端会回落到最窄的 chat）", () => {
    const config = buildChat(settings(), undefined);
    expect(config?.headers?.["X-Cortex-Session"]).toBeUndefined();
  });
});
