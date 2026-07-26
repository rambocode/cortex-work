// settings.ts 的归一化测试。设置来自磁盘 JSON（可能是旧版本写的、被手改过的、甚至是 null），
// 所以 normalizeResearchEngineSettings 必须对任意 unknown 输入都给出可用结果，绝不抛错。
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESEARCH_ENGINE_SETTINGS,
  hasSearchBackend,
  normalizeResearchEngineSettings,
  type ResearchEngineSettings,
} from "./settings";

describe("DEFAULT_RESEARCH_ENGINE_SETTINGS", () => {
  it("所有开关默认关闭（新能力必须显式开启）", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.deepResearchEnabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.chatAutoRetrieve).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.writingEnabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.memoryEnabled).toBe(false);
  });

  /// chat 场景已改为会话级开关（SessionMeta.webSearch），全局不再有这一项。
  /// 留一个没有 UI、没有读者的字段就是死代码，且会诱使后续代码去读它。
  it("不再有 chat 场景的全局灰度开关", () => {
    expect("chatEnabled" in DEFAULT_RESEARCH_ENGINE_SETTINGS).toBe(false);
  });

  it("不再有 slides 场景的全局灰度开关", () => {
    expect("slidesEnabled" in DEFAULT_RESEARCH_ENGINE_SETTINGS).toBe(false);
  });

  it("默认不指定研究模型（跟随全局默认模型）", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.modelProviderId).toBeUndefined();
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.modelId).toBeUndefined();
  });

  it("默认不带 searchServer 配置", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.searchServer).toBeUndefined();
  });

  /// 两条搜索路径是**单选**（不并存）。默认直连：绝大多数人不会自建 Search Server，
  /// 让默认落在"填个 API key 就能用"的那一档。
  it("默认搜索后端是直连", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.searchBackend).toBe("direct");
  });
});

