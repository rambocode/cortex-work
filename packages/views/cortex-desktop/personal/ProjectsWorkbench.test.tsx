import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskProject } from "@cortex-work/core/desktop/types";
import {
  ProjectsWorkbench,
  pushSelection,
  goBackHistory,
  goForwardHistory,
  pruneHistory,
  type SelectionHistory,
  type WorkbenchSelection,
} from "./ProjectsWorkbench";

// ── 浏览历史纯逻辑（KTD7）───────────────────────────────────────────────────
describe("ProjectsWorkbench 历史栈（U4/KTD7）", () => {
  const A: WorkbenchSelection = { kind: "project", id: "A" };
  const B: WorkbenchSelection = { kind: "project", id: "B" };
  const C: WorkbenchSelection = { kind: "project", id: "C" };
  const seed: SelectionHistory = { entries: [{ kind: "today" }], index: 0 };

  it("往返：A→B→C 后退回 B、再回 A，前进恢复 B", () => {
    let h = pushSelection(seed, A);
    h = pushSelection(h, B);
    h = pushSelection(h, C);
    expect(h.entries.map((e) => (e.kind === "project" ? e.id : e.kind))).toEqual(["today", "A", "B", "C"]);
    h = goBackHistory(h); // → B
    expect(h.entries[h.index]).toEqual(B);
    h = goBackHistory(h); // → A
    expect(h.entries[h.index]).toEqual(A);
    h = goForwardHistory(h); // → B
    expect(h.entries[h.index]).toEqual(B);
  });

  it("端点：栈首后退、栈尾前进为空操作（canGo* 依据 index）", () => {
    let h = pushSelection(seed, A); // [today, A] index1
    h = goBackHistory(h); // index0
    expect(h.index).toBe(0);
    expect(goBackHistory(h)).toBe(h); // 栈首再后退不动
    h = pushSelection(h, B); // 从 index0 push → 截断 A，[today, B] index1
    expect(goForwardHistory(h)).toBe(h); // 栈尾再前进不动
  });

  it("导航不 push：后退后再往返长度不膨胀", () => {
    let h = pushSelection(seed, A);
    h = pushSelection(h, B); // [today,A,B]
    const len = h.entries.length;
    h = goBackHistory(h);
    h = goForwardHistory(h);
    expect(h.entries.length).toBe(len);
  });

  it("重选当前不 push（去重）", () => {
    const h = pushSelection(seed, A);
    const same = pushSelection(h, { kind: "project", id: "A" });
    expect(same).toBe(h);
  });

  it("死条目剪除：删除 B 后重映射 index，且后退跳过 B", () => {
    let h = pushSelection(seed, A);
    h = pushSelection(h, B);
    h = pushSelection(h, C); // [today,A,B,C] index3
    // 项目表只剩 A、C（B 已删）。
    const projects = [
      { id: "A", name: "A", kind: "project" },
      { id: "C", name: "C", kind: "project" },
    ] as TaskProject[];
    h = pruneHistory(h, projects);
    expect(h.entries.map((e) => (e.kind === "project" ? e.id : e.kind))).toEqual(["today", "A", "C"]);
    expect(h.entries[h.index]).toEqual(C); // 原位置就近映射到 C
    h = goBackHistory(h); // 后退跳过已剪除的 B → A
    expect(h.entries[h.index]).toEqual(A);
  });

  it("剪除全空兜底回今日", () => {
    const h: SelectionHistory = { entries: [{ kind: "project", id: "X" }], index: 0 };
    expect(pruneHistory(h, [])).toEqual({ entries: [{ kind: "today" }], index: 0 });
  });
});

// ── 组件级：边栏显隐 / 自动展开 / ESC ───────────────────────────────────────
function fakeBridge(projects: TaskProject[] = []) {
  const calls = { addProject: 0, addTask: 0 };
  const bridge = {
    tasksList: async () => [],
    tasksListProjects: async () => projects,
    tasksAdd: async () => {
      calls.addTask += 1;
      return { id: "new-task", title: "", status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0 };
    },
    tasksAddProject: async (name: string) => {
      calls.addProject += 1;
      return { id: "new-proj", name, kind: "project" };
    },
    tasksUpdate: async () => null,
    tasksDelete: async () => undefined,
    tasksUpdateProject: async () => null,
    tasksDeleteProject: async () => undefined,
    onTasksChanged: () => () => {},
    sendTaskDelegateIntent: () => {},
  } as unknown as DesktopBridge;
  return { bridge, calls };
}

