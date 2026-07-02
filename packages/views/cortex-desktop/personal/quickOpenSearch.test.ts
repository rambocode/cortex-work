// 快速入口纯匹配逻辑单测:fuzzyScore 计分梯度/大小写/不命中;quickOpenSearch 空 query、tie-break、limit、sublabel、kind、done 靠后。
import { describe, it, expect } from "vitest";
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { fuzzyScore, quickOpenSearch } from "./quickOpenSearch";

// 构造任务/项目的最小工厂,只填被测字段。
function task(id: string, title: string, extra: Partial<TaskMeta> = {}): TaskMeta {
  return { id, title, status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra };
}
function project(id: string, name: string, kind: TaskProject["kind"] = "project", extra: Partial<TaskProject> = {}): TaskProject {
  return { id, name, kind, ...extra };
}

describe("fuzzyScore", () => {
  it("不命中返回 null", () => {
    expect(fuzzyScore("apple", "xyz")).toBeNull();
    // 顺序不符也不算子序列。
    expect(fuzzyScore("apple", "ppa")).toBeNull();
  });

  it("大小写不敏感", () => {
    expect(fuzzyScore("Apple", "app")).not.toBeNull();
    expect(fuzzyScore("apple", "APP")).not.toBeNull();
  });

  it("计分梯度:前缀 > 词边界 > 连续子串 > 离散子序列", () => {
    const prefix = fuzzyScore("apple", "app")!; // 前缀
    const wordBoundary = fuzzyScore("my apple", "app")!; // 空格后词边界
    const substring = fuzzyScore("grappler", "app")!; // 内嵌连续子串
    const subseq = fuzzyScore("a1p2p3", "app")!; // 离散子序列
    expect(prefix).toBeGreaterThan(wordBoundary);
    expect(wordBoundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subseq);
  });

  it("同档下目标越短越靠前", () => {
    const short = fuzzyScore("app", "app")!;
    const long = fuzzyScore("apple pie extra", "app")!;
    expect(short).toBeGreaterThan(long);
  });

  it("空 query 返回 null", () => {
    expect(fuzzyScore("apple", "")).toBeNull();
  });
});

describe("quickOpenSearch", () => {
  it("空/全空白 query 返回 []", () => {
    const tasks = [task("t1", "写周报")];
    const projects = [project("p1", "工作")];
    expect(quickOpenSearch(tasks, projects, "")).toEqual([]);
    expect(quickOpenSearch(tasks, projects, "   ")).toEqual([]);
  });

  it("同分时项目/文件夹类优先于任务(tie-break)", () => {
    // 项目与任务均为「报告」前缀,同档同长 → 同分;项目应排前。
    const tasks = [task("t1", "报告")];
    const projects = [project("p1", "报告")];
    const res = quickOpenSearch(tasks, projects, "报告");
    expect(res.map((r) => r.kind)).toEqual(["project", "task"]);
  });

  it("limit 截断", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, `任务 ${i}`));
    const res = quickOpenSearch(tasks, [], "任务", 3);
    expect(res.length).toBe(3);
  });

  it("task sublabel:存活项目 → 项目名;悬空/无 → 收件箱", () => {
    const tasks = [
      task("t1", "在项目里", { projectId: "p1" }),
      task("t2", "悬空的", { projectId: "ghost" }),
      task("t3", "无项目"),
    ];
    const projects = [project("p1", "工作")];
    const res = quickOpenSearch(tasks, projects, "的");
    // 只有 t2「悬空的」命中「的」。
    const dangling = res.find((r) => r.id === "t2");
    expect(dangling?.sublabel).toBe("收件箱");

    const inProj = quickOpenSearch(tasks, projects, "在项目里").find((r) => r.id === "t1");
    expect(inProj?.sublabel).toBe("工作");

    const noProj = quickOpenSearch(tasks, projects, "无项目").find((r) => r.id === "t3");
    expect(noProj?.sublabel).toBe("收件箱");
  });

  it("folder / project kind 正确标注", () => {
    const projects = [project("p1", "阿尔法项目", "project"), project("f1", "阿尔法文件夹", "folder")];
    const res = quickOpenSearch([], projects, "阿尔法");
    expect(res.find((r) => r.id === "p1")?.kind).toBe("project");
    expect(res.find((r) => r.id === "f1")?.kind).toBe("folder");
  });

  it("done 任务排到 active 任务之后(同为前缀命中)", () => {
    const tasks = [
      task("done1", "任务甲", { status: "done" }),
      task("active1", "任务乙", { status: "active" }),
    ];
    // 「任务」前缀命中两者;active 因未降权,分更高排前。
    const res = quickOpenSearch(tasks, [], "任务");
    expect(res.map((r) => r.id)).toEqual(["active1", "done1"]);
  });
});
