import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";

import { ConversationSplitView } from "./ConversationSplitView";
import { SESSION_DRAG_MIME } from "./conversation-drag";
import type { SessionDropPlacement } from "./conversation-drag";

const NOW = Date.now();
const SESSIONS: SessionMeta[] = [
  { id: "s1", projectId: "p1", title: "第一会话", agent: "claude", createdAt: NOW, updatedAt: NOW },
  { id: "s2", projectId: "p1", title: "第二会话", agent: "codex", createdAt: NOW, updatedAt: NOW },
  { id: "s3", projectId: "p1", title: "第三会话", agent: "pi", createdAt: NOW, updatedAt: NOW },
];

const PLACEMENT_POINT: Record<SessionDropPlacement, { x: number; y: number; label: string }> = {
  top: { x: 500, y: 50, label: "上方" },
  right: { x: 900, y: 350, label: "右侧" },
  bottom: { x: 500, y: 650, label: "下方" },
  left: { x: 100, y: 350, label: "左侧" },
};

function dataTransfer(sessionId: string): DataTransfer {
  const values = new Map<string, string>([[SESSION_DRAG_MIME, sessionId]]);
  return {
    types: [SESSION_DRAG_MIME],
    effectAllowed: "uninitialized",
    dropEffect: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
  } as unknown as DataTransfer;
}

function renderView() {
  const bridge = {
    loadChat: async () => [],
    saveChat: async () => {},
  } as unknown as DesktopBridge;
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <ConversationSplitView onToast={() => {}} />
    </CoreProvider>,
  );
}

function fireDrag(
  target: HTMLElement,
  type: "dragEnter" | "dragOver" | "drop",
  transfer: DataTransfer,
  clientX: number,
  clientY: number,
) {
  // jsdom 没有原生 DragEvent，Testing Library 构造参数中的坐标会丢失；显式补齐两个坐标，
  // 才能真实覆盖四向主轴判定，而不是所有用例都落到默认右侧。
  const event = createEvent[type](target, { dataTransfer: transfer });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

function dropOn(targetSessionId: string, droppedSessionId: string, placement: SessionDropPlacement) {
  const target = document.querySelector<HTMLElement>(`[data-session-id="${targetSessionId}"]`);
  expect(target).not.toBeNull();
  target!.getBoundingClientRect = () =>
    ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const transfer = dataTransfer(droppedSessionId);
  const point = PLACEMENT_POINT[placement];
  fireDrag(target!, "dragEnter", transfer, point.x, point.y);
  expect(screen.getByRole("status")).toHaveTextContent(`在${point.label}拆分会话`);
  fireDrag(target!, "drop", transfer, point.x, point.y);
}

function paneIds(container: HTMLElement): Array<string | undefined> {
  return Array.from(container.querySelectorAll<HTMLElement>(".pw-conversation-pane")).map(
    (pane) => pane.dataset.sessionId,
  );
}

describe("ConversationSplitView 会话四向拖放拆分", () => {
  beforeEach(() => {
    usePersonalStore.setState({
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: SESSIONS,
      activeProjectId: "p1",
      activeSessionId: "s1",
      homeOpen: false,
      automationOpen: false,
      workflowOpen: false,
      settingsOpen: false,
      composerInsert: undefined,
      composerSkill: undefined,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    ["top", "vertical", ["s2", "s1"]],
    ["right", "horizontal", ["s1", "s2"]],
    ["bottom", "vertical", ["s1", "s2"]],
    ["left", "horizontal", ["s2", "s1"]],
  ] as const)("支持拖到 %s 建立首个拆分", (placement, axis, expectedIds) => {
    const { container } = renderView();
    dropOn("s1", "s2", placement);

    expect(screen.getByTestId("conversation-split")).toBeInTheDocument();
    expect(container.querySelector("[data-split-axis]")).toHaveAttribute("data-split-axis", axis);
    expect(paneIds(container)).toEqual(expectedIds);
    expect(usePersonalStore.getState().activeSessionId).toBe("s2");
  });

  it("可在任意叶子旁继续局部拆分，形成混合横纵布局", () => {
    const { container } = renderView();
    dropOn("s1", "s2", "right");
    dropOn("s1", "s3", "bottom");

    expect(paneIds(container)).toEqual(["s1", "s3", "s2"]);
    const firstPane = container.querySelector<HTMLElement>('[data-session-id="s1"]');
    expect(firstPane?.parentElement).toHaveAttribute("data-split-axis", "vertical");
    expect(container.querySelectorAll('[data-split-axis="horizontal"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-split-axis="vertical"]')).toHaveLength(1);
    expect(usePersonalStore.getState().activeSessionId).toBe("s3");
  });

  it("重复拖入已打开会话只聚焦，不制造重复叶子", () => {
    const { container } = renderView();
    dropOn("s1", "s2", "right");
    dropOn("s1", "s3", "bottom");
    dropOn("s3", "s2", "left");

    expect(paneIds(container)).toEqual(["s1", "s3", "s2"]);
    expect(usePersonalStore.getState().activeSessionId).toBe("s2");
  });

  it("关闭叶子会折叠空分支，最后一个拆分关闭后回到单窗格", () => {
    const { container } = renderView();
    dropOn("s1", "s2", "right");
    dropOn("s1", "s3", "bottom");

    fireEvent.click(screen.getByRole("button", { name: "关闭 第三会话 窗格" }));
    expect(paneIds(container)).toEqual(["s1", "s2"]);
    expect(container.querySelectorAll('[data-split-axis="vertical"]')).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "关闭 第二会话 窗格" }));
    expect(screen.queryByTestId("conversation-split")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation-single-pane")).toHaveAttribute("data-session-id", "s1");
    expect(usePersonalStore.getState().activeSessionId).toBe("s1");
  });

  it("全局插入信号只进入活动窗格的输入框", async () => {
    renderView();
    dropOn("s1", "s2", "bottom");

    act(() => usePersonalStore.getState().insertToComposer("只进入活动窗格"));

    await waitFor(() => {
      const values = screen.getAllByRole<HTMLTextAreaElement>("textbox").map((input) => input.value);
      expect(values).toEqual(["", "只进入活动窗格"]);
    });
  });

  it("拆分后从侧栏选择新会话时，只替换最后聚焦的叶子", async () => {
    const { container } = renderView();
    dropOn("s1", "s2", "right");
    const firstPane = container.querySelector<HTMLElement>('[data-session-id="s1"]');
    expect(firstPane).not.toBeNull();
    fireEvent.pointerDown(firstPane!);

    act(() => usePersonalStore.getState().setActiveSession("s3"));

    await waitFor(() => expect(paneIds(container)).toEqual(["s3", "s2"]));
  });

  it("外部文件或普通文本拖放不会触发拆分", () => {
    renderView();
    const target = screen.getByTestId("conversation-single-pane");
    target.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const transfer = {
      ...dataTransfer("s2"),
      types: ["text/plain"],
    } as DataTransfer;

    fireDrag(target, "dragOver", transfer, 900, 350);
    fireDrag(target, "drop", transfer, 900, 350);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversation-split")).not.toBeInTheDocument();
  });
});
