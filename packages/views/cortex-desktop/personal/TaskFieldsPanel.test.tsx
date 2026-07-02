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
    // 每档以 icon（svg）作视觉前缀，label 文本保留（可访问性 + textContent 契约不变）。
    opts.forEach((o) => expect(o.querySelector("svg")).toBeTruthy());
    expect(container.querySelector(".pw-task-status-opt.is-on")!.textContent).toBe("活动");
    fireEvent.click(screen.getByText("已完成"));
    await waitFor(() => expect(calls.update.some((u) => u.patch.status === "done")).toBe(true));
  });

  it("状态控件遵守 canTransition：agent-only 的「进行中」置灰；waiting→done 非法被拒", async () => {
    const { bridge, calls } = fakeBridge();
    // active 任务：「进行中」（agent-only）应置灰不可点。
    const { container, rerender } = renderPanel(bridge, task({ status: "active" }));
    const optByLabel = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".pw-task-status-opt")].find((b) => b.textContent === label)!;
    expect(optByLabel("进行中").disabled).toBe(true);
    // waiting 任务：「已完成」非法（须先取消委派），点击不发 patch。
    rerender(
      <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <TaskFieldsPanel task={task({ status: "waiting" })} layout="column" onToast={() => {}} />
      </CoreProvider>,
    );
    expect(optByLabel("已完成").disabled).toBe(true);
    fireEvent.click(optByLabel("已完成"));
    expect(calls.update.some((u) => u.patch.status === "done")).toBe(false);
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

  it("日期快捷 chips：截止「今天」写入 dueDate（本地日历日），「清除」置空", async () => {
    const { bridge, calls } = fakeBridge();
    // 推迟至 / 截止 各一组 datefield，按 JSX 顺序 [0]=推迟至、[1]=截止。
    const { container } = renderPanel(bridge, task());
    const dueField = container.querySelectorAll(".pw-task-datefield")[1] as HTMLElement;
    const isDate = (u: { patch: Record<string, unknown> }) =>
      typeof u.patch.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(u.patch.dueDate as string);
    const todayBtn = [...dueField.querySelectorAll("button")].find((b) => b.textContent === "今天")!;
    fireEvent.click(todayBtn);
    await waitFor(() => expect(calls.update.some(isDate)).toBe(true));
    // 「+1 月」走日历月推进（shiftMonth），同样产出合法本地日历日。
    const monthBtn = [...dueField.querySelectorAll("button")].find((b) => b.textContent === "+1 月")!;
    fireEvent.click(monthBtn);
    await waitFor(() => expect(calls.update.filter(isDate).length).toBeGreaterThanOrEqual(2));

    // 有值时出现「清除」→ 置 undefined。
    const { container: c2 } = renderPanel(bridge, task({ dueDate: "2026-07-08" }));
    const dueField2 = c2.querySelectorAll(".pw-task-datefield")[1] as HTMLElement;
    const clearBtn = [...dueField2.querySelectorAll("button")].find((b) => b.textContent === "清除")!;
    fireEvent.click(clearBtn);
    await waitFor(() =>
      expect(calls.update.some((u) => "dueDate" in u.patch && u.patch.dueDate === undefined)).toBe(true),
    );
  });

  it("重复：已重复任务显示间隔 N 输入，改 N 写入 interval（夹到 >=1）", async () => {
    const { bridge, calls } = fakeBridge();
    // 直接给已重复任务（isSet → 富字段自动展开，跳过渐进披露）。
    const { container } = renderPanel(bridge, task({ repeat: { kind: "weekly", interval: 1 } }));
    const n = container.querySelector(".pw-task-repeat-n") as HTMLInputElement;
    expect(n).toBeTruthy();
    fireEvent.change(n, { target: { value: "3" } });
    await waitFor(() =>
      expect(calls.update.some((u) => (u.patch.repeat as { interval?: number } | undefined)?.interval === 3)).toBe(true),
    );
    // 非法 0 → 归 1（不产生「每 0 周」死循环滚动）。
    fireEvent.change(n, { target: { value: "0" } });
    await waitFor(() =>
      expect(calls.update.some((u) => (u.patch.repeat as { interval?: number } | undefined)?.interval === 1)).toBe(true),
    );
  });
});
