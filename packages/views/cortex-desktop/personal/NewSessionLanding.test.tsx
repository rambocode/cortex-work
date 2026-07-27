import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, DEFAULT_MODEL, usePersonalStore } from "@cortex-work/core";
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
    expect(container.querySelector(".pw-mt-trigger")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
    expect(screen.getByTitle("发送 (Enter)")).toBeInTheDocument();
    // 复用内核根节点,不再有双层 composer-wrap。
    expect(container.querySelectorAll(".composer-wrap")).toHaveLength(1);
    expect(container.querySelector(".pw-landing-composer")).not.toBeNull();
  });

  it("落地页 slash(修复):输入 / 显示内建命令(之前落地页 slashCommands 为空、无提示)", async () => {
    renderLanding(fakeBridge());
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "/" } });
    expect(await screen.findByText("/clear")).toBeTruthy();
  });

  it("落地页 slash 默认提供第一方「设计稿」与「演示文稿」Skill", async () => {
    renderLanding(fakeBridge());
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "/" } });
    // 展示名走中文(与输入框 skill pill 一致)。按 option 角色取,避免与落地页场景 chip 的同名按钮撞名。
    expect(await screen.findByRole("option", { name: /设计稿/ })).toBeTruthy();
    expect(await screen.findByRole("option", { name: /演示文稿/ })).toBeTruthy();
  });

  it("从落地页调用 Design Skill 时先创建会话产物再发送", async () => {
    const artifact = {
      kind: "design" as const,
      documentId: "design-1",
      title: "Dashboard",
      workspaceRoot: "/docs/cortex/design",
      entryPath: "/docs/cortex/design/.cortex-design/design-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const artifactCreate = vi.fn(async () => ({ ok: true as const, artifact }));
    renderLanding(fakeBridge({
      artifactCreate,
      skillGet: async () => ({
        name: "design",
        description: "创建设计",
        dir: "/builtin/design",
        skillMdPath: "/builtin/design/SKILL.md",
      }),
    }));
    const input = screen.getByPlaceholderText(/开启新会话/);
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /设计稿/ }));
    fireEvent.change(input, { target: { value: "Dashboard" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await waitFor(() =>
      expect(artifactCreate).toHaveBeenCalledWith({
        kind: "design",
        title: "Dashboard",
      }),
    );
    const createdSession = usePersonalStore.getState().sessions.find((item) => item.id !== "s1");
    expect(createdSession?.activeArtifact).toEqual(artifact);
    expect(createdSession?.artifacts).toEqual([artifact]);
    expect(sendSpy.mock.calls.at(-1)?.[10]).toEqual(artifact);
  });

  it("落地页 slash:Skills 默认开 → 输入 / 直接显示已启用 skill(Title-Case 名)", async () => {
    const piSkillsList = vi.fn(async () => [
      { name: "image-gen", description: "生成图片", dir: "/g/image-gen", rootPath: "/g", scope: "global", enabled: true, trusted: true, docs: [] },
    ]);
    renderLanding(fakeBridge({ piSkillsList } as unknown as Partial<DesktopBridge>));
    // useOwnSkills 默认打开,无需先点 Skills 开关。
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "/" } });
    expect(await screen.findByText("Image Gen")).toBeTruthy();
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

  it("改 model(合并 pill 下钻模型层)后发送:新会话沿用所选 model", async () => {
    const { container } = renderLanding(fakeBridge());
    // 打开合并 pill → 下钻到模型层 → 选 Opus。
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.click(container.querySelector('.pw-mt-menu button[aria-haspopup="menu"]')!);
    const opus = [...container.querySelectorAll(".pw-mt-models .pw-tb-menu-item")].find((b) =>
      b.textContent?.includes("Opus"),
    )!;
    fireEvent.click(opus);
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "ship it" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();

    const created = usePersonalStore.getState().sessions.find((s) => s.id !== "s1")!;
    expect(created.model).toBe("opus");
  });

  it("改思考强度(合并 pill)后发送:新会话沿用所选 effort", async () => {
    const { container } = renderLanding(fakeBridge());
    // 打开合并 pill → 点推理「高」。
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    const high = [...container.querySelectorAll(".pw-mt-menu .pw-tb-menu-item")].find(
      (b) => b.textContent?.trim() === "高",
    )!;
    fireEvent.click(high);
    fireEvent.change(screen.getByPlaceholderText(/开启新会话/), { target: { value: "think harder" } });
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await Promise.resolve();

    const created = usePersonalStore.getState().sessions.find((s) => s.id !== "s1")!;
    expect(created.effort).toBe("high");
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, effort: "high" }),
      "/docs/cortex/2026-06-17",
      "think harder",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("pi 默认 + 有 provider 但 defaultProviderId 未设:草稿回退第一个已启用 provider(不显示未配置)", () => {
    usePersonalStore.setState({
      agentsAvailable: {}, // 无 claude/codex → 默认 agent 回退 pi
      providerSettings: {
        defaultProviderId: undefined,
        defaultModel: undefined,
        providers: [{ id: "prov1", name: "供应商一", enabled: true, models: [{ id: "m1", label: "M1" }] }],
      } as never,
    });
    const { container } = renderLanding(fakeBridge());
    const trigger = container.querySelector(".pw-mt-trigger")!;
    // 回退到第一个已启用 provider 的模型 → 不应显示「未配置供应商」。
    expect(trigger.textContent).not.toContain("未配置");
    expect(trigger.textContent).toContain("M1");
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
    // 断言跟随 DEFAULT_MODEL 单一数据源,避免 codex 默认模型升级时测试再次过期。
    expect(created.model).toBe(DEFAULT_MODEL.codex);
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
