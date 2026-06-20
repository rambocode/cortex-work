// PersonalComposer 动态 slash 菜单(U4):pi 会话把已启用 skills 注入为 /skill:<name>,
// claude/codex 不注入(R6),选中 skill 插入待填参(R5)。
import type { ReactElement } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoreProvider,
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
  return { name, description: `${name} 描述`, dir: `/g/${name}`, rootPath: "/root", scope: "global", enabled: true, trusted: true, argumentHint };
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
      onChangePiThinking={() => {}}
      onToggleSkills={() => {}}
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
  it("pi 会话:slash 菜单含 /skill:<name> + argHint + 描述(R3/R4)", async () => {
    renderComposer("pi", fakeBridge([sk("agent-browser", "<url>")]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    await waitFor(() => expect(screen.getByText("/skill:agent-browser")).toBeTruthy());
    expect(screen.getByText("<url>")).toBeTruthy();
    expect(screen.getByText("agent-browser 描述")).toBeTruthy();
    // 内建命令仍在。
    expect(screen.getByText("/clear")).toBeTruthy();
  });

  it("claude 会话:菜单只含内建,不含 skills(R6)", async () => {
    renderComposer("claude", fakeBridge([sk("agent-browser")]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    expect(await screen.findByText("/clear")).toBeTruthy();
    // 给异步 query 一拍,确认 skills 始终不出现。
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("/skill:agent-browser")).toBeNull();
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
    await waitFor(() => expect(screen.getByText("/skill:code-review")).toBeTruthy());
    expect(screen.queryByText("/skill:agent-browser")).toBeNull();
  });

  it("pi 会话:无 piSkillsList(web/旧壳)→ 仅内建,无报错(R7)", async () => {
    renderComposer("pi", {} as unknown as DesktopBridge);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    expect(await screen.findByText("/clear")).toBeTruthy();
    expect(screen.getByText("/compact")).toBeTruthy(); // pi 内建仍在
    expect(screen.queryByText(/\/skill:/)).toBeNull();
  });
});
