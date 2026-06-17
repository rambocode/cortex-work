import { describe, expect, it } from "vitest";
import { defaultStatusForKind, normalizeStatus, stripStatusAnnotation } from "./docStatus";

describe("normalizeStatus", () => {
  it("各规范态命中", () => {
    expect(normalizeStatus("completed", "plan")).toBe("done");
    expect(normalizeStatus("active", "plan")).toBe("active");
    expect(normalizeStatus("待评审", "plan")).toBe("review");
    expect(normalizeStatus("待执行", "plan")).toBe("todo");
    expect(normalizeStatus("ready", "plan")).toBe("todo");
  });

  it("剥括号补注后命中，原文由调用方另存", () => {
    expect(normalizeStatus("待执行（U0 spike 已完成，见 §2）", "plan")).toBe("todo");
    expect(normalizeStatus("completed (verified)", "plan")).toBe("done");
  });

  it("缺 status 字段按 kind 兜底", () => {
    expect(normalizeStatus(undefined, "plan")).toBe("todo");
    expect(normalizeStatus(undefined, "ideation")).toBe("idea");
    expect(normalizeStatus(undefined, "brainstorm")).toBe("idea");
    expect(normalizeStatus("   ", "plan")).toBe("todo");
  });

  it("未知值按 kind 兜底", () => {
    expect(normalizeStatus("blocked", "plan")).toBe("todo");
    expect(normalizeStatus("某未知态", "ideation")).toBe("idea");
  });

  it("大小写/空白鲁棒", () => {
    expect(normalizeStatus("  Completed  ", "plan")).toBe("done");
    expect(normalizeStatus("IN-PROGRESS", "plan")).toBe("active");
  });
});

describe("stripStatusAnnotation", () => {
  it("去中英文括号补注", () => {
    expect(stripStatusAnnotation("待执行（已完成 U0）")).toBe("待执行");
    expect(stripStatusAnnotation("ready (verified)")).toBe("ready");
    expect(stripStatusAnnotation("active")).toBe("active");
  });
});

describe("defaultStatusForKind", () => {
  it("plan→todo，其余→idea", () => {
    expect(defaultStatusForKind("plan")).toBe("todo");
    expect(defaultStatusForKind("ideation")).toBe("idea");
    expect(defaultStatusForKind("brainstorm")).toBe("idea");
  });
});
