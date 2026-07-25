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

  it("默认模型数据策略是 evidence_allowed", () => {
    expect(DEFAULT_RESEARCH_ENGINE_SETTINGS.defaultModelDataPolicy).toBe("evidence_allowed");
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
      name: "非法 policy 值回落默认",
      raw: { defaultModelDataPolicy: "send_everything" },
      expected: DEFAULT_RESEARCH_ENGINE_SETTINGS,
    },
    {
      name: "合法 policy 值保留",
      raw: { defaultModelDataPolicy: "local_only" },
      expected: { ...DEFAULT_RESEARCH_ENGINE_SETTINGS, defaultModelDataPolicy: "local_only" },
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
  ];

  it.each(cases)("$name", ({ raw, expected }) => {
    expect(normalizeResearchEngineSettings(raw)).toEqual(expected);
  });

  it("不会把 DEFAULT_RESEARCH_ENGINE_SETTINGS 本身返回出去（防止调用方就地改默认值）", () => {
    const normalized = normalizeResearchEngineSettings({});
    expect(normalized).not.toBe(DEFAULT_RESEARCH_ENGINE_SETTINGS);
  });
});
