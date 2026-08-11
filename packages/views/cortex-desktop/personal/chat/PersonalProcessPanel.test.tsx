// 完整运行详情弹层宿主测试。可见入口已迁入 ConversationProcessTimeline，本组件只响应
// sessionId + nonce 打开请求，并负责会话切换/非聊天视图时的安全收尾。
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreProvider,
  personalRunEventsKeys,
  usePersonalStore,
  type RunEvent,
} from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { PersonalProcessPanel } from "./PersonalProcessPanel";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

function renderPanel(runEvents: RunEvent[] = []) {
  const qc = new QueryClient();
  qc.setQueryData(personalRunEventsKeys.detail("s1"), runEvents);
  usePersonalStore.setState({
    homeOpen: false,
    automationOpen: false,
    settingsOpen: false,
    noteEditorId: undefined,
    processPanelOpenReq: undefined,
    projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: 0, updatedAt: 0 }],
    activeProjectId: "p1",
    activeSessionId: "s1",
    runningBySession: {},
  });
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge} queryClient={qc}>
      <PersonalProcessPanel />
    </CoreProvider>,
  );
}

describe("PersonalProcessPanel", () => {
  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      automationOpen: false,
      settingsOpen: false,
      noteEditorId: undefined,
      processPanelOpenReq: undefined,
    });
  });
  afterEach(() => cleanup());

  it("不再渲染独立状态按钮，由内联过程段请求打开完整详情", async () => {
    const now = Date.now();
    const view = renderPanel([
      {
        runId: "run-1",
        ts: now,
        ev: { type: "tool", name: "Bash", detail: "ls -la", input: { command: "ls -la" }, phase: "start", toolCallId: "bash-1" },
      },
      {
        runId: "run-1",
        ts: now + 1,
        ev: { type: "tool", name: "Bash", output: "a.txt\nb.txt", phase: "end", toolCallId: "bash-1" },
      },
    ]);

    expect(view.container.querySelector(".pw-process")).not.toBeInTheDocument();
    expect(view.queryByRole("dialog", { name: "运行过程详情" })).not.toBeInTheDocument();

    act(() => usePersonalStore.getState().requestOpenProcessPanel("s1"));
    const dialog = await view.findByRole("dialog", { name: "运行过程详情" });
    await waitFor(() => expect(dialog).toHaveTextContent("ls -la"));
    expect(dialog).toHaveTextContent("a.txt");

    fireEvent.click(view.getByTitle("关闭"));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "运行过程详情" })).not.toBeInTheDocument());
  });

  it("忽略其它会话的请求，并在活动会话切换时关闭已打开弹层", async () => {
    const view = renderPanel();
    act(() => usePersonalStore.getState().requestOpenProcessPanel("other-session"));
    expect(view.queryByRole("dialog", { name: "运行过程详情" })).not.toBeInTheDocument();

    act(() => usePersonalStore.getState().requestOpenProcessPanel("s1"));
    await view.findByRole("dialog", { name: "运行过程详情" });
    act(() => {
      usePersonalStore.setState({
        sessions: [
          { id: "s1", projectId: "p1", title: "S1", agent: "claude", createdAt: 0, updatedAt: 0 },
          { id: "s2", projectId: "p1", title: "S2", agent: "claude", createdAt: 0, updatedAt: 0 },
        ],
        activeSessionId: "s2",
      });
    });
    await waitFor(() => expect(view.queryByRole("dialog", { name: "运行过程详情" })).not.toBeInTheDocument());
  });

  it("非会话视图不挂载弹层", () => {
    const view = renderPanel();
    act(() => {
      usePersonalStore.setState({ automationOpen: true });
      usePersonalStore.getState().requestOpenProcessPanel("s1");
    });
    expect(view.queryByRole("dialog", { name: "运行过程详情" })).not.toBeInTheDocument();
  });
});
