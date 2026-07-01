import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskInput, TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { TaskListColumn } from "./TaskListColumn";
import type { WorkbenchSelection } from "./ProjectsWorkbench";

// 内存任务桥：tasksList/add/update/delete/listProjects/onTasksChanged，并记录新增入参（快速新增归属断言用）。
function fakeTasksBridge(initial: TaskMeta[] = [], initialProjects: TaskProject[] = []) {
  const store = new Map<string, TaskMeta>(initial.map((t) => [t.id, t]));
  let idc = 0;
  const calls = {
    added: [] as TaskInput[],
    update: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    deleted: [] as string[],
  };
  const bridge = {
    tasksList: async (pid?: string) => {
      const all = [...store.values()];
      return pid === undefined ? all : all.filter((t) => t.projectId === pid);
    },
    tasksListProjects: async () => initialProjects,
    tasksAdd: async (input: TaskInput) => {
      calls.added.push(input);
      const id = `t${++idc}`;
      const now = Date.now();
      const m: TaskMeta = {
        id,
        title: input.title,
        status: "active",
        tags: [],
        projectId: input.projectId,
        source: input.source ?? "manual",
        createdAt: now,
        updatedAt: now,
      };
      store.set(id, m);
      return m;
    },
    tasksUpdate: async (id: string, patch: Record<string, unknown>) => {
      calls.update.push({ id, patch });
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
    onTasksChanged: () => () => {},
  } as unknown as DesktopBridge;
  return { bridge, store, calls };
}

function renderColumn(bridge: DesktopBridge, selection: WorkbenchSelection, selectedTaskId?: string | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TaskListColumn selection={selection} selectedTaskId={selectedTaskId} onOpenTask={() => {}} onToast={() => {}} />
    </CoreProvider>,
  );
}

// 造一条活动任务的便捷工厂。
function task(id: string, title: string, extra: Partial<TaskMeta> = {}): TaskMeta {
  return { id, title, status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra };
}

// 只 fake Date（冻结「今天」为 2026-07-01），保留真实 setTimeout 让 RTL findBy/waitFor 正常工作。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T12:00:00"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // 折叠态是模块级 Zustand 单例，重置防跨用例串扰。
  usePersonalStore.setState({ collapsedTasks: {} });
});