describe("normalizeResearchEngineSettings", () => {
  const cases: Array<{ name: string; raw: unknown; expected: ResearchEngineSettings }> = [
    { name: "undefined 取全默认", raw: undefined, expected: DEFAULT_RESEARCH_ENGINE_SETTINGS },
    { name: "null 取全默认", raw: null, expected: DEFAULT_RESEARCH_ENGINE_SETTINGS },
    { name: "非对象（字符串）取全默认", raw: "enabled", expected: DEFAULT_RESEARCH_ENGINE_SETTINGS },
    { name: "数组取全默认", raw: [], expected: DEFAULT_RESEARCH_ENGINE_SETTINGS },
    { name: "空对象取全默认", raw: {}, expected: DEFAULT_RESEARCH_ENGINE_SETTINGS },
    {
      name: "部分字段：缺失项回落默认",
      raw: { enabled: true, chatAutoRetrieve: true },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, enabled: true, chatAutoRetrieve: true },
    },
    {
      // 出站策略枚举已移除：旧版本写入的这个键必须被白名单重建自然丢弃，
      // 不能作为未知字段残留在归一化结果里（否则设置页写回时又落回磁盘）。
      name: "旧版本的 defaultModelDataPolicy 被丢弃",
      raw: { enabled: true, defaultModelDataPolicy: "local_only" },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, enabled: true },
    },
    {
      // chat 改为会话级开关后，旧配置里的 chatEnabled 同样靠白名单重建自然丢弃，
      // 无需专门的迁移代码。**不能残留**：残留会在设置页写回时又落回磁盘，
      // 也会让日后误读它的代码「看起来能工作」。
      name: "旧版本的 chatEnabled 被丢弃",
      raw: { enabled: true, chatEnabled: true },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, enabled: true },
    },
    {
      name: "旧版本的 slidesEnabled 被丢弃",
      raw: { enabled: true, slidesEnabled: true },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, enabled: true },
    },
    {
      name: "研究模型偏好保留（含前后空白裁剪）",
      raw: { modelProviderId: " ollama ", modelId: "qwen3:8b" },
      expected: {
        ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
        modelProviderId: "ollama",
        modelId: "qwen3:8b",
      },
    },
    {
      // UI 的「跟随全局默认」选项提交空串，必须折叠回「未设置」，
      // 否则设置里会留下 modelId: "" 这种脏值，选型时还要多绕一圈匹配。
      name: "空串 / 纯空白的模型偏好等同未设置",
      raw: { modelProviderId: "", modelId: "   " },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      name: "非字符串的模型偏好被丢弃",
      raw: { modelProviderId: 123, modelId: { id: "x" } },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      name: "非布尔开关（字符串 'true'）不算 true",
      raw: { enabled: "true", memoryEnabled: 1 },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      name: "多余字段被丢弃",
      raw: { enabled: true, __proto__hack: 1, apiKey: "plaintext", nested: { a: 1 } },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, enabled: true },
    },
    {
      // searchBackend 缺失 + Search Server 配全 → 推断为 server（迁移推断，详见下面那个 describe）。
      name: "完整 searchServer 保留",
      raw: {
        enabled: true,
        searchServer: { baseUrl: "https://s.example.com", workspaceId: "ws_1", encryptedToken: "AQID" },
      },
      expected: {
        ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
        enabled: true,
        searchBackend: "server",
        searchServer: { baseUrl: "https://s.example.com", workspaceId: "ws_1", encryptedToken: "AQID" },
      },
    },
    {
      name: "searchServer 缺 baseUrl 时整段丢弃（半截配置不如没有）",
      raw: { searchServer: { workspaceId: "ws_1" } },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      name: "searchServer 非对象时丢弃",
      raw: { searchServer: "https://s.example.com" },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      name: "searchServer 的 encryptedToken 非字符串时丢弃该字段但保留其余",
      raw: { searchServer: { baseUrl: "https://s.example.com", workspaceId: "ws_1", encryptedToken: 42 } },
      expected: {
        ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
        searchServer: { baseUrl: "https://s.example.com", workspaceId: "ws_1" },
      },
    },
    {
      name: "完整 directSearch 保留",
      raw: { enabled: true, directSearch: { provider: "brave", encryptedApiKey: "AQID" } },
      expected: {
        ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
        enabled: true,
        directSearch: { provider: "brave", encryptedApiKey: "AQID" },
      },
    },
    {
      // provider 是**已支持供应商**的封闭枚举。留一个不认识的值会让 runtime 拿它去查
      // DIRECT_SEARCH_PROVIDERS 得到 undefined，再在构造请求时炸在很远的地方。
      name: "directSearch 的 provider 非法枚举时整段丢弃",
      raw: { directSearch: { provider: "google", encryptedApiKey: "AQID" } },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      name: "directSearch 非对象时丢弃",
      raw: { directSearch: "brave" },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      // 只选了供应商还没填 key 是设置页上的正常中间态，必须能存下来。
      name: "directSearch 缺 encryptedApiKey 时保留 provider",
      raw: { directSearch: { provider: "tavily" } },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, directSearch: { provider: "tavily" } },
    },
    {
      name: "directSearch 的 encryptedApiKey 非字符串时丢弃该字段但保留 provider",
      raw: { directSearch: { provider: "tavily", encryptedApiKey: 42 } },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, directSearch: { provider: "tavily" } },
    },
    {
      name: "显式 searchBackend 原样保留",
      raw: { searchBackend: "direct" },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, searchBackend: "direct" },
    },
    {
      name: "searchBackend 非法枚举 → 回落推断（此处无 searchServer → direct）",
      raw: { searchBackend: "elasticsearch" },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
  ];

  it.each(cases)("$name", ({ raw, expected }) => {
    expect(normalizeResearchEngineSettings(raw)).toEqual(expected);
  });

  it("不会把 DEFAULT_RESEARCH_ENGINE_SETTINGS 本身返回出去（防止调用方就地改默认值）", () => {
    const normalized = normalizeResearchEngineSettings({});
    expect(normalized).not.toBe(DEFAULT_RESEARCH_ENGINE_SETTINGS);
  });
});

