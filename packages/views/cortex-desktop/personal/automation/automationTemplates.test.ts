// 模板数据完整性：id 唯一、提示词非空、频率合法、once 模板带占位与偏移、无壁纸模板。

import { describe, expect, it } from "vitest";
import { AUTOMATION_TEMPLATES } from "./automationTemplates";

const KINDS = ["hourly", "daily", "weekdays", "weekly", "cron", "once"];

describe("AUTOMATION_TEMPLATES", () => {
  it("共 11 个模板,且已去掉壁纸模板", () => {
    expect(AUTOMATION_TEMPLATES).toHaveLength(11);
    expect(AUTOMATION_TEMPLATES.some((t) => /壁纸/.test(t.name))).toBe(false);
  });

  it("id 唯一", () => {
    const ids = AUTOMATION_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个模板都有非空 name / description / prompt 和合法 schedule.kind", () => {
    for (const t of AUTOMATION_TEMPLATES) {
      expect(t.name.trim()).toBeTruthy();
      expect(t.description.trim()).toBeTruthy();
      expect(t.draft.prompt.trim()).toBeTruthy();
      expect(KINDS).toContain(t.draft.schedule.kind);
    }
  });

  it("once 模板:at 为占位 0 且带正的 onceOffsetMs(点选时由调用方覆盖)", () => {
    const onceTpls = AUTOMATION_TEMPLATES.filter((t) => t.draft.schedule.kind === "once");
    expect(onceTpls.length).toBeGreaterThan(0);
    for (const t of onceTpls) {
      expect(t.draft.schedule).toMatchObject({ kind: "once", at: 0 });
      expect(t.onceOffsetMs).toBeGreaterThan(0);
    }
  });

  it("cron 模板:面试准备为工作日每 2 小时表达式", () => {
    const interview = AUTOMATION_TEMPLATES.find((t) => t.id === "interview-prep");
    expect(interview?.draft.schedule).toEqual({ kind: "cron", expression: "0 9-19/2 * * 1-5" });
  });
});
