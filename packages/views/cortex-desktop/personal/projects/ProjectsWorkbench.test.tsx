import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
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

// ── U12 新建动作空白离焦撤销（整链路：新建 → 选中聚焦 → ESC/离焦 → 撤销）─────────────
// 用有状态桥（tasksList 读回真实 store），复刻新建后任务真的出现在中列并进入标题编辑的时序。
function statefulTasksBridge() {
  const store = new Map<string, TaskMeta>();
  let idc = 0;
  const calls = { deleted: [] as string[] };
  const bridge = {
    tasksList: async () => [...store.values()],
    tasksListProjects: async () => [],
    tasksAdd: async (input: { title: string; projectId?: string; source?: string }) => {
      const id = `t${++idc}`;
      const now = Date.now();
      const m: TaskMeta = {
        id,
        title: input.title,
        status: "active",
        tags: [],
        projectId: input.projectId,
        source: (input.source as TaskMeta["source"]) ?? "manual",
        createdAt: now,
        updatedAt: now,
      };
      store.set(id, m);
      return m;
    },
    tasksUpdate: async (id: string, patch: Record<string, unknown>) => {
      const cur = store.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: Date.now() } as TaskMeta;
      store.set(id, next);
      return next;
    },
    tasksDelete: async (id: string) => {
      calls.deleted.push(id);
      store.delete(id);
    },
    tasksAddProject: async (name: string) => ({ id: "np", name, kind: "project" }),
    tasksUpdateProject: async () => null,
    tasksDeleteProject: async () => undefined,
    onTasksChanged: () => () => {},
    sendTaskDelegateIntent: () => {},
  } as unknown as DesktopBridge;
  return { bridge, store, calls };
}

describe("ProjectsWorkbench 空白新建离焦撤销（U12）", () => {
  it("新建动作后未输入即 ESC → 撤销该空白任务", async () => {
    const { bridge, calls } = statefulTasksBridge();
    renderWorkbench(bridge);
    // 切到收件箱视图：新建的空白任务落收件箱、在该视图 scope 内可见（今日视图新建的无到期任务不在 scope）。
    fireEvent.click(screen.getByRole("tab", { name: "收件箱" }));
    // 工具栏「新建动作」→ 建空白任务并进入标题编辑。
    fireEvent.click(screen.getByTitle("新建动作"));
    const input = (await screen.findByPlaceholderText("未命名的动作")) as HTMLInputElement;
    input.focus(); // 确保 activeElement 为标题输入（autoFocus 的确定化）
    // ESC 由根 keydown 处理 → blur 当前输入 → 空白且无其它信息 → 撤销。
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(calls.deleted.length).toBe(1));
  });

  it("新建动作后输入标题再 ESC → 保留（不撤销）", async () => {
    const { bridge, calls } = statefulTasksBridge();
    renderWorkbench(bridge);
    fireEvent.click(screen.getByRole("tab", { name: "收件箱" }));
    fireEvent.click(screen.getByTitle("新建动作"));
    const input = (await screen.findByPlaceholderText("未命名的动作")) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "写周报" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // 有标题 → 不撤销；行仍选中（ESC 仅 blur 不清选中），标题落库为「写周报」，任务仍在。
    expect(await screen.findByDisplayValue("写周报")).toBeTruthy();
    expect(calls.deleted.length).toBe(0);
  });
});
