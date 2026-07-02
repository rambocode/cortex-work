// U1 右列 TaskDetail 草稿守卫回归：title/notes 未聚焦时跟随外部值（跨列/跨窗口热更）、
// 聚焦中不被冲掉、blur 提交。CodeMirror 编辑器被替身 textarea 替换，避免 jsdom 里动态装载 @codemirror。
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import { TaskDetail } from "./TaskDetail";

// 替身备注编辑器：转发 value/onChange，保留外层 wrap 的 focusin/focusout 冒泡语义。
vi.mock("./editor/NoteCodeMirrorEditor", () => ({
  NoteCodeMirrorEditor: (props: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="cm-note" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
  ),
}));

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
  return { id: "t1", title: "标题", status: "active", tags: [], source: "manual", createdAt: 0, updatedAt: 0, ...extra };
}

function renderDetail(bridge: DesktopBridge, t: TaskMeta) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TaskDetail task={t} onBack={() => {}} onToast={() => {}} />
    </CoreProvider>,
  );
}

function rerenderDetail(rerender: (ui: React.ReactElement) => void, bridge: DesktopBridge, t: TaskMeta) {
  rerender(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <TaskDetail task={t} onBack={() => {}} onToast={() => {}} />
    </CoreProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TaskDetail 草稿守卫（U1）", () => {
  it("未聚焦时外部标题变化 → 标题 input 跟随（中列改 → 右列更新）", () => {
    const { bridge } = fakeBridge();
    const { rerender } = renderDetail(bridge, task({ title: "旧标题" }));
    const input = screen.getByPlaceholderText("任务标题") as HTMLInputElement;
    expect(input.value).toBe("旧标题");
    // 同一任务、外部权威值更新（tasks:changed 重拉后 parent 传入新 task prop）。
    rerenderDetail(rerender, bridge, task({ title: "新标题" }));
    expect((screen.getByPlaceholderText("任务标题") as HTMLInputElement).value).toBe("新标题");
  });

  it("标题聚焦输入中 → 外部更新不覆盖草稿（AE2）", () => {
    const { bridge } = fakeBridge();
    const { rerender } = renderDetail(bridge, task({ title: "旧标题" }));
    const input = screen.getByPlaceholderText("任务标题") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "输入中未保存" } });
    rerenderDetail(rerender, bridge, task({ title: "外部改" }));
    expect((screen.getByPlaceholderText("任务标题") as HTMLInputElement).value).toBe("输入中未保存");
  });

  it("标题 blur 提交：草稿 ≠ 外部值时发 title patch（trim 归一）", async () => {
    const { bridge, calls } = fakeBridge();
    renderDetail(bridge, task({ title: "旧标题" }));
    const input = screen.getByPlaceholderText("任务标题") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "  改后标题  " } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls.update.some((u) => u.id === "t1" && u.patch.title === "改后标题")).toBe(true));
  });

  it("未聚焦时外部备注变化 → 备注编辑器热更（跨列/跨窗口）", () => {
    const { bridge } = fakeBridge();
    const { rerender } = renderDetail(bridge, task({ notes: "旧备注" }));
    expect((screen.getByTestId("cm-note") as HTMLTextAreaElement).value).toBe("旧备注");
    rerenderDetail(rerender, bridge, task({ notes: "外部改的备注" }));
    expect((screen.getByTestId("cm-note") as HTMLTextAreaElement).value).toBe("外部改的备注");
  });

  it("备注聚焦编辑中 → 外部更新不覆盖（wrap 的 focusin/focusout 追踪聚焦态）", () => {
    const { bridge } = fakeBridge();
    const { rerender } = renderDetail(bridge, task({ notes: "旧备注" }));
    const cm = screen.getByTestId("cm-note") as HTMLTextAreaElement;
    fireEvent.focus(cm); // 冒泡到 .pw-task-detail-note-wrap → notes.onFocus
    fireEvent.change(cm, { target: { value: "备注输入中" } });
    rerenderDetail(rerender, bridge, task({ notes: "外部改的备注" }));
    expect((screen.getByTestId("cm-note") as HTMLTextAreaElement).value).toBe("备注输入中");
  });
});
