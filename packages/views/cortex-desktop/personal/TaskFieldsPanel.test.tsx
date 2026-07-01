import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskMeta, TaskProject } from "@cortex-work/core/desktop/types";
import { TaskFieldsPanel } from "./TaskFieldsPanel";

function fakeBridge(projects: TaskProject[] = []) {
  const calls = { update: [] as Array<{ id: string; patch: Record<string, unknown> }> };
  const bridge = {
    tasksList: async () => [],
    tasksListProjects: async () => projects,
    tasksUpdate: async (id: string, patch: Record<string, unknown>) => {
      calls.update.push({ id, patch });
      return null;
    },
    onTasksChanged: () => () => {},
  } as unknown as DesktopBridge;
  return { bridge, calls };
}

function task(extra: Partial<TaskMeta> = {}): TaskMeta {
  return { id: "t1", title: "任务", status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra };
}

function renderPanel(bridge: DesktopBridge, t: TaskMeta) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TaskFieldsPanel task={t} layout="column" onToast={() => {}} />
    </CoreProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TaskFieldsPanel（U5）", () => {
  it("状态控件渲染 5 态、当前高亮，点击切换发 patch", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = renderPanel(bridge, task({ status: "active" }));
    const opts = container.querySelectorAll(".pw-task-status-opt");
    expect(opts.length).toBe(5);
    expect(container.querySelector(".pw-task-status-opt.is-on")!.textContent).toBe("活动");
    fireEvent.click(screen.getByText("已完成"));
    await waitFor(() => expect(calls.update.some((u) => u.patch.status === "done")).toBe(true));
  });

  it("项目下拉只列 project，过滤 folder", async () => {
    const { bridge } = fakeBridge([
      { id: "f1", name: "分组", kind: "folder" },
      { id: "p1", name: "项目一", kind: "project" },
    ]);
    renderPanel(bridge, task());
    expect(await screen.findByText("项目一")).toBeTruthy();
    expect(screen.queryByText("分组")).toBeNull(); // folder 不出现在 select
  });

  it("空富字段隐藏于「＋添加属性」后，点开才显形", async () => {
    const { bridge } = fakeBridge();
    renderPanel(bridge, task());
    // 未填时不渲染时长字段本体，仅「＋预计时长」入口。
    expect(screen.queryByText("预计时长")).toBeNull();
    fireEvent.click(screen.getByTitle("添加预计时长"));
    expect(screen.getByText("预计时长")).toBeTruthy();
  });
});
