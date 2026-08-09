import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, SessionMeta } from "@cortex-work/core";

import { ConversationSplitView } from "./ConversationSplitView";
import { SESSION_DRAG_MIME } from "./conversation-drag";

const NOW = Date.now();
const SESSIONS: SessionMeta[] = [
  { id: "s1", projectId: "p1", title: "左侧会话", agent: "claude", createdAt: NOW, updatedAt: NOW },
  { id: "s2", projectId: "p1", title: "右侧会话", agent: "codex", createdAt: NOW, updatedAt: NOW },
  { id: "s3", projectId: "p1", title: "替换会话", agent: "pi", createdAt: NOW, updatedAt: NOW },
];

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
) {
  // jsdom 没有原生 DragEvent，Testing Library 会退化成普通 Event，构造参数里的
  // clientX 会被丢掉；显式定义坐标才能真实覆盖“仅右半边接受 drop”的边界。
  const event = createEvent[type](target, { dataTransfer: transfer });
  Object.defineProperty(event, "clientX", { value: clientX });
  fireEvent(target, event);
}

function splitWith(sessionId: string) {
  const surface = screen.getByTestId("conversation-split-surface");
  surface.getBoundingClientRect = () =>
    ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const transfer = dataTransfer(sessionId);
  fireDrag(surface, "dragEnter", transfer, 800);
  expect(screen.getByRole("status")).toHaveTextContent("在右侧拆分会话");
  fireDrag(surface, "drop", transfer, 800);
}

describe("ConversationSplitView 会话拖放拆分", () => {
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

  it("把会话拖到内容区右半边后并排打开，并让新窗格成为活动会话", () => {
    const { container } = renderView();
    splitWith("s2");

    expect(screen.getByTestId("conversation-split")).toBeInTheDocument();
    const panes = Array.from(container.querySelectorAll<HTMLElement>(".pw-conversation-pane"));
    expect(panes.map((pane) => pane.dataset.sessionId)).toEqual(["s1", "s2"]);
    expect(container.querySelectorAll(".pw-split-pane-head strong")).toHaveLength(2);
    expect(usePersonalStore.getState().activeSessionId).toBe("s2");
    expect(panes[1]).toHaveClass("is-active");
  });

  it("关闭任一窗格后回到单窗格，并把剩余会话设为活动会话", () => {
    renderView();
    splitWith("s2");

    fireEvent.click(screen.getByRole("button", { name: "关闭 右侧会话 窗格" }));

    expect(screen.queryByTestId("conversation-split")).not.toBeInTheDocument();
    expect(usePersonalStore.getState().activeSessionId).toBe("s1");
  });

  it("窗格数量不设上限：继续拖入会追加到最右侧，重复拖入只聚焦", () => {
    const { container } = renderView();
    splitWith("s2");
    splitWith("s3");

    let paneIds = Array.from(container.querySelectorAll<HTMLElement>(".pw-conversation-pane")).map(
      (pane) => pane.dataset.sessionId,
    );
    expect(paneIds).toEqual(["s1", "s2", "s3"]);
    expect(usePersonalStore.getState().activeSessionId).toBe("s3");

    splitWith("s2");
    paneIds = Array.from(container.querySelectorAll<HTMLElement>(".pw-conversation-pane")).map(
      (pane) => pane.dataset.sessionId,
    );
    expect(paneIds).toEqual(["s1", "s2", "s3"]);
    expect(usePersonalStore.getState().activeSessionId).toBe("s2");
  });

  it("全局插入信号只进入活动窗格的输入框", async () => {
    renderView();
    splitWith("s2");

    act(() => usePersonalStore.getState().insertToComposer("只进入活动窗格"));

    await waitFor(() => {
      const values = screen.getAllByRole<HTMLTextAreaElement>("textbox").map((input) => input.value);
      expect(values).toEqual(["", "只进入活动窗格"]);
    });
  });

  it("拆分后从侧栏选择新会话时，只替换最后聚焦的窗格", async () => {
    const { container } = renderView();
    splitWith("s2");
    const leftPane = container.querySelector<HTMLElement>('[data-session-id="s1"]');
    expect(leftPane).not.toBeNull();
    fireEvent.pointerDown(leftPane!);

    act(() => usePersonalStore.getState().setActiveSession("s3"));

    await waitFor(() => {
      const paneIds = Array.from(container.querySelectorAll<HTMLElement>(".pw-conversation-pane")).map(
        (pane) => pane.dataset.sessionId,
      );
      expect(paneIds).toEqual(["s3", "s2"]);
    });
  });

  it("拖到左半边不会误触拆分", () => {
    renderView();
    const surface = screen.getByTestId("conversation-split-surface");
    surface.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const transfer = dataTransfer("s2");

    fireDrag(surface, "dragOver", transfer, 200);
    fireDrag(surface, "drop", transfer, 200);

    expect(screen.queryByTestId("conversation-split")).not.toBeInTheDocument();
    expect(usePersonalStore.getState().activeSessionId).toBe("s1");
  });
});
