import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESEARCH_ENGINE_SETTINGS,
  type ResearchEngineSettings,
} from "@cortex-work/core/research/settings";

import { assertResearchEnabled, CONSUMER_SWITCHES } from "./consumer-gate";

describe("slides consumer 准入", () => {
  it("不再有全局灰度开关", () => {
    expect("slides" in CONSUMER_SWITCHES).toBe(false);
  });

  it("研究总开关开启时不由全局 consumer gate 阻止", () => {
    const settings: ResearchEngineSettings = {
      ...DEFAULT_RESEARCH_ENGINE_SETTINGS,
      enabled: true,
    };
    expect(() => assertResearchEnabled(settings, "slides")).not.toThrow();
  });
});
