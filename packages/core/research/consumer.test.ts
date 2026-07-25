// consumer.ts 的默认配置表测试：保证每个 Consumer 都有条目、关键默认值符合 spec §15，
// 且 resolveConsumerDefaults 返回的是隔离副本（调用方改了不会污染全局常量）。
import { describe, expect, it } from "vitest";

import { CONSUMER_DEFAULTS, RESEARCH_CONSUMERS, resolveConsumerDefaults } from "./consumer";
import { TRUST_ZONES } from "./evidence";
import type { ResearchConsumer } from "./types";

describe("CONSUMER_DEFAULTS", () => {
  it("覆盖全部 ResearchConsumer", () => {
    const exhaustive: Record<ResearchConsumer, true> = {
      chat: true,
      deep_research: true,
      slides: true,
      writing: true,
      coding: true,
      knowledge: true,
    };
    expect([...RESEARCH_CONSUMERS].sort()).toEqual(Object.keys(exhaustive).sort());
    expect(Object.keys(CONSUMER_DEFAULTS).sort()).toEqual(Object.keys(exhaustive).sort());
  });

  it.each(RESEARCH_CONSUMERS)("%s 的默认配置非空且信任区合法", (consumer) => {
    const defaults = CONSUMER_DEFAULTS[consumer];
    expect(defaults.sourceScopes.length).toBeGreaterThan(0);
    expect(defaults.allowedTrustZones.length).toBeGreaterThan(0);
    for (const zone of defaults.allowedTrustZones) {
      expect(TRUST_ZONES).toContain(zone);
    }
  });

  it("chat 默认 quick 模式", () => {
    expect(resolveConsumerDefaults("chat").mode).toBe("quick");
  });

  it("deep_research 默认 deep 模式", () => {
    expect(resolveConsumerDefaults("deep_research").mode).toBe("deep");
  });

  it("coding 的输出是 evidence_package（spec §15.5：只回证据包，不回叙述性正文）", () => {
    expect(resolveConsumerDefaults("coding").output.format).toBe("evidence_package");
  });

  it("所有 Consumer 默认都要求引用", () => {
    for (const consumer of RESEARCH_CONSUMERS) {
      expect(resolveConsumerDefaults(consumer).output.requireCitations).toBe(true);
    }
  });
});

describe("resolveConsumerDefaults", () => {
  it("返回副本，改动不会污染 CONSUMER_DEFAULTS", () => {
    const resolved = resolveConsumerDefaults("chat");
    resolved.sourceScopes.push({ kind: "memory" });
    resolved.allowedTrustZones.push("enterprise");
    expect(CONSUMER_DEFAULTS.chat.sourceScopes).not.toContainEqual({ kind: "memory" });
    expect(CONSUMER_DEFAULTS.chat.allowedTrustZones).not.toContain("enterprise");
  });
});
