// 快速入口对话框组件测试:输入过滤、↑↓ 移动高亮、Enter 触发 onPick(结果对象)、Esc 触发 onClose、空 query 显 hint。
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { QuickOpenDialog } from "./QuickOpenDialog";
import type { QuickOpenResult } from "./quickOpenSearch";

// 只读桥:提供 tasksList / tasksListProjects 让 useTasks/useTaskProjects 拿到数据。
function fakeBridge(tasks: TaskMeta[], projects: TaskProject[]): DesktopBridge {
  return {
    tasksList: async () => tasks,
    tasksListProjects: async () => projects,
    onTasksChanged: () => () => {},
  } as unknown as DesktopBridge;
}

function task(id: string, title: string, extra: Partial<TaskMeta> = {}): TaskMeta {
  return { id, title, status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra };
}

function renderDialog(opts: {
  tasks?: TaskMeta[];
  projects?: TaskProject[];
  open?: boolean;
  onClose?: () => void;
  onPick?: (r: QuickOpenResult) => void;
}) {
  const bridge = fakeBridge(opts.tasks ?? [], opts.projects ?? []);
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <QuickOpenDialog
        open={opts.open ?? true}
        onClose={opts.onClose ?? (() => {})}
        onPick={opts.onPick ?? (() => {})}
      />
    </CoreProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QuickOpenDialog", () => {
  it("open=false 不渲染", () => {
    const { container } = renderDialog({ open: false });
    expect(container.querySelector(".pw-search-dlg")).toBeNull();
  });

  it("空 query 显示 hint", () => {
    const { getByText, container } = renderDialog({ tasks: [task("t1", "写周报")] });
    expect(getByText("输入以搜索任务或项目")).toBeTruthy();
    expect(container.querySelectorAll(".pw-search-row").length).toBe(0);
  });

  it("输入过滤出结果", async () => {
    const { container } = renderDialog({
      tasks: [task("t1", "修复登录 bug"), task("t2", "重构样式"), task("t3", "登录页优化")],
    });
    const input = container.querySelector(".pw-search-input input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "登录" } });
    await waitFor(() => expect(container.querySelectorAll(".pw-search-row").length).toBe(2));
    expect(container.textContent).toContain("修复登录 bug");
    expect(container.textContent).toContain("登录页优化");
    expect(container.textContent).not.toContain("重构样式");
  });

  it("↑↓ 移动高亮", async () => {
    const { container } = renderDialog({
      tasks: [task("t1", "任务甲"), task("t2", "任务乙"), task("t3", "任务丙")],
    });
    const dlg = container.querySelector(".pw-search-dlg") as HTMLElement;
    const input = container.querySelector(".pw-search-input input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "任务" } });
    await waitFor(() => expect(container.querySelectorAll(".pw-search-row").length).toBe(3));
    // 默认首条高亮。
    let rows = container.querySelectorAll(".pw-search-row");
    expect(rows[0]!.classList.contains("is-active")).toBe(true);
    // ↓ 到第二条。
    fireEvent.keyDown(dlg, { key: "ArrowDown" });
    rows = container.querySelectorAll(".pw-search-row");
    expect(rows[1]!.classList.contains("is-active")).toBe(true);
    // ↑ 回到首条。
    fireEvent.keyDown(dlg, { key: "ArrowUp" });
    rows = container.querySelectorAll(".pw-search-row");
    expect(rows[0]!.classList.contains("is-active")).toBe(true);
  });

  it("Enter 触发 onPick(当前高亮结果对象)", async () => {
    const onPick = vi.fn();
    const { container } = renderDialog({
      tasks: [task("t1", "任务甲"), task("t2", "任务乙")],
      onPick,
    });
    const dlg = container.querySelector(".pw-search-dlg") as HTMLElement;
    const input = container.querySelector(".pw-search-input input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "任务" } });
    await waitFor(() => expect(container.querySelectorAll(".pw-search-row").length).toBe(2));
    fireEvent.keyDown(dlg, { key: "ArrowDown" }); // 高亮第二条
    fireEvent.keyDown(dlg, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ kind: "task", id: "t2", label: "任务乙" });
  });

  it("Esc 触发 onClose", () => {
    const onClose = vi.fn();
    const { container } = renderDialog({ tasks: [task("t1", "写周报")], onClose });
    const dlg = container.querySelector(".pw-search-dlg") as HTMLElement;
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
