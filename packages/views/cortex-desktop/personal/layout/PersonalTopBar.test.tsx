import { cleanup, render, screen, fireEvent } from "@testing-library/react";
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

describe("PersonalCenterHeader 右栏入口迁移", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    useCortexUIStore.setState({ rightOpen: false });
    usePersonalStore.setState({ terminalOpen: false, rightView: "files" });
  });

  it("顶部不再渲染右栏下拉与终端入口，由右侧竖向工具栏统一承载", () => {
    renderHeader();
    expect(screen.queryByTitle("右侧面板")).not.toBeInTheDocument();
    expect(screen.queryByTitle("打开终端")).not.toBeInTheDocument();
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
    // agent 标签 + Agent 选择器都用 Cortex 文案 → 至少出现一次。
    expect(screen.getAllByText("Cortex").length).toBeGreaterThan(0);
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

  // ── U7:派生 agent 选择器 ──
  it("agent 菜单列出派生新 id,选中写入 agent=base + derivedAgentId", () => {
    usePersonalStore.setState({
      derivedAgents: [{ id: "my-codex", base: "codex", label: "My Codex" }],
    });
    const { container } = renderHeader();
    fireEvent.click(container.querySelector(".pw-sh-agent-btn") as HTMLElement); // 开菜单
    fireEvent.click(screen.getByText("My Codex")); // 选派生
    const s = usePersonalStore.getState().sessions.find((x) => x.id === "s1")!;
    expect(s.agent).toBe("codex"); // session.agent 存 base
    expect(s.derivedAgentId).toBe("my-codex");
  });

  it("当前会话为派生 → 会话头与按钮显示派生名称", () => {
    usePersonalStore.setState({
      sessions: [{ id: "s1", projectId: "p1", title: "S", agent: "codex", derivedAgentId: "my-codex", createdAt: 0, updatedAt: 0 }],
      derivedAgents: [{ id: "my-codex", base: "codex", label: "My Codex" }],
    });
    renderHeader();
    expect(screen.getAllByText("My Codex").length).toBeGreaterThan(0);
  });

  it("覆盖内置同名 id 的派生不在菜单新增条目", () => {
    usePersonalStore.setState({
      derivedAgents: [{ id: "codex", base: "codex", label: "Override Codex" }],
    });
    const { container } = renderHeader();
    fireEvent.click(container.querySelector(".pw-sh-agent-btn") as HTMLElement);
    expect(screen.queryByText("Override Codex")).toBeNull(); // 不新增,仍走内置 Codex 项
  });

  it("切回内置清除 derivedAgentId", () => {
    usePersonalStore.setState({
      sessions: [{ id: "s1", projectId: "p1", title: "S", agent: "codex", derivedAgentId: "my-codex", createdAt: 0, updatedAt: 0 }],
      derivedAgents: [{ id: "my-codex", base: "codex", label: "My Codex" }],
      agentsAvailable: { claude: true, codex: true },
    });
    const { container } = renderHeader();
    fireEvent.click(container.querySelector(".pw-sh-agent-btn") as HTMLElement);
    fireEvent.click(screen.getByText("Claude Code")); // 切回内置
    const s = usePersonalStore.getState().sessions.find((x) => x.id === "s1")!;
    expect(s.agent).toBe("claude");
    expect(s.derivedAgentId).toBeUndefined();
  });

  it("Agent 选择器点击展开下拉,列出可切换 agent", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /Cortex/ }));
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });
});
