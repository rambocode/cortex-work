import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskInput, TaskMeta } from "@cortex-work/core/desktop/types";
import { TasksView } from "./TasksView";

// 内存任务桥：tasksList/add/update/delete/listProjects/onTasksChanged。
function fakeTasksBridge(initial: TaskMeta[] = []) {
  const store = new Map<string, TaskMeta>(initial.map((t) => [t.id, t]));
  let idc = 0;
  const calls = { update: [] as Array<{ id: string; patch: Record<string, unknown> }>, deleted: [] as string[] };
  const bridge = {
    tasksList: async (pid?: string) => {
      const all = [...store.values()];
      return pid === undefined ? all : all.filter((t) => t.projectId === pid);
    },
    tasksListProjects: async () => [],
    tasksAdd: async (input: TaskInput) => {
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
    tasksAddProject: async (name: string) => ({ id: `p${++idc}`, name }),
    tasksDeleteProject: async () => {},
    onTasksChanged: () => () => {},
  } as unknown as DesktopBridge;
  return { bridge, store, calls };
}

function renderView(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TasksView onToast={() => {}} />
    </CoreProvider>,
  );
}

afterEach(cleanup);

describe("TasksView", () => {
  it("渲染四个内置视图 tab", () => {
    const { bridge } = fakeTasksBridge();
    renderView(bridge);
    for (const label of ["今日", "收件箱", "项目", "标签"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("今日空态提示", async () => {
    const { bridge } = fakeTasksBridge();
    renderView(bridge);
    await waitFor(() => expect(screen.getByText(/今天没有到期或已安排/)).toBeTruthy());
  });

  it("快速新增 → 无项目任务出现在收件箱", async () => {
    const { bridge } = fakeTasksBridge();
    renderView(bridge);
    const input = screen.getByPlaceholderText(/添加任务/);
    fireEvent.change(input, { target: { value: "买牛奶" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByText("收件箱"));
    await waitFor(() => expect(screen.getByText("买牛奶")).toBeTruthy());
  });

  it("勾选完成 → 调用 tasksUpdate 置 done", async () => {
    const now = Date.now();
    const { bridge, calls } = fakeTasksBridge([
      { id: "a", title: "待办A", status: "active", tags: [], source: "manual", flagged: true, createdAt: now, updatedAt: now },
    ]);
    renderView(bridge);
    fireEvent.click(screen.getByText("今日")); // flagged 的 active 进今日
    const check = await screen.findByTitle("完成");
    fireEvent.click(check);
    await waitFor(() => expect(calls.update.some((c) => c.id === "a" && c.patch.status === "done")).toBe(true));
  });
});