function renderWorkbench(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <ProjectsWorkbench onToast={() => {}} />
    </CoreProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* noop */
  }
});

describe("ProjectsWorkbench 边栏 / ESC（U4）", () => {
  it("边栏切换：点按钮隐藏左树列，再点恢复", () => {
    const { bridge } = fakeBridge();
    const { container } = renderWorkbench(bridge);
    expect(container.querySelector(".pw-projects-tree")).not.toBeNull(); // 缺省显示
    fireEvent.click(screen.getByTitle("隐藏边栏"));
    expect(container.querySelector(".pw-projects-tree")).toBeNull();
    fireEvent.click(screen.getByTitle("显示边栏"));
    expect(container.querySelector(".pw-projects-tree")).not.toBeNull();
  });

  it("边栏显隐经 localStorage 窄通道持久化（KTD9）：重挂后保持隐藏", () => {
    const { bridge } = fakeBridge();
    const first = renderWorkbench(bridge);
    fireEvent.click(screen.getByTitle("隐藏边栏"));
    expect(first.container.querySelector(".pw-projects-tree")).toBeNull();
    first.unmount();
    // 全新挂载读回 localStorage → 仍隐藏。
    const second = renderWorkbench(bridge);
    expect(second.container.querySelector(".pw-projects-tree")).toBeNull();
  });

  it("工具栏「新建」为单一按钮，点击直接新建动作、无下拉（U11）", async () => {
    const { bridge, calls } = fakeBridge();
    renderWorkbench(bridge);
    const btn = screen.getByTitle("新建动作");
    // 单一按钮：不再是菜单触发器（无 aria-haspopup），点击即建任务、不弹「新建项目/动作」子菜单。
    expect(btn.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(calls.addTask).toBe(1));
    expect(calls.addProject).toBe(0);
  });

  it("ESC：行内编辑聚焦中按 ESC 退出编辑（blur），不关窗", () => {
    const { bridge } = fakeBridge();
    renderWorkbench(bridge);
    const input = screen.getByPlaceholderText("添加任务，回车即建…") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input); // 已 blur 退出编辑
  });
});

// ── U5：显示弹层选档持久化 / 显示收件箱联动重定向 ──────────────────────────────
describe("ProjectsWorkbench 显示弹层（U5）", () => {
  it("选档经 localStorage 窄通道持久化（KTD9）：切「全部」后重挂仍为「全部」", () => {
    const { bridge } = fakeBridge();
    const first = renderWorkbench(bridge);
    fireEvent.click(screen.getByTitle("显示"));
    fireEvent.click(screen.getByText("全部"));
    first.unmount();
    // 全新挂载读回 localStorage → 打开弹层「全部」应为选中态。
    renderWorkbench(bridge);
    fireEvent.click(screen.getByTitle("显示"));
    const on = document.querySelector(".pw-view-option.is-on")!;
    expect(on.textContent).toContain("全部");
  });

  it("关闭「显示收件箱」且正选中收件箱 → 重定向今日、隐藏收件箱入口（R10/R18）", () => {
    const { bridge } = fakeBridge();
    renderWorkbench(bridge);
    // 先选中收件箱。
    fireEvent.click(screen.getByRole("tab", { name: "收件箱" }));
    expect(screen.getByRole("tab", { name: "收件箱" }).getAttribute("aria-selected")).toBe("true");
    // 打开弹层关闭「显示收件箱」→ 重定向今日、收件箱入口消失。
    fireEvent.click(screen.getByTitle("显示"));
    fireEvent.click(screen.getByText("显示收件箱"));
    expect(screen.queryByRole("tab", { name: "收件箱" })).toBeNull();
    expect(screen.getByRole("tab", { name: "今日" }).getAttribute("aria-selected")).toBe("true");
  });
});
