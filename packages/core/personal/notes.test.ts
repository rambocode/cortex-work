// 闪记 core 封装的纯逻辑单测：
//   resolveDefaultNoteProject 归属推导（当前会话 > active > lastActive > undefined,
//     且失效项目回落 undefined）;
//   notesAvailable 在 bridge 为 null / 旧壳缺方法时安全降级。
// React Query hook 本身（useProjectNotes 等）走 useDesktopBridge + useQuery,需
// Provider 包裹,沿用本仓核心层「只测纯函数」惯例,由集成/人工验证覆盖。

import { describe, expect, it } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import { notesAvailable, resolveDefaultNoteProject } from "./notes";

describe("resolveDefaultNoteProject", () => {
  const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("优先当前会话所属项目", () => {
    expect(
      resolveDefaultNoteProject({
        currentSessionProjectId: "a",
        activeProjectId: "b",
        lastActiveProjectId: "c",
        projects,
      }),
    ).toBe("a");
  });

  it("无当前会话项目时取 activeProjectId", () => {
    expect(
      resolveDefaultNoteProject({
        activeProjectId: "b",
        lastActiveProjectId: "c",
        projects,
      }),
    ).toBe("b");
  });

  it("再无则取 lastActiveProjectId", () => {
    expect(
      resolveDefaultNoteProject({
        lastActiveProjectId: "c",
        projects,
      }),
    ).toBe("c");
  });

  it("三者都无 → undefined（未归类）", () => {
    expect(resolveDefaultNoteProject({ projects })).toBeUndefined();
  });

  it("推导出的项目已不在 projects 中 → 回落 undefined", () => {
    expect(
      resolveDefaultNoteProject({
        currentSessionProjectId: "gone",
        activeProjectId: "b",
        projects,
      }),
    ).toBeUndefined();
  });

  it("当前会话项目失效但仍只看当前会话档（不串到 active）→ undefined", () => {
    // 归属来源按优先级取「第一个有值」的,失效后整体回落 undefined,不继续往下找。
    expect(
      resolveDefaultNoteProject({
        currentSessionProjectId: "gone",
        activeProjectId: "a",
        lastActiveProjectId: "b",
        projects,
      }),
    ).toBeUndefined();
  });

  it("projects 为空 → undefined", () => {
    expect(
      resolveDefaultNoteProject({ activeProjectId: "a", projects: [] }),
    ).toBeUndefined();
  });
});

describe("notesAvailable（缺桥/旧壳安全降级）", () => {
  it("bridge 为 null → false", () => {
    expect(notesAvailable(null)).toBe(false);
  });

  it("旧壳缺 notesList 方法 → false", () => {
    expect(notesAvailable({} as DesktopBridge)).toBe(false);
  });

  it("具备 notesList → true", () => {
    const bridge = { notesList: async () => [] } as unknown as DesktopBridge;
    expect(notesAvailable(bridge)).toBe(true);
  });
});
