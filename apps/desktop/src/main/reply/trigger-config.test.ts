import { describe, expect, it } from "vitest";

import { buildReplyTriggerConfig } from "./trigger-config";

describe("buildReplyTriggerConfig", () => {
  it("旧档缺配置时回落到既有默认手势", () => {
    expect(buildReplyTriggerConfig()).toEqual({ draft: "command", voice: "function" });
  });

  it("未设置会显式下发 null，避免 helper 沿用旧键", () => {
    expect(buildReplyTriggerConfig({ draftTrigger: "none", voiceTrigger: "none" })).toEqual({
      draft: null,
      voice: null,
    });
  });

  it("右 Option 复用 helper 的 option 语义", () => {
    expect(buildReplyTriggerConfig({ draftTrigger: "fn", voiceTrigger: "rightOption" })).toEqual({
      draft: "function",
      voice: "option",
    });
  });
});
