import { describe, expect, it } from "vitest";
import type { AutomationRun } from "@cortex-work/core";
import { EFFORT_LABEL, fmtDuration } from "./automationFormat";

const baseRun = (over: Partial<AutomationRun>): AutomationRun => ({
  id: "r1",
  automationId: "a1",
  startedAt: 0,
  status: "ok",
  trigger: "schedule",
  agent: "claude",
  prompt: "",
  output: "",
  ...over,
});

describe("EFFORT_LABEL", () => {
  it("覆盖 low/medium/high 全枚举", () => {
    expect(EFFORT_LABEL.low).toBe("低");
    expect(EFFORT_LABEL.medium).toBe("中");
    expect(EFFORT_LABEL.high).toBe("高");
  });
});

describe("fmtDuration", () => {
  it("未结束(无 endedAt)返回空串", () => {
    expect(fmtDuration(baseRun({ startedAt: 1000 }))).toBe("");
  });
  it("不足 60s 显示 Ns", () => {
    expect(fmtDuration(baseRun({ startedAt: 0, endedAt: 37_000 }))).toBe("37s");
  });
  it("满 60s 及以上显示 Nm Ss", () => {
    expect(fmtDuration(baseRun({ startedAt: 0, endedAt: 95_000 }))).toBe("1m35s");
  });
});