/// searchBackend 是单选改造新加的键，旧配置里一定没有它。**不能一律回落 default("direct")**：
/// 已经部署并配好 Search Server 的用户升级后会突然走到"直连但没填 key"，联网直接失效，
/// 而界面上他的 Search Server 明明是「已配置」。所以缺失时按既有实际生效项推断。
describe("normalizeResearchEngineSettings 的 searchBackend 迁移推断", () => {
  const FULL_SERVER = { baseUrl: "https://s.example.com", workspaceId: "ws_1", encryptedToken: "AQID" };

  it("旧配置 + Search Server 已配全 → 推断为 server（保持升级前的实际行为）", () => {
    expect(normalizeResearchEngineSettings({ enabled: true, searchServer: FULL_SERVER }).searchBackend).toBe(
      "server",
    );
  });

  /// 缺令牌的 Search Server 在升级前也是不生效的（createSearchServerClient 返回 null，
  /// 实际走的是直连回落），所以推断成 direct 才是"保持既有行为"。
  it("旧配置 + Search Server 缺令牌 → direct（升级前实际走的也是直连回落）", () => {
    expect(
      normalizeResearchEngineSettings({
        searchServer: { baseUrl: "https://s.example.com", workspaceId: "ws_1" },
      }).searchBackend,
    ).toBe("direct");
  });

  it("旧配置 + 只配了直连 → direct", () => {
    expect(
      normalizeResearchEngineSettings({
        directSearch: { provider: "brave", encryptedApiKey: "AQID" },
      }).searchBackend,
    ).toBe("direct");
  });

  it("全新 profile（什么都没配）→ direct", () => {
    expect(normalizeResearchEngineSettings({}).searchBackend).toBe("direct");
  });

  /// 显式选择永远优先于推断：用户明确选了直连，就算 Search Server 配得好好的也不能改回去。
  it("显式 direct 不被 Search Server 的存在覆盖", () => {
    expect(
      normalizeResearchEngineSettings({ searchBackend: "direct", searchServer: FULL_SERVER })
        .searchBackend,
    ).toBe("direct");
  });
});

/// 后端是否配好。**单选语义下只看当前选中的那一条**——另一条配得再全也不算，
/// 否则「选了直连、只配了 Server」会让「联网」pill 可点，而主进程那侧构造客户端时返回 null。
describe("hasSearchBackend", () => {
  const bare = DEFAULT_RESEARCH_ENGINE_SETTINGS;
  const FULL_SERVER = { baseUrl: "https://s.example.com", workspaceId: "ws_1", encryptedToken: "AQID" };
  const FULL_DIRECT = { provider: "brave" as const, encryptedApiKey: "AQID" };

  it("什么都没配 → false", () => {
    expect(hasSearchBackend(bare)).toBe(false);
    expect(hasSearchBackend(undefined)).toBe(false);
  });

  it("选 server + Search Server 三字段齐全 → true", () => {
    expect(hasSearchBackend({ ...bare, searchBackend: "server", searchServer: FULL_SERVER })).toBe(true);
  });

  /// 缺密文令牌 = 请求发不出去。此时算「已配」会让 agent 拿到一个必然失败的工具。
  it("选 server + 缺令牌 → false", () => {
    expect(
      hasSearchBackend({
        ...bare,
        searchBackend: "server",
        searchServer: { baseUrl: "https://s.example.com", workspaceId: "ws_1" },
      }),
    ).toBe(false);
  });

  it("选 direct + 密钥已配 → true", () => {
    expect(hasSearchBackend({ ...bare, searchBackend: "direct", directSearch: FULL_DIRECT })).toBe(true);
  });

  it("选 direct + 只选了供应商没填密钥 → false", () => {
    expect(
      hasSearchBackend({ ...bare, searchBackend: "direct", directSearch: { provider: "brave" } }),
    ).toBe(false);
  });

  it("选 direct 时不看 Search Server（另一条配全了也不算）", () => {
    expect(hasSearchBackend({ ...bare, searchBackend: "direct", searchServer: FULL_SERVER })).toBe(false);
  });

  it("选 server 时不看直连密钥（另一条配全了也不算）", () => {
    expect(hasSearchBackend({ ...bare, searchBackend: "server", directSearch: FULL_DIRECT })).toBe(false);
  });
});
