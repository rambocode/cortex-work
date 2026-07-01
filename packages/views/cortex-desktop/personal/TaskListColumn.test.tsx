import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskInput, TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
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

function renderColumn(bridge: DesktopBridge, selection: WorkbenchSelection) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TaskListColumn selection={selection} onOpenTask={() => {}} onToast={() => {}} />
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
