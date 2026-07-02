// projectStages 纯函数表驱动单测：进度边界、阶段排序、状态元数据。
import { describe, expect, it } from "vitest";
import type { ProjectStage, TaskStatus } from "../desktop/tasks-types";
import { projectProgress, sortStages, stageStatusLabel, STAGE_STATUS_META } from "./projectStages";

const t = (status: TaskStatus) => ({ status });

describe("projectProgress", () => {
  it.each<[string, TaskStatus[], { done: number; total: number; percent: number }]>([
    ["空项目 → 0%", [], { done: 0, total: 0, percent: 0 }],
    ["全部完成 → 100%", ["done", "done"], { done: 2, total: 2, percent: 100 }],
    ["一半完成 → 50%", ["done", "active"], { done: 1, total: 2, percent: 50 }],
    // dropped 不计入分母：丢弃的任务不再是目标，计入会让进度永远到不了 100%。
    ["dropped 不计入分母", ["done", "dropped"], { done: 1, total: 1, percent: 100 }],
    ["全部 dropped → 0%（分母为 0）", ["dropped"], { done: 0, total: 0, percent: 0 }],
    // 1/3 → 33%（四舍五入）；2/3 → 67%。
    ["四舍五入 33%", ["done", "active", "waiting"], { done: 1, total: 3, percent: 33 }],
    ["四舍五入 67%", ["done", "done", "in-progress"], { done: 2, total: 3, percent: 67 }],
  ])("%s", (_name, statuses, expected) => {
    expect(projectProgress(statuses.map(t))).toEqual(expected);
  });
});

describe("sortStages", () => {
  const mk = (id: string, order: number): ProjectStage => ({ id, name: id, status: "not-started", order });

  it("按 order 升序且不改入参", () => {
    const input = [mk("b", 2), mk("a", 0), mk("c", 1)];
    const sorted = sortStages(input);
    expect(sorted.map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(input.map((s) => s.id)).toEqual(["b", "a", "c"]); // 入参原样
  });
});

describe("stageStatusLabel", () => {
  it("三态齐备且中文标签正确", () => {
    expect(STAGE_STATUS_META.map((m) => m.value)).toEqual(["not-started", "active", "done"]);
    expect(stageStatusLabel("not-started")).toBe("未开始");
    expect(stageStatusLabel("active")).toBe("进行中");
    expect(stageStatusLabel("done")).toBe("已完成");
  });
});
