import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";

// send 走 usePersonalActions（内部依赖 bridge spawn 管线），单测里 spy 掉只验调用契约。
const sendSpy = vi.hoisted(() => vi.fn());
vi.mock("@cortex-work/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cortex-work/core")>();
  return {
    ...actual,
    usePersonalActions: () => ({
      send: sendSpy,
      stop: vi.fn(),
      editResend: vi.fn(),
      clearView: vi.fn(),
    }),
  };
});

import { NewSessionLanding } from "./NewSessionLanding";

const NOW = 1700000000000;

// HomeBoard 数据路径 + 新会话「不使用项目」落盘所需的桥方法。
function fakeBridge(extra: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    loadTimeline: async () => ({ version: 1, backfilledAt: 1, events: [] }),
    saveTimeline: async () => {},
    loadChat: async () => [],
    listTaskFiles: async () => ({ files: [], archived: [] }),
    // 默认即「不使用项目」,发送走 ensureNoProjectDir 落到当天无项目目录。
    ensureNoProjectDir: async () => "/docs/cortex/2026-06-17",
    ...extra,
  } as unknown as DesktopBridge;
}

function renderLanding(bridge: DesktopBridge, onToast: (t: string) => void = () => {}) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <NewSessionLanding onToast={onToast} />
    </CoreProvider>,
  );
}

describe("NewSessionLanding 新会话落地页输入框", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    sendSpy.mockClear();
    usePersonalStore.setState({
      homeOpen: false,
      activeProjectId: undefined,
      activeSessionId: undefined,
      // claude 可用 → 草稿默认 agent=claude、model=DEFAULT_MODEL.claude(sonnet)。
      agentsAvailable: { claude: true },
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      // 最近活跃会话属于 p1 → latestActiveProjectId 默认选中 p1。
      sessions: [{ id: "s1", projectId: "p1", title: "Session 1", agent: "claude", createdAt: NOW, updatedAt: NOW }],
    });
  });

  it("内核控件就位:渲染 model 下拉 / Skills / 发送(补回退化版丢失的能力)", () => {
    const { container } = renderLanding(fakeBridge());
    expect(container.querySelector(".pw-model-select")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
    expect(screen.getByTitle("发送 (Enter)")).toBeInTheDocument();
    // 复用内核根节点,不再有双层 composer-wrap。
    expect(container.querySelectorAll(".composer-wrap")).toHaveLength(1);
    expect(container.querySelector(".pw-landing-composer")).not.toBeNull();
  });

  it("默认不使用项目:发送走 ensureNoProjectDir 建无项目会话", async () => {
    const ensureNoProjectDir = vi.fn(async () => "/docs/cortex/2026-06-17");
    renderLanding(fakeBridge({ ensureNoProjectDir }));
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "hello world" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureNoProjectDir).toHaveBeenCalled();
    const created = usePersonalStore.getState().sessions.find((s) => s.id !== "s1")!;
    expect(created.projectId).toBeUndefined();
    expect(created.noProjectDir).toBe("/docs/cortex/2026-06-17");
    expect(created.agent).toBe("claude");
    expect(created.model).toBe("sonnet");
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id }),
      "/docs/cortex/2026-06-17",
      "hello world",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("显式选中项目 + 发送:在项目目录下新建会话并 send(带空附件)", async () => {
    const { container } = renderLanding(fakeBridge());
    // 默认「不使用项目」,先经选择器点选 alpha 项目。
    fireEvent.click(container.querySelector(".pw-proj-picker-trigger")!);
    fireEvent.click(screen.getByText("alpha"));
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "hello world" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();

    const { sessions } = usePersonalStore.getState();
    expect(sessions).toHaveLength(2);
    const created = sessions.find((s) => s.id !== "s1")!;
    expect(created.projectId).toBe("p1");
    expect(created.agent).toBe("claude");
    expect(created.model).toBe("sonnet");
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id }),
      "/code/alpha",
      "hello world",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("改 model 下拉后发送:新会话沿用所选 model", async () => {
    const { container } = renderLanding(fakeBridge());
    fireEvent.change(container.querySelector(".pw-model-select")!, { target: { value: "opus" } });
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "ship it" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();

    const created = usePersonalStore.getState().sessions.find((s) => s.id !== "s1")!;
    expect(created.model).toBe("opus");
  });

  it("不支持 ensureNoProjectDir 的环境:提示且不建会话不 send", async () => {
    const onToast = vi.fn();
    // 默认「不使用项目」但桥缺 ensureNoProjectDir(web/旧壳)→ 拒绝并提示。
    renderLanding(fakeBridge({ ensureNoProjectDir: undefined }), onToast);
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "hi" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();

    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("不支持「不使用项目」"));
    expect(usePersonalStore.getState().sessions.filter((s) => s.id !== "s1")).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("空工作区:发送走 ensureNoProjectDir 建无项目会话", async () => {
    usePersonalStore.setState({ projects: [], sessions: [] });
    const ensureNoProjectDir = vi.fn(async () => "/docs/cortex/2026-06-14");
    renderLanding(fakeBridge({ ensureNoProjectDir }));
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "scratch" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureNoProjectDir).toHaveBeenCalled();
    const created = usePersonalStore.getState().sessions[0]!;
    expect(created.projectId).toBeUndefined();
    expect(created.noProjectDir).toBe("/docs/cortex/2026-06-14");
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id }),
      "/docs/cortex/2026-06-14",
      "scratch",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});

describe("NewSessionLanding agent 选择(U3)", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    sendSpy.mockClear();
    usePersonalStore.setState({
      homeOpen: false,
      activeProjectId: undefined,
      activeSessionId: undefined,
      agentsAvailable: { claude: true, codex: true },
      derivedAgents: [{ id: "my-cx", base: "codex", label: "我的CX" }],
      projects: [],
      sessions: [],
    });
  });

  it("落地页渲染 agent 选择器(opt-in)", () => {
    const { container } = renderLanding(fakeBridge());
    expect(container.querySelector(".pw-sh-agent")).not.toBeNull();
  });

  it("选内置 codex → 新会话 agent=codex、model=codex 默认、无 derivedAgentId", async () => {
    renderLanding(fakeBridge());
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Codex$/ }));
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "go" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();
    await Promise.resolve();

    const created = usePersonalStore.getState().sessions[0]!;
    expect(created.agent).toBe("codex");
    expect(created.model).toBe("gpt-5.5");
    expect(created.derivedAgentId).toBeUndefined();
  });

  it("选派生 my-cx → 新会话 agent=base(codex) + derivedAgentId=my-cx", async () => {
    renderLanding(fakeBridge());
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /我的CX/ }));
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "go" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();
    await Promise.resolve();

    const created = usePersonalStore.getState().sessions[0]!;
    expect(created.agent).toBe("codex");
    expect(created.derivedAgentId).toBe("my-cx");
    // spawn 端取派生 id 发送(经 send 的会话对象携带 derivedAgentId)。
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, derivedAgentId: "my-cx" }),
      expect.any(String),
      "go",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});
