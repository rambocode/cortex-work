import { describe, expect, it } from "vitest";
import {
  AGENT_MODELS,
  APPROVAL_POLICIES,
  DEFAULT_MODEL,
  defaultVoiceSettings,
  PERMISSION_MODES,
} from "./types";

describe("desktop agent model config", () => {
  it("Codex exposes selectable recommended models", () => {
    expect(AGENT_MODELS.codex.map((m) => m.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("Codex default model is selectable", () => {
    expect(AGENT_MODELS.codex.some((m) => m.value === DEFAULT_MODEL.codex)).toBe(true);
  });
});

describe("访问范围 + 执行审批 常量", () => {
  it("PERMISSION_MODES 含 sandbox,历史内部值未改名(防回归)", () => {
    expect(PERMISSION_MODES).toEqual(["accept-edits", "plan", "full-auto", "sandbox"]);
  });

  it("APPROVAL_POLICIES 两档", () => {
    expect(APPROVAL_POLICIES).toEqual(["auto", "ask"]);
  });
});

describe("语音功能默认设置", () => {
  it("默认关闭快捷键和浮层选项，并使用系统默认麦克风；转写纠错默认开、跟随全局默认模型", () => {
    expect(defaultVoiceSettings()).toEqual({
      micDeviceId: "",
      chatHotkey: "",
      chatScreenContext: false,
      dictationHoldHotkey: "",
      dictationToggleHotkey: "",
      dictationBarAlwaysVisible: false,
      dictationDictionary: [],
      chatPrompt: "",
      intentMode: "function_call",
      intentProviderId: "",
      intentModelId: "",
      transcriptPolish: true,
      polishProviderId: "",
      polishModelId: "",
      polishPrompt: "",
    });
  });
});
