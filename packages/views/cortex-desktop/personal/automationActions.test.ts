import { describe, expect, it } from "vitest";
import type { AutomationMeta, AutomationRun } from "@cortex-work/core";
import { buildDuplicateInput, serializeRunsForExport } from "./automationActions";

const meta = (over: Partial<AutomationMeta> = {}): AutomationMeta => ({
  id: "auto-1",
  name: "历史上的今天",
  enabled: true,
  projectId: "p1",
  cwd: "/tmp/p1",
  agent: "claude",
  model: "sonnet",
  effort: "medium",
  prompt: "讲一件历史上的今天",
  useOwnSkills: true,
  notifyChannels: ["feishu"],
  providerId: "prov-1",
  schedule: { kind: "daily", hour: 9, minute: 10 },
  timezone: "Asia/Shanghai",
  createdAt: 1000,
  updatedAt: 2000,
  lastRunAt: 3000,
  lastStatus: "ok",
  nextRunAt: 4000,
  ...over,
});

const run = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: "r1",
  automationId: "auto-1",
  startedAt: 0,
  endedAt: 37_000,
  status: "ok",
  trigger: "schedule",
  agent: "claude",
  prompt: "p",
  output: "o",
  ...over,
});

describe("buildDuplicateInput", () => {
  it("剥离全部服务端生成字段", () => {
    const input = buildDuplicateInput(meta()) as unknown as Record<string, unknown>;
    for (const k of ["id", "createdAt", "updatedAt", "lastRunAt", "lastStatus", "nextRunAt"]) {
      expect(input[k]).toBeUndefined();
    }
  });
  it("name 追加「 副本」,其余可复制字段原样保留", () => {
    const input = buildDuplicateInput(meta());
    expect(input.name).toBe("历史上的今天 副本");
    expect(input.prompt).toBe("讲一件历史上的今天");
    expect(input.agent).toBe("claude");
    expect(input.model).toBe("sonnet");
    expect(input.effort).toBe("medium");
    expect(input.projectId).toBe("p1");
    expect(input.schedule).toEqual({ kind: "daily", hour: 9, minute: 10 });
    expect(input.notifyChannels).toEqual(["feishu"]);
    expect(input.timezone).toBe("Asia/Shanghai");
  });
  it("空名兜底为「未命名自动化 副本」", () => {
    expect(buildDuplicateInput(meta({ name: "" })).name).toBe("未命名自动化 副本");
  });
});

describe("serializeRunsForExport", () => {
  const now = new Date(2026, 5, 24, 10, 0, 0); // 2026-06-24

  it("空 runs 也产出合法 JSON(runs 为空数组)", () => {
    const { content } = serializeRunsForExport(meta(), [], now);
    const parsed = JSON.parse(content);
    expect(parsed.runs).toEqual([]);
  });
  it("content 可被 JSON.parse 还原,含 runs", () => {
    const { content } = serializeRunsForExport(meta(), [run(), run({ id: "r2" })], now);
    const parsed = JSON.parse(content);
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.automation.id).toBe("auto-1");
  });
  it("filename 含日期戳且不含非法文件名字符", () => {
    const { filename } = serializeRunsForExport(meta({ name: 'a/b:c*?"<>|d' }), [], now);
    expect(filename).toContain("20260624");
    expect(filename.endsWith(".json")).toBe(true);
    // 去掉扩展名前缀后,主体不含任何非法字符
    expect(/[/\\:*?"<>|]/.test(filename.replace(/\.json$/, ""))).toBe(false);
  });
});
