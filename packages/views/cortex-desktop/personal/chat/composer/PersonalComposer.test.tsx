// PersonalComposer 动态 slash 菜单(U4):pi/claude/codex 会话把已启用 skills 注入为 /skill:<name>
//(claude/codex 发送侧转定向 prompt,推翻旧 R6「不为 claude/codex 做 slash skill」),按 supportedAgents
// 过滤(与调用侧一致),选中 skill 插入待填参(R5)。
import type { ReactElement } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoreProvider,
  useCortexUIStore,
  usePersonalStore,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_PI_SKILLS,
  type DesktopBridge,
  type PluginSkill,
  type SessionMeta,
} from "@cortex-work/core";
import { PersonalComposer } from "./PersonalComposer";

const NOW = 1;
function session(agent: "pi" | "claude"): SessionMeta {
  return { id: "s1", projectId: "p1", title: "S1", agent, createdAt: NOW, updatedAt: NOW };
}

function fakeBridge(skills: PluginSkill[]): DesktopBridge {
  return { piSkillsList: vi.fn(async () => skills) } as unknown as DesktopBridge;
}

function sk(name: string, argumentHint?: string): PluginSkill {
  return { name, description: `${name} 描述`, dir: `/g/${name}`, rootPath: "/root", scope: "global", enabled: true, trusted: true, argumentHint, docs: [] };
}

function renderComposer(agent: "pi" | "claude", bridge: DesktopBridge): void {
  const ui: ReactElement = (
    <PersonalComposer
      session={session(agent)}
      running={false}
      onSend={() => {}}
      onStop={() => {}}
      onChangeModel={() => {}}
      onChangePiModel={() => {}}
      onChangeThinking={() => {}}
      onChangeExecPermission={() => {}}
      onToggleSkills={() => {}}
      onToggleWebSearch={() => {}}
      onToast={() => {}}
    />
  );
  render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

beforeEach(() => {
  usePersonalStore.setState({
    generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: { ...DEFAULT_PI_SKILLS } },
    projects: [{ id: "p1", name: "p", path: "/proj", addedAt: 1 }],
    activeProjectId: "p1",
  });
});
afterEach(() => cleanup());

