import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { PersonalCenterHeader } from "./PersonalTopBar";

const bridge = {} as unknown as DesktopBridge;

function renderHeader() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PersonalCenterHeader />
    </CoreProvider>,
  );
}

describe("PersonalCenterHeader 面板下拉(光标移出自动收起)", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    useCortexUIStore.setState({ rightOpen: false });
    usePersonalStore.setState({ terminalOpen: false, rightView: "files" });
  });

  it("点击展开,光标移出菜单区域后短延迟自动收起", async () => {
    renderHeader();
    const btn = screen.getByTitle("右侧面板");
    const wrap = btn.closest(".pw-tb-menu-wrap") as HTMLElement;

    fireEvent.click(btn);
    expect(screen.getByText("展开右侧面板")).toBeInTheDocument();

    fireEvent.mouseLeave(wrap);
    await waitFor(() => expect(screen.queryByText("展开右侧面板")).toBeNull());
  });

  it("移出后立即移入 → 取消收起,菜单保持打开", async () => {
    renderHeader();
    const btn = screen.getByTitle("右侧面板");
    const wrap = btn.closest(".pw-tb-menu-wrap") as HTMLElement;

    fireEvent.click(btn);
    fireEvent.mouseLeave(wrap);
    fireEvent.mouseEnter(wrap);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByText("展开右侧面板")).toBeInTheDocument();
  });
});

// 会话标题 / agent 标签 / 项目路径 / pi 运行时徽标 / Agent 选择器均已从旧 chat-head 上移到顶栏。
describe("PersonalCenterHeader 会话头（PersonalSessionHeader）", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    useCortexUIStore.setState({ rightOpen: false });
    usePersonalStore.setState({
      homeOpen: false,
      automationOpen: false,
      settingsOpen: false,
      noteEditorId: undefined,
      timelineProjectId: undefined,
      terminalOpen: false,
      rightView: "files",
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 0 }],
      sessions: [{ id: "s1", projectId: "p1", title: "会话标题X", agent: "pi", createdAt: 0, updatedAt: 0 }],
      activeProjectId: "p1",
      activeSessionId: "s1",
      runningBySession: {},
      piRuntimeBySession: {},
      providerSettings: { providers: [] },
    });
  });

  it("会话视图顶栏显示会话标题与 agent 标签", () => {
    renderHeader();
    expect(screen.getByText("会话标题X")).toBeInTheDocument();
    // agent 标签 + Agent 选择器都用 Pi 文案 → 至少出现一次。
    expect(screen.getAllByText("Pi").length).toBeGreaterThan(0);
  });

  it("项目路径默认收起,点路径按钮后展示项目名与路径", () => {
    renderHeader();
    expect(screen.queryByText("/code/alpha")).toBeNull();
    fireEvent.click(screen.getByLabelText("项目路径"));
    expect(screen.getByText("/code/alpha")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("pi 运行时状态徽标:压缩 / 重试 / 待注入 / 思考强度", () => {
    usePersonalStore.getState().setPiRuntime("s1", {
      compacting: true,
      retry: { attempt: 2, max: 3 },
      steering: 1,
      thinkingLevel: "high",
    });
    renderHeader();
    expect(screen.getByText("压缩上下文…")).toBeInTheDocument();
    expect(screen.getByText(/重试中 2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/1 条待注入/)).toBeInTheDocument();
    expect(screen.getByText(/思考 high/)).toBeInTheDocument();
  });

  it("claude 会话不显示 pi 运行时徽标（即便误置 runtime）", () => {
    usePersonalStore.setState({
      sessions: [{ id: "s1", projectId: "p1", title: "S", agent: "claude", createdAt: 0, updatedAt: 0 }],
    });
    usePersonalStore.getState().setPiRuntime("s1", { compacting: true });
    renderHeader();
    expect(screen.getByText("S")).toBeInTheDocument();
    expect(screen.queryByText("压缩上下文…")).toBeNull();
  });

  it("Agent 选择器点击展开下拉,列出可切换 agent", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /Pi/ }));
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });
});