describe("TaskListColumn", () => {
  it("选中 project 聚合其子树（自身 + 子项目）任务，排除无关项目", async () => {
    const projects: TaskProject[] = [
      { id: "p1", name: "项目一" },
      { id: "p1a", name: "子项目", parentId: "p1" },
      { id: "p2", name: "无关" },
    ];
    const { bridge } = fakeTasksBridge(
      [
        task("a", "属于p1", { projectId: "p1" }),
        task("b", "属于子项目", { projectId: "p1a" }),
        task("c", "无关任务", { projectId: "p2" }),
      ],
      projects,
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    expect(await screen.findByText("属于p1")).toBeTruthy();
    expect(screen.getByText("属于子项目")).toBeTruthy();
    expect(screen.queryByText("无关任务")).toBeNull();
  });

  it("选中 folder 聚合其后代 project 任务，排除文件夹外任务", async () => {
    const projects: TaskProject[] = [
      { id: "f1", name: "分组", kind: "folder" },
      { id: "p1", name: "项目", parentId: "f1" },
      { id: "p2", name: "外部", kind: "project" },
    ];
    const { bridge } = fakeTasksBridge(
      [task("a", "组内任务", { projectId: "p1" }), task("b", "组外任务", { projectId: "p2" })],
      projects,
    );
    renderColumn(bridge, { kind: "folder", id: "f1" });

    expect(await screen.findByText("组内任务")).toBeTruthy();
    expect(screen.queryByText("组外任务")).toBeNull();
  });

  it("组内排序：flag → 逾期 → 有 due（升序）→ 无 due 末尾", async () => {
    // 单 project 子树 → 单组无头，直接校验行的 DOM 顺序即组内排序。
    const { bridge } = fakeTasksBridge(
      [
        task("s1", "无due", { projectId: "p1" }),
        task("s2", "未逾期", { projectId: "p1", dueDate: "2026-07-10" }),
        task("s3", "逾期", { projectId: "p1", dueDate: "2026-06-20" }),
        task("s4", "已标记", { projectId: "p1", flagged: true }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    const { container } = renderColumn(bridge, { kind: "project", id: "p1" });

    await screen.findByText("无due");
    const order = Array.from(container.querySelectorAll<HTMLElement>(".pw-task-title-btn")).map(
      (el) => el.textContent,
    );
    expect(order).toEqual(["已标记", "逾期", "未逾期", "无due"]);
  });

  it("folder 快速新增落 Inbox（projectId 为空）", async () => {
    const projects: TaskProject[] = [
      { id: "f1", name: "分组", kind: "folder" },
      { id: "p1", name: "项目", parentId: "f1" },
    ];
    const { bridge, calls } = fakeTasksBridge([], projects);
    renderColumn(bridge, { kind: "folder", id: "f1" });

    const input = screen.getByPlaceholderText(/添加任务/);
    fireEvent.change(input, { target: { value: "买菜" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls.added.length).toBe(1));
    const added = calls.added[0]!;
    expect(added.title).toBe("买菜");
    expect(added.projectId).toBeUndefined();
  });
});

describe("TaskListColumn 子任务嵌套（U3）", () => {
  it("项目视图下子任务缩进渲染在父下", async () => {
    const { bridge } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    await screen.findByText("父任务");
    const parentRow = screen.getByText("父任务").closest(".pw-task-row")!;
    const childRow = screen.getByText("子任务").closest(".pw-task-row")!;
    // 父行无缩进、子行有缩进占位。
    expect(parentRow.querySelector(".pw-task-indent")).toBeNull();
    expect(childRow.querySelector(".pw-task-indent")).not.toBeNull();
    // 父行有折叠箭头（有子任务）。
    expect(parentRow.querySelector(".pw-task-twisty:not(.pw-task-twisty-spacer)")).not.toBeNull();
  });

  it("折叠父任务 → 子任务隐藏，再展开 → 恢复", async () => {
    const { bridge } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    await screen.findByText("子任务");
    const twisty = screen.getByText("父任务").closest(".pw-task-row")!.querySelector<HTMLButtonElement>(".pw-task-twisty")!;
    fireEvent.click(twisty);
    expect(screen.queryByText("子任务")).toBeNull();
    fireEvent.click(twisty);
    expect(screen.getByText("子任务")).toBeTruthy();
  });

  it("添加子任务透传 parentId 并继承父项目", async () => {
    const { bridge, calls } = fakeTasksBridge(
      [task("parent", "父任务", { projectId: "p1" })],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    await screen.findByText("父任务");
    const parentRow = screen.getByText("父任务").closest(".pw-task-row")!;
    fireEvent.click(within(parentRow as HTMLElement).getByTitle("添加子任务"));

    await waitFor(() => expect(calls.added.length).toBe(1));
    expect(calls.added[0]!.parentId).toBe("parent");
    expect(calls.added[0]!.projectId).toBe("p1");
  });

  it("删除含子任务的父 → 首击确认 toast、再击才删", async () => {
    const toasts: string[] = [];
    const { bridge, calls } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <TaskListColumn selection={{ kind: "project", id: "p1" }} onOpenTask={() => {}} onToast={(t) => toasts.push(t)} />
      </CoreProvider>,
    );

    await screen.findByText("父任务");
    const parentRow = screen.getByText("父任务").closest(".pw-task-row")!;
    const del = within(parentRow as HTMLElement).getByTitle("删除");
    fireEvent.click(del); // 首击：仅确认
    expect(calls.deleted.length).toBe(0);
    expect(toasts.some((t) => t.includes("子任务"))).toBe(true);
    fireEvent.click(del); // 再击：真删
    await waitFor(() => expect(calls.deleted).toContain("parent"));
  });

  it("删除无子任务的叶子任务 → 立即删除、不弹确认", async () => {
    const toasts: string[] = [];
    const { bridge, calls } = fakeTasksBridge([task("a", "叶子", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <TaskListColumn selection={{ kind: "project", id: "p1" }} onOpenTask={() => {}} onToast={(t) => toasts.push(t)} />
      </CoreProvider>,
    );
    await screen.findByText("叶子");
    const row = screen.getByText("叶子").closest(".pw-task-row")!;
    fireEvent.click(within(row as HTMLElement).getByTitle("删除"));
    await waitFor(() => expect(calls.deleted).toContain("a"));
    expect(toasts.some((t) => t.includes("子任务"))).toBe(false); // 无确认 toast
  });

  it("waiting 父（已委派）全部子完成 → 点「完成此任务」被 canTransition 拒绝、不置 done、toast", async () => {
    const toasts: string[] = [];
    const { bridge, calls } = fakeTasksBridge(
      [
        task("p", "已委派父", {
          projectId: "p1",
          status: "waiting",
          delegation: { sessionId: "s1", state: "running" },
        }),
        task("c", "子", { projectId: "p1", parentTaskId: "p", status: "done" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <TaskListColumn selection={{ kind: "project", id: "p1" }} onOpenTask={() => {}} onToast={(t) => toasts.push(t)} />
      </CoreProvider>,
    );
    const suggest = await screen.findByText("✓ 完成此任务");
    fireEvent.click(suggest);
    // waiting→done 非用户合法迁移 → 不发 done patch、给 toast。
    expect(calls.update.some((u) => u.patch.status === "done")).toBe(false);
    expect(toasts.some((t) => t.includes("无法"))).toBe(true);
  });

  it("折叠父后点「添加子任务」→ 父自动展开、子可见", async () => {
    const { bridge } = fakeTasksBridge(
      [
        task("p", "父", { projectId: "p1" }),
        task("c", "既有子", { projectId: "p1", parentTaskId: "p" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });
    await screen.findByText("既有子");
    const parentRow = () => screen.getByText("父").closest(".pw-task-row")!;
    // 先折叠父 → 既有子隐藏。
    fireEvent.click(parentRow().querySelector<HTMLButtonElement>(".pw-task-twisty")!);
    expect(screen.queryByText("既有子")).toBeNull();
    // 点「添加子任务」→ 父自动展开，既有子重新可见。
    fireEvent.click(within(parentRow() as HTMLElement).getByTitle("添加子任务"));
    await waitFor(() => expect(screen.queryByText("既有子")).not.toBeNull());
  });

  it("全部子任务完成 → 父浮现「完成此任务」建议，点击才置 done", async () => {
    const { bridge, calls } = fakeTasksBridge(
      [
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent", status: "done" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "project", id: "p1" });

    // 父行浮现建议（子任务 done 被中列活动过滤，但 rollup 派生看全量）。
    const suggest = await screen.findByText("✓ 完成此任务");
    expect(calls.update.length).toBe(0); // 未自动 done
    fireEvent.click(suggest);
    await waitFor(() => expect(calls.update.some((u) => u.id === "parent" && u.patch.status === "done")).toBe(true));
  });

  it("选中任务 → 行高亮 + 行内展开 inspector（含状态控件）", async () => {
    const { bridge } = fakeTasksBridge([task("a", "被选中", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, "a");

    await screen.findByText("被选中");
    const row = screen.getByText("被选中").closest(".pw-task-row")!;
    expect(row.classList.contains("is-selected")).toBe(true);
    // 行内 inspector 挂载（共享字段面板的状态控件出现）。
    expect(row.querySelector(".pw-task-inspector .pw-task-status-seg")).not.toBeNull();
  });

  it("未选中任务不渲染行内 inspector", async () => {
    const { bridge } = fakeTasksBridge([task("a", "未选", { projectId: "p1" })], [{ id: "p1", name: "项目一" }]);
    renderColumn(bridge, { kind: "project", id: "p1" }, null);

    await screen.findByText("未选");
    const row = screen.getByText("未选").closest(".pw-task-row")!;
    expect(row.classList.contains("is-selected")).toBe(false);
    expect(row.querySelector(".pw-task-inspector")).toBeNull();
  });

  it("Today 视图下父不在 scope → 子任务扁平（无缩进）", async () => {
    const { bridge } = fakeTasksBridge(
      [
        // 父无 due → 不进 Today；子 due=今天 → 进 Today，父不在 scope 故子升顶层。
        task("parent", "父任务", { projectId: "p1" }),
        task("child", "子任务", { projectId: "p1", parentTaskId: "parent", dueDate: "2026-07-01" }),
      ],
      [{ id: "p1", name: "项目一" }],
    );
    renderColumn(bridge, { kind: "today" });

    await screen.findByText("子任务");
    expect(screen.queryByText("父任务")).toBeNull();
    const childRow = screen.getByText("子任务").closest(".pw-task-row")!;
    expect(childRow.querySelector(".pw-task-indent")).toBeNull(); // depth 0，无缩进
  });
});