describe("PersonalComposer 动态 slash 菜单", () => {
  it("pi 会话:slash 菜单含 skill(Title-Case 名)+ argHint + 描述(R3/R4)", async () => {
    renderComposer("pi", fakeBridge([sk("agent-browser", "<url>")]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    // 菜单展示 Title-Case 友好名(Agent Browser),不再是原始 /skill:agent-browser。
    await waitFor(() => expect(screen.getByText("Agent Browser")).toBeTruthy());
    expect(screen.getByText("<url>")).toBeTruthy();
    expect(screen.getByText("agent-browser 描述")).toBeTruthy();
    // 来源标签:用户目录 skill → 个人。
    expect(screen.getByText("个人")).toBeTruthy();
    // 内建命令仍在。
    expect(screen.getByText("/clear")).toBeTruthy();
  });

  it("claude 会话:菜单也含 skills(推翻旧 R6:claude/codex 现支持 /skill 定向调用)", async () => {
    renderComposer("claude", fakeBridge([sk("agent-browser", "<url>")]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    await waitFor(() => expect(screen.getByText("Agent Browser")).toBeTruthy());
    expect(screen.getByText("<url>")).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy(); // 内建仍在(claude 无 /compact)
  });

  it("claude 会话:supportedAgents 不含 claude 的 skill 不出现(与调用侧过滤一致)", async () => {
    const piOnly = { ...sk("pi-only"), supportedAgents: ["pi"] } as PluginSkill;
    renderComposer("claude", fakeBridge([piOnly, sk("agent-browser")]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    await waitFor(() => expect(screen.getByText("Agent Browser")).toBeTruthy());
    expect(screen.queryByText("Pi Only")).toBeNull();
  });

  it("pi 会话:禁用的 skill 不出现在菜单(R3)", async () => {
    usePersonalStore.setState({
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        piSkills: { ...DEFAULT_PI_SKILLS, disabledSkills: ["global:agent-browser"] },
      },
      projects: [{ id: "p1", name: "p", path: "/proj", addedAt: 1 }],
      activeProjectId: "p1",
    });
    renderComposer("pi", fakeBridge([sk("agent-browser"), sk("code-review")]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    await waitFor(() => expect(screen.getByText("Code Review")).toBeTruthy());
    expect(screen.queryByText("Agent Browser")).toBeNull();
  });

  it("pi 会话:无 piSkillsList(web/旧壳)→ 仅内建,无报错(R7)", async () => {
    renderComposer("pi", {} as unknown as DesktopBridge);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    expect(await screen.findByText("/clear")).toBeTruthy();
    expect(screen.getByText("/compact")).toBeTruthy(); // pi 内建仍在
    expect(screen.queryByText(/\/skill:/)).toBeNull();
  });

  // Design B(plan 002 U3):切 agent 传给 piSkillsList 的 rootSpecs 应不同(下拉随 agent 变化的根源)。
  it("pi 会话:piSkillsList 收到 pi 私有原生根 rootSpecs,不含 claude 原生根", async () => {
    const bridge = fakeBridge([sk("x")]);
    renderComposer("pi", bridge);
    const fn = bridge.piSkillsList as unknown as {
      mock: { calls: { rootSpecs: { path: string }[]; workspaceDir?: string }[][] };
    };
    await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(0));
    const paths = fn.mock.calls[0]![0]!.rootSpecs.map((r) => r.path);
    expect(paths).toContain("~/.pi/agent/skills");
    expect(paths).toContain("~/.agents/skills");
    expect(paths).not.toContain("~/.claude/skills");
    expect(fn.mock.calls[0]![0]!.workspaceDir).toBe("/proj");
  });

  it("claude 会话:piSkillsList 收到 claude 私有原生根 rootSpecs,不含 pi 原生根", async () => {
    const bridge = fakeBridge([sk("x")]);
    renderComposer("claude", bridge);
    const fn = bridge.piSkillsList as unknown as {
      mock: { calls: { rootSpecs: { path: string }[] }[][] };
    };
    await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(0));
    const paths = fn.mock.calls[0]![0]!.rootSpecs.map((r) => r.path);
    expect(paths).toContain("~/.claude/skills");
    expect(paths).not.toContain("~/.pi/agent/skills");
  });
});

describe("PersonalComposer 当前产物 Chip", () => {
  it("打开右栏编辑器并可解除当前产物绑定", () => {
    const activeArtifact = {
      kind: "design" as const,
      documentId: "design-1",
      title: "Home",
      workspaceRoot: "/proj",
      entryPath: "/proj/.cortex-design/design-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const active: SessionMeta = {
      ...session("claude"),
      activeArtifact,
    };
    usePersonalStore.setState({ sessions: [active], activeSessionId: active.id });
    useCortexUIStore.setState({ rightOpen: false });

    render(
      <CoreProvider
        wsId="w"
        identity={{ userId: "u", name: "n" }}
        desktopBridge={fakeBridge([])}
      >
        <PersonalComposer
          session={active}
          running={false}
          onSend={() => {}}
          onStop={() => {}}
          onChangeModel={() => {}}
          onChangePiModel={() => {}}
          onChangeThinking={() => {}}
          onChangeExecPermission={() => {}}
          onToggleSkills={() => {}}
          onToggleWebSearch={() => {}}
          onToast={() => {}}
        />
      </CoreProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开产物 Home" }));
    expect(usePersonalStore.getState().rightView).toBe("artifact");
    expect(useCortexUIStore.getState().rightOpen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "移除当前产物" }));
    expect(usePersonalStore.getState().sessions[0]?.activeArtifact).toBeUndefined();
    expect(usePersonalStore.getState().sessions[0]?.artifacts).toEqual([activeArtifact]);
  });
});
