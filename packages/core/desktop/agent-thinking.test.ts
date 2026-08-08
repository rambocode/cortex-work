// piSupportedThinkingLevels / clampPiThinkingLevel 的规则单测——算法逐条对齐 pi-ai 的
// getSupportedThinkingLevels / clampThinkingLevel(models.js),升级 pi 时复核这两处。
import { describe, expect, it } from "vitest";

import { clampPiThinkingLevel, piSupportedThinkingLevels } from "./agent-thinking";
import { PI_THINKING_LEVELS } from "./types";

// deepseek-v4 系的真实 map(pi 目录原样):minimal/low/medium 显式 null,仅 high/max 可用。
const DEEPSEEK_V4 = {
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
};

describe("piSupportedThinkingLevels", () => {
  it("无模型信息 → 全档(保守不过滤)", () => {
    expect(piSupportedThinkingLevels(null)).toEqual([...PI_THINKING_LEVELS]);
    expect(piSupportedThinkingLevels(undefined)).toEqual([...PI_THINKING_LEVELS]);
  });

  it("reasoning=false → 只有 off", () => {
    expect(piSupportedThinkingLevels({ reasoning: false })).toEqual(["off"]);
  });

  it("无 thinkingLevelMap 的推理模型 → xhigh/max 之外全支持(xhigh/max 须显式映射)", () => {
    expect(piSupportedThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("deepseek-v4 map:null 档剔除,off/high/max 可用", () => {
    expect(piSupportedThinkingLevels(DEEPSEEK_V4)).toEqual(["off", "high", "max"]);
  });
});

describe("clampPiThinkingLevel", () => {
  it("支持的档原样返回", () => {
    expect(clampPiThinkingLevel(DEEPSEEK_V4, "high")).toBe("high");
    expect(clampPiThinkingLevel(DEEPSEEK_V4, "off")).toBe("off");
  });

  it("不支持的档先向上爬到最近可用档(medium/low/minimal → high,与 pi 实际发包一致)", () => {
    expect(clampPiThinkingLevel(DEEPSEEK_V4, "medium")).toBe("high");
    expect(clampPiThinkingLevel(DEEPSEEK_V4, "low")).toBe("high");
    expect(clampPiThinkingLevel(DEEPSEEK_V4, "minimal")).toBe("high");
  });

  it("向上无可用档时向下回落", () => {
    // 只支持 off 的模型:任何档都落回 off。
    expect(clampPiThinkingLevel({ reasoning: false }, "xhigh")).toBe("off");
  });

  it("无模型信息 → 全档可用,原样返回", () => {
    expect(clampPiThinkingLevel(null, "medium")).toBe("medium");
  });
});
