// settings.ts 的归一化测试。设置来自磁盘 JSON（可能是旧版本写的、被手改过的、甚至是 null），
// 所以 normalizeResearchEngineSettings 必须对任意 unknown 输入都给出可用结果，绝不抛错。
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESEARCH_ENGINE_SETTINGS,
  normalizeResearchEngineSettings,
  type ResearchEngineSettings,
} from "./settings";

describe("DEFAULT_RESEARCH_ENGINE_SETTINGS", () => {
  it("所有开关默认关闭（新能力必须显式开启）", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.deepResearchEnabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.chatEnabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.slidesEnabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.writingEnabled).toBe(false);
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.memoryEnabled).toBe(false);
  });

  it("默认不指定研究模型（跟随全局默认模型）", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.modelProviderId).toBeUndefined();
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.modelId).toBeUndefined();
  });

  it("默认不带 searchServer 配置", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.searchServer).toBeUndefined();
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
      raw: { enabled: true, chatEnabled: true },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, enabled: true, chatEnabled: true },
    },
    {
      // 出站策略枚举已移除：旧版本写入的这个键必须被白名单重建自然丢弃，
      // 不能作为未知字段残留在归一化结果里（否则设置页写回时又落回磁盘）。
      name: "旧版本的 defaultModelDataPolicy 被丢弃",
      raw: { enabled: true, defaultModelDataPolicy: "local_only" },
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
      name: "完整 searchServer 保留",
      raw: {
        enabled: true,
        searchServer: { baseUrl: "https://s.example.com", workspaceId: "ws_1", encryptedToken: "AQID" },
      },
      expected: {
        ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
        enabled: true,
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
  ];

  it.each(cases)("$name", ({ raw, expected }) => {
    expect(normalizeResearchEngineSettings(raw)).toEqual(expected);
  });

  it("不会把 DEFAULT_RESEARCH_ENGINE_SETTINGS 本身返回出去（防止调用方就地改默认值）", () => {
    const normalized = normalizeResearchEngineSettings({});
    expect(normalized).not.toBe(DEFAULT_RESEARCH_ENGINE_SETTINGS);
  });
});
