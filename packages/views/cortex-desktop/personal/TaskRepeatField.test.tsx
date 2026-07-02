import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskMeta, TaskRepeat } from "@cortex-work/core/desktop/types";
import { TaskRepeatField } from "./TaskRepeatField";

function fakeBridge() {
  const calls = { update: [] as Array<{ id: string; patch: Record<string, unknown> }> };
  const bridge = {
    tasksList: async () => [],
    tasksListProjects: async () => [],
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

function renderField(bridge: DesktopBridge, t: TaskMeta) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TaskRepeatField task={t} />
    </CoreProvider>,
  );
}

// 断言助手：某次 update 的 repeat 满足谓词。
const lastRepeat = (calls: { update: Array<{ patch: Record<string, unknown> }> }, pred: (r: TaskRepeat) => boolean) =>
  calls.update.some((u) => u.patch.repeat != null && pred(u.patch.repeat as TaskRepeat));

afterEach(cleanup);

describe("TaskRepeatField（U14）", () => {
  it("选『小时』单位 → repeat={kind:hourly}（分/时与天/周/月同级）", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = renderField(bridge, task());
    const sel = container.querySelector(".pw-task-repeat-unit") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "hourly" } });
    await waitFor(() => expect(lastRepeat(calls, (r) => r.kind === "hourly")).toBe(true));
  });

  it("月重复开『自定』→ 同时落 monthMode=day（否则滚动逻辑不认 monthDays）", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = renderField(bridge, task({ repeat: { kind: "monthly", interval: 1 } }));
    const cb = container.querySelector(".pw-task-repeat-custom-toggle input") as HTMLInputElement;
    fireEvent.click(cb);
    await waitFor(() => expect(lastRepeat(calls, (r) => r.custom === true && r.monthMode === "day")).toBe(true));
  });

  it("周自定：勾选『一』写入 weekdays=[1]", async () => {
    const { bridge, calls } = fakeBridge();
    const { container } = renderField(bridge, task({ repeat: { kind: "weekly", interval: 1, custom: true } }));
    const monBtn = [...container.querySelectorAll(".pw-task-weekday-chip")].find((b) => b.textContent === "一")!;
    fireEvent.click(monBtn);
    await waitFor(() => expect(lastRepeat(calls, (r) => JSON.stringify(r.weekdays) === "[1]")).toBe(true));
  });

  it("月自定切『周中的一天』→ 落 monthMode=weekday + ordinal/weekday 默认值", async () => {
    const { bridge, calls } = fakeBridge();
    const { getByText } = renderField(bridge, task({ repeat: { kind: "monthly", interval: 1, custom: true } }));
    fireEvent.click(getByText("周中的一天"));
    await waitFor(() =>
      expect(lastRepeat(calls, (r) => r.monthMode === "weekday" && r.ordinal === "1" && r.weekday === 1)).toBe(true),
    );
  });
});
