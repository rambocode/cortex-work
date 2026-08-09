import { describe, expect, it } from "vitest";
import type { PersistedState, ProjectMeta, PushSettings, SessionMeta } from "../desktop/types";
import { DEFAULT_GENERAL_SETTINGS, DEFAULT_PI_SKILLS, defaultMediaGenSettings, defaultAsrSettings, defaultVoiceSettings, MAX_TIMEOUT_MS_BY_MODALITY } from "../desktop/types";
import { usePersonalStore, toPersistedState, partitionProjects, defaultAgent } from "./personal";

const base: PersistedState = { version: 1, projects: [], sessions: [] };

describe("通用设置默认值", () => {
  it("子代理能力不再使用人工开关，并提供 Kun 对齐的运行护栏默认值", () => {
    expect(DEFAULT_GENERAL_SETTINGS.subagentOrchestration).toBeUndefined();
    expect(DEFAULT_GENERAL_SETTINGS.subagents).toMatchObject({ maxParallel: 256, maxChildRuns: 25 });

    usePersonalStore.getState().hydrate(base);

    expect(usePersonalStore.getState().generalSettings.subagentOrchestration).toBeUndefined();
    expect(usePersonalStore.getState().generalSettings.subagents).toMatchObject({ maxParallel: 256, maxChildRuns: 25 });
  });

  it("hydrate 剥离旧人工开关，并为旧版子代理目录补齐运行护栏", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        subagentOrchestration: false,
        subagents: { useExistingAgents: false, extensionAgentsEnabled: false, profiles: {} } as never,
      },
    });

    expect(usePersonalStore.getState().generalSettings.subagentOrchestration).toBeUndefined();
    expect(usePersonalStore.getState().generalSettings.subagents).toMatchObject({
      useExistingAgents: false,
      maxParallel: 256,
      maxChildRuns: 25,
    });
  });
});

describe("会话重命名", () => {
  const session: SessionMeta = {
    id: "s1",
    title: "Session 1",
    agent: "claude",
    createdAt: 1,
    updatedAt: 10,
  };

  it("去除首尾空格并持久化名称,但不刷新最近活动时间", () => {
    usePersonalStore.getState().hydrate({ ...base, sessions: [session] });

    usePersonalStore.getState().renameSession(session.id, "  新名称  ");

    const renamed = usePersonalStore.getState().sessions[0]!;
    expect(renamed.title).toBe("新名称");
    expect(renamed.updatedAt).toBe(10);
    expect(renamed.titleManuallyEdited).toBe(true);
    expect(toPersistedState(usePersonalStore.getState()).sessions[0]).toEqual(renamed);
  });

  it("空名称或规范化后未变化时保持原会话对象不变", () => {
    usePersonalStore.getState().hydrate({ ...base, sessions: [session] });
    const before = usePersonalStore.getState().sessions[0];

    usePersonalStore.getState().renameSession(session.id, "   ");
    usePersonalStore.getState().renameSession(session.id, " Session 1 ");

    expect(usePersonalStore.getState().sessions[0]).toBe(before);
  });
});

describe("会话目标持久态", () => {
  const session: SessionMeta = {
    id: "goal-session",
    title: "Goal",
    agent: "pi",
    createdAt: 1,
    updatedAt: 1,
  };

  it("创建、暂停、恢复和清除都写回同一个 SessionMeta.goal", () => {
    usePersonalStore.getState().hydrate({ ...base, sessions: [session] });

    const created = usePersonalStore.getState().setSessionGoal(session.id, "  完成目标模式  ");
    expect(created).toMatchObject({
      threadId: session.id,
      objective: "完成目标模式",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
    });
    expect(toPersistedState(usePersonalStore.getState()).sessions[0]?.goal).toEqual(created);

    usePersonalStore.getState().setSessionGoalStatus(session.id, "paused");
    expect(usePersonalStore.getState().sessions[0]?.goal?.status).toBe("paused");

    usePersonalStore.getState().setSessionGoalStatus(session.id, "active");
    expect(usePersonalStore.getState().sessions[0]?.goal).toMatchObject({ status: "active", autoTurnCount: 0 });

    usePersonalStore.getState().clearSessionGoal(session.id);
    expect(usePersonalStore.getState().sessions[0]?.goal).toBeUndefined();
  });
});

describe("pi 扩展市场 store（U2）", () => {
  const rec = (ref: string, scope: "global" | "workspace" = "global") => ({
    ref,
    scope,
    sourceRef: ref,
    origin: ref.split(":")[0] ?? "npm",
    version: "1.0.0",
    installedAt: 1,
    path: `/ext/${ref.replace(/[:/@]/g, "_")}`,
  });

  it("hydrate 在 generalSettings 存在但缺 piExtensions 时兜 DEFAULT_PI_EXTENSIONS", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: { ...DEFAULT_GENERAL_SETTINGS },
    });
    expect(usePersonalStore.getState().generalSettings.piExtensions).toEqual({
      installed: [],
      enabled: [],
      trusted: [],
    });
  });

  it("recordInstalledExtension 持久溯源 + 同 scope:ref upsert", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().recordInstalledExtension(rec("npm:foo"));
    usePersonalStore.getState().recordInstalledExtension({ ...rec("npm:foo"), version: "2.0.0" });
    const ext = usePersonalStore.getState().generalSettings.piExtensions!;
    expect(ext.installed).toHaveLength(1);
    expect(ext.installed[0]?.version).toBe("2.0.0");
  });

  it("toggleExtension 默认禁用、opt-in 启用，按 ${scope}:${ref} 键", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().toggleExtension("global", "npm:foo", true);
    expect(usePersonalStore.getState().generalSettings.piExtensions!.enabled).toEqual(["global:npm:foo"]);
    usePersonalStore.getState().toggleExtension("global", "npm:foo", false);
    expect(usePersonalStore.getState().generalSettings.piExtensions!.enabled).toEqual([]);
  });

  it("复合键隔离：npm:foo 与 git:foo 互不影响", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().toggleExtension("global", "npm:foo", true);
    usePersonalStore.getState().trustExtension("global", "git:foo", true);
    const ext = usePersonalStore.getState().generalSettings.piExtensions!;
    expect(ext.enabled).toEqual(["global:npm:foo"]);
    expect(ext.trusted).toEqual(["global:git:foo"]);
  });

  it("removeInstalledExtension 级联清溯源 + 启用 + 信任", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().recordInstalledExtension(rec("npm:foo"));
    usePersonalStore.getState().toggleExtension("global", "npm:foo", true);
    usePersonalStore.getState().trustExtension("global", "npm:foo", true);
    usePersonalStore.getState().removeInstalledExtension("global", "npm:foo");
    const ext = usePersonalStore.getState().generalSettings.piExtensions!;
    expect(ext.installed).toEqual([]);
    expect(ext.enabled).toEqual([]);
    expect(ext.trusted).toEqual([]);
  });
});

describe("派生 agent store（U7）", () => {
  it("setDerivedAgents 写入并可读、可清空", () => {
    usePersonalStore.getState().setDerivedAgents([{ id: "my-codex", base: "codex", label: "My Codex" }]);
    expect(usePersonalStore.getState().derivedAgents).toEqual([{ id: "my-codex", base: "codex", label: "My Codex" }]);
    usePersonalStore.getState().setDerivedAgents([]);
    expect(usePersonalStore.getState().derivedAgents).toEqual([]);
  });
});

function proj(patch: Partial<ProjectMeta> & Pick<ProjectMeta, "id">): ProjectMeta {
  return { name: patch.id, path: `/code/${patch.id}`, addedAt: 1, ...patch };
}

describe("插件市场启停/信任 store（U5）", () => {
  it("hydrate 缺 plugins 时兜 DEFAULT_PLUGIN_ENABLE", () => {
    usePersonalStore.getState().hydrate({ ...base, generalSettings: { ...DEFAULT_GENERAL_SETTINGS } });
    expect(usePersonalStore.getState().generalSettings.plugins).toEqual({ enabled: [], distrusted: [] });
  });

  it("togglePlugin 默认未启用、opt-in 启用，按插件 id", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().togglePlugin("build-web-apps", true);
    expect(usePersonalStore.getState().generalSettings.plugins!.enabled).toEqual(["build-web-apps"]);
    usePersonalStore.getState().togglePlugin("build-web-apps", false);
    expect(usePersonalStore.getState().generalSettings.plugins!.enabled).toEqual([]);
  });

  it("togglePlugin 重复启用幂等（不重复入集）", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().togglePlugin("pdf", true);
    usePersonalStore.getState().togglePlugin("pdf", true);
    expect(usePersonalStore.getState().generalSettings.plugins!.enabled).toEqual(["pdf"]);
  });

  it("setPluginTrusted 默认已授信，仅记显式撤信；恢复信任移出 distrusted", () => {
    usePersonalStore.getState().hydrate({ ...base, generalSettings: { ...DEFAULT_GENERAL_SETTINGS } });
    expect(usePersonalStore.getState().generalSettings.plugins!.distrusted).toEqual([]);
    usePersonalStore.getState().setPluginTrusted("evil", false);
    expect(usePersonalStore.getState().generalSettings.plugins!.distrusted).toEqual(["evil"]);
    usePersonalStore.getState().setPluginTrusted("evil", true);
    expect(usePersonalStore.getState().generalSettings.plugins!.distrusted).toEqual([]);
  });
});

describe("浏览器控制 store（U1）", () => {
  it("hydrate 缺 browserControl 时兜 DEFAULT_BROWSER_CONTROL", () => {
    usePersonalStore.getState().hydrate({ ...base, generalSettings: { ...DEFAULT_GENERAL_SETTINGS } });
    expect(usePersonalStore.getState().generalSettings.browserControl).toEqual({
      enabled: false,
      cdpEnabled: false,
      approvedOrigins: [],
      localUrlOpenTarget: "internal",
      annotateScreenshotMode: "ask",
      navigationApproval: "none",
    });
  });

  it("旧档仅含三字段时,新字段逐项兜默认不崩", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        browserControl: { enabled: true, cdpEnabled: false, approvedOrigins: ["https://a.com"] } as never,
      },
    });
    const bc = usePersonalStore.getState().generalSettings.browserControl!;
    expect(bc.enabled).toBe(true);
    expect(bc.localUrlOpenTarget).toBe("internal");
    expect(bc.annotateScreenshotMode).toBe("ask");
    expect(bc.navigationApproval).toBe("none"); // 旧档缺字段 → 兜新默认「全部授权」
  });

  it("setBrowserControl patch 不覆盖未传字段", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setBrowserControl({ enabled: true });
    usePersonalStore.getState().setBrowserControl({ cdpEnabled: true });
    usePersonalStore.getState().setBrowserControl({ navigationApproval: "all" });
    const bc = usePersonalStore.getState().generalSettings.browserControl!;
    expect(bc.enabled).toBe(true);
    expect(bc.cdpEnabled).toBe(true);
    expect(bc.navigationApproval).toBe("all");
    expect(bc.localUrlOpenTarget).toBe("internal"); // 未传字段保持默认
  });

  it("approvedOrigins 增删去重", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().addApprovedOrigin("https://example.com");
    usePersonalStore.getState().addApprovedOrigin("https://example.com");
    expect(usePersonalStore.getState().generalSettings.browserControl!.approvedOrigins).toEqual([
      "https://example.com",
    ]);
    usePersonalStore.getState().removeApprovedOrigin("https://example.com");
    expect(usePersonalStore.getState().generalSettings.browserControl!.approvedOrigins).toEqual([]);
  });
});

describe("hydrate 推送设置迁移", () => {
  it("旧数据（timelineSettings.push）迁移到全局 pushSettings", () => {
    const legacy = {
      ...base,
      timelineSettings: {
        summaryModel: { kind: "agent", agent: "claude", model: "haiku" },
        push: { wecom: { enabled: true, webhookUrl: "https://qyapi.weixin.qq.com/x" } },
      } as PersistedState["timelineSettings"] & { push: PushSettings },
    };
    usePersonalStore.getState().hydrate(legacy);
    expect(usePersonalStore.getState().pushSettings.wecom?.webhookUrl).toBe("https://qyapi.weixin.qq.com/x");
  });

  it("新数据 pushSettings 优先,持久化快照含两份设置", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      pushSettings: { dingtalk: { enabled: true, webhookUrl: "https://oapi.dingtalk.com/x" } },
    });
    const s = usePersonalStore.getState();
    expect(s.pushSettings.dingtalk?.enabled).toBe(true);
    const persisted = toPersistedState(s);
    expect(persisted.pushSettings).toBe(s.pushSettings);
    expect(persisted.timelineSettings).toBe(s.timelineSettings);
  });
});

describe("hydrate 通用设置（generalSettings 完整透传）", () => {
  it("保留 piCustomization（防 resolveGeneralSettings 逐字段重建丢字段回归）", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        desktopBehavior: { openAtLogin: false, startMinimized: false, closeToTray: true },
        notifications: { turnComplete: true },
        log: { enabled: true, retentionDays: 2 },
        piCustomization: { toolApproval: true, sampleTools: false, sampleCommands: false },
      },
    });
    expect(usePersonalStore.getState().generalSettings.piCustomization).toEqual({
      toolApproval: true,
      sampleTools: false,
      sampleCommands: false,
    });
  });

  it("保留 piCustomization.approvalTools 审批清单（阶段3）", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        desktopBehavior: { openAtLogin: false, startMinimized: false, closeToTray: true },
        notifications: { turnComplete: true },
        log: { enabled: true, retentionDays: 2 },
        piCustomization: { toolApproval: true, sampleTools: false, sampleCommands: false, approvalTools: ["bash", "read"] },
      },
    });
    expect(usePersonalStore.getState().generalSettings.piCustomization?.approvalTools).toEqual(["bash", "read"]);
  });

  it("保留 piThinkingDefault / piSystemPrompt 顶层新字段（阶段4/5）", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        desktopBehavior: { openAtLogin: false, startMinimized: false, closeToTray: true },
        notifications: { turnComplete: true },
        log: { enabled: true, retentionDays: 2 },
        piThinkingDefault: "high",
        piSystemPrompt: "你是助手",
      },
    });
    const g = usePersonalStore.getState().generalSettings;
    expect(g.piThinkingDefault).toBe("high");
    expect(g.piSystemPrompt).toBe("你是助手");
  });

  it("旧档无 generalSettings 时回退默认（piCustomization undefined）", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().generalSettings.piCustomization).toBeUndefined();
  });

  it("保留顶层自定义字段并以默认补全嵌套子对象", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        workspaceRoot: "/tmp/ws",
        desktopBehavior: { openAtLogin: true, startMinimized: false, closeToTray: false },
        notifications: { turnComplete: false },
        log: { enabled: false, retentionDays: 5 },
        notesHotkey: "CommandOrControl+Shift+K",
      },
    });
    const g = usePersonalStore.getState().generalSettings;
    expect(g.workspaceRoot).toBe("/tmp/ws");
    expect(g.notesHotkey).toBe("CommandOrControl+Shift+K");
    expect(g.desktopBehavior.openAtLogin).toBe(true);
    expect(g.log.retentionDays).toBe(5);
  });
});

describe("personal todos", () => {
  it("旧数据缺少 todos 时默认空列表并持久化", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().todos).toEqual([]);
    expect(toPersistedState(usePersonalStore.getState()).todos).toEqual([]);
  });

  it("创建、更新、完成、删除 todo 元数据", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 1 }],
    });

    const todo = usePersonalStore.getState().addTodo("p1", "实现续期", "/code/alpha/tasks/todo-1.md");
    expect(todo.status).toBe("open");
    expect(usePersonalStore.getState().todos).toHaveLength(1);

    usePersonalStore.getState().updateTodo(todo.id, { title: "实现 Todo 续期", status: "done" });
    expect(usePersonalStore.getState().todos[0]).toMatchObject({ title: "实现 Todo 续期", status: "done" });

    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.todos?.[0]?.detailPath).toBe("/code/alpha/tasks/todo-1.md");

    usePersonalStore.getState().removeTodo(todo.id);
    expect(usePersonalStore.getState().todos).toEqual([]);
  });

  it("删除项目时同步清理该项目 todos", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [
        { id: "p1", name: "alpha", path: "/code/alpha", addedAt: 1 },
        { id: "p2", name: "beta", path: "/code/beta", addedAt: 1 },
      ],
      todos: [
        { id: "t1", projectId: "p1", title: "A", status: "open", detailPath: "/code/alpha/tasks/t1.md", createdAt: 1, updatedAt: 1 },
        { id: "t2", projectId: "p2", title: "B", status: "open", detailPath: "/code/beta/tasks/t2.md", createdAt: 1, updatedAt: 1 },
      ],
    });

    usePersonalStore.getState().removeProject("p1");
    expect(usePersonalStore.getState().todos.map((todo) => todo.id)).toEqual(["t2"]);
  });
});

describe("文件片段发送中转（终端 / composer）", () => {
  it("sendToTerminal 暂存文本并打开终端面板,消费后清空", () => {
    const s = usePersonalStore.getState();
    if (s.terminalOpen) s.toggleTerminal();
    usePersonalStore.getState().sendToTerminal("（来自 ~/a.go 的片段）");
    expect(usePersonalStore.getState().terminalOpen).toBe(true);
    expect(usePersonalStore.getState().pendingTerminalText).toBe("（来自 ~/a.go 的片段）");

    expect(usePersonalStore.getState().consumePendingTerminalText()).toBe("（来自 ~/a.go 的片段）");
    expect(usePersonalStore.getState().pendingTerminalText).toBeUndefined();
    // 再次消费拿不到（原子,防双路触发重复写入）
    expect(usePersonalStore.getState().consumePendingTerminalText()).toBeUndefined();
  });

  it("insertToComposer 每次递增 nonce（composer 据此去重）", () => {
    usePersonalStore.getState().insertToComposer("片段A");
    const first = usePersonalStore.getState().composerInsert;
    expect(first?.text).toBe("片段A");

    usePersonalStore.getState().insertToComposer("片段B");
    const second = usePersonalStore.getState().composerInsert;
    expect(second?.text).toBe("片段B");
    expect(second!.nonce).toBe(first!.nonce + 1);
  });

  it("insertToComposer 透传 submit 标志（默认不自动提交）", () => {
    usePersonalStore.getState().insertToComposer("仅插入");
    expect(usePersonalStore.getState().composerInsert?.submit).toBeFalsy();

    usePersonalStore.getState().insertToComposer("插入并运行", { submit: true });
    expect(usePersonalStore.getState().composerInsert?.submit).toBe(true);
  });

  it("insertToComposer 透传 skill（落地页场景 chip 预置 skill pill）", () => {
    usePersonalStore.getState().insertToComposer("", { skill: { cmd: "/skill:slides", displayName: "Slides" } });
    const insert = usePersonalStore.getState().composerInsert;
    // 纯 pill 预置:文本为空,skill 原样透传给 ComposerShell 消费。
    expect(insert?.text).toBe("");
    expect(insert?.skill).toEqual({ cmd: "/skill:slides", displayName: "Slides" });

    usePersonalStore.getState().insertToComposer("无 skill");
    expect(usePersonalStore.getState().composerInsert?.skill).toBeUndefined();
  });

  it("setComposerSkill 记录/清除当前 skill pill（落地页示例区据此联动）", () => {
    usePersonalStore.getState().setComposerSkill({ cmd: "/skill:slides", displayName: "Slides" });
    expect(usePersonalStore.getState().composerSkill).toEqual({ cmd: "/skill:slides", displayName: "Slides" });

    usePersonalStore.getState().setComposerSkill(undefined);
    expect(usePersonalStore.getState().composerSkill).toBeUndefined();
  });
});

describe("GitBar 整仓 diff 请求中转", () => {
  it("requestGitDiff 记录请求并把右栏切到 files,消费后清空", () => {
    usePersonalStore.setState({ gitDiffRequest: undefined, rightView: "todos" });
    usePersonalStore.getState().requestGitDiff("p1");
    expect(usePersonalStore.getState().gitDiffRequest).toEqual({ projectId: "p1" });
    expect(usePersonalStore.getState().rightView).toBe("files");

    expect(usePersonalStore.getState().consumeGitDiffRequest()).toEqual({ projectId: "p1" });
    expect(usePersonalStore.getState().gitDiffRequest).toBeUndefined();
    // 再次消费拿不到（防 FilesView 重挂载误触发）
    expect(usePersonalStore.getState().consumeGitDiffRequest()).toBeUndefined();
  });

  it("gitDiffRequest 不进入持久化快照", () => {
    usePersonalStore.getState().requestGitDiff("p1");
    expect("gitDiffRequest" in toPersistedState(usePersonalStore.getState())).toBe(false);
    usePersonalStore.getState().consumeGitDiffRequest();
  });
});

describe("openHome 右栏联动", () => {
  it("回首页时右栏从 files 切回 todos（全部项目列表）", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setRightView("files");
    usePersonalStore.setState({ homeOpen: false });

    usePersonalStore.getState().openHome();
    expect(usePersonalStore.getState().homeOpen).toBe(true);
    expect(usePersonalStore.getState().rightView).toBe("todos");
  });
});

describe("activateProject 项目引导态", () => {
  it("激活项目并清除会话/时间线/首页状态", () => {
    usePersonalStore.setState({
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: 1 }],
      sessions: [],
      activeProjectId: undefined,
      activeSessionId: "stale-session",
      timelineProjectId: "p1",
      homeOpen: true,
    });
    usePersonalStore.getState().activateProject("p1");
    const s = usePersonalStore.getState();
    expect(s.activeProjectId).toBe("p1");
    expect(s.activeSessionId).toBeUndefined();
    expect(s.timelineProjectId).toBeUndefined();
    expect(s.homeOpen).toBe(false);
  });
});

describe("rightPanelWidth 持久化", () => {
  it("hydrate 恢复,toPersistedState 带出,setRightPanelWidth(undefined) 重置", () => {
    usePersonalStore.getState().hydrate({ ...base, rightPanelWidth: 420 });
    expect(usePersonalStore.getState().rightPanelWidth).toBe(420);

    usePersonalStore.getState().setRightPanelWidth(500);
    expect(toPersistedState(usePersonalStore.getState()).rightPanelWidth).toBe(500);

    usePersonalStore.getState().setRightPanelWidth(undefined);
    expect(usePersonalStore.getState().rightPanelWidth).toBeUndefined();
  });
});

describe("updateProject 置顶/归档元数据", () => {
  it("patch 只改目标项目,其他项目原样,数组引用被替换", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [proj({ id: "p1" }), proj({ id: "p2" })],
    });
    const before = usePersonalStore.getState().projects;

    usePersonalStore.getState().updateProject("p1", { pinnedAt: 999 });

    const after = usePersonalStore.getState().projects;
    expect(after).not.toBe(before); // 数组引用替换
    expect(after.find((p) => p.id === "p1")?.pinnedAt).toBe(999);
    // 未命中的项目对象保持原引用,且未被污染
    expect(after.find((p) => p.id === "p2")).toBe(before.find((p) => p.id === "p2"));
    expect(after.find((p) => p.id === "p2")?.pinnedAt).toBeUndefined();
  });
});

describe("archiveProject", () => {
  it("设 archivedAt、清 pinnedAt,并让出激活/时间线焦点", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [proj({ id: "p1", pinnedAt: 5 }), proj({ id: "p2" })],
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          title: "Session 1",
          agent: "claude",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    usePersonalStore.setState({
      activeProjectId: "p1",
      activeSessionId: "s1",
      timelineProjectId: "p1",
    });

    usePersonalStore.getState().archiveProject("p1");

    const s = usePersonalStore.getState();
    const archived = s.projects.find((p) => p.id === "p1");
    expect(archived?.archivedAt).toBeTypeOf("number");
    expect(archived?.pinnedAt).toBeUndefined();
    // 激活态全部让出
    expect(s.activeProjectId).toBeUndefined();
    expect(s.activeSessionId).toBeUndefined();
    expect(s.timelineProjectId).toBeUndefined();
    // 不影响其他项目
    expect(s.projects.find((p) => p.id === "p2")?.archivedAt).toBeUndefined();
  });

  it("归档非激活项目时不动当前焦点", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [proj({ id: "p1" }), proj({ id: "p2" })],
    });
    usePersonalStore.setState({ activeProjectId: "p2", timelineProjectId: "p2" });

    usePersonalStore.getState().archiveProject("p1");

    const s = usePersonalStore.getState();
    expect(s.activeProjectId).toBe("p2");
    expect(s.timelineProjectId).toBe("p2");
  });
});

describe("会话归档 / 取消归档 / 删除", () => {
  const hydrateWithSessions = () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [proj({ id: "p1" })],
      sessions: [
        { id: "s1", projectId: "p1", title: "Session 1", agent: "claude", createdAt: 1, updatedAt: 100 },
        { id: "s2", projectId: "p1", title: "Session 2", agent: "claude", createdAt: 1, updatedAt: 200 },
      ],
    });
  };

  it("archiveSession 设 archivedAt 且不刷新 updatedAt", () => {
    hydrateWithSessions();
    usePersonalStore.getState().archiveSession("s1");

    const s1 = usePersonalStore.getState().sessions.find((x) => x.id === "s1")!;
    expect(s1.archivedAt).toBeTypeOf("number");
    expect(s1.updatedAt).toBe(100); // 排序时间戳不被归档动作改动
    // 不影响其他会话
    expect(usePersonalStore.getState().sessions.find((x) => x.id === "s2")?.archivedAt).toBeUndefined();
  });

  it("归档当前激活会话时让出 activeSessionId", () => {
    hydrateWithSessions();
    usePersonalStore.setState({ activeSessionId: "s1" });
    usePersonalStore.getState().archiveSession("s1");
    expect(usePersonalStore.getState().activeSessionId).toBeUndefined();
  });

  it("归档非激活会话不动当前焦点", () => {
    hydrateWithSessions();
    usePersonalStore.setState({ activeSessionId: "s2" });
    usePersonalStore.getState().archiveSession("s1");
    expect(usePersonalStore.getState().activeSessionId).toBe("s2");
  });

  it("unarchiveSession 清 archivedAt 且不刷新 updatedAt", () => {
    hydrateWithSessions();
    usePersonalStore.getState().archiveSession("s1");
    usePersonalStore.getState().unarchiveSession("s1");

    const s1 = usePersonalStore.getState().sessions.find((x) => x.id === "s1")!;
    expect(s1.archivedAt).toBeUndefined();
    expect(s1.updatedAt).toBe(100);
  });

  it("removeSession 移除会话并清激活态", () => {
    hydrateWithSessions();
    usePersonalStore.setState({ activeSessionId: "s1" });
    usePersonalStore.getState().removeSession("s1");

    const s = usePersonalStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(["s2"]);
    expect(s.activeSessionId).toBeUndefined();
  });

  it("archivedAt 进入持久化快照", () => {
    hydrateWithSessions();
    usePersonalStore.getState().archiveSession("s1");
    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.sessions.find((x) => x.id === "s1")?.archivedAt).toBeTypeOf("number");
  });
});

describe("partitionProjects 纯函数", () => {
  it("置顶在前按 pinnedAt 降序,未置顶维持原数组序", () => {
    const projects = [
      proj({ id: "a" }),
      proj({ id: "b", pinnedAt: 100 }),
      proj({ id: "c" }),
      proj({ id: "d", pinnedAt: 200 }),
    ];
    const { visible } = partitionProjects(projects);
    // 置顶 d(200) > b(100),其后是未置顶 a、c（原序）
    expect(visible.map((p) => p.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("归档项目从可见区过滤,归档区按 archivedAt 降序", () => {
    const projects = [
      proj({ id: "a" }),
      proj({ id: "old", archivedAt: 10 }),
      proj({ id: "b", pinnedAt: 50 }),
      proj({ id: "new", archivedAt: 30 }),
    ];
    const { visible, archived } = partitionProjects(projects);
    expect(visible.map((p) => p.id)).toEqual(["b", "a"]);
    expect(archived.map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("同 pinnedAt / 同 archivedAt 显式以原数组序兜底（不依赖 sort 稳定性）", () => {
    const projects = [
      proj({ id: "p1", pinnedAt: 100 }),
      proj({ id: "p2", pinnedAt: 100 }),
      proj({ id: "p3", pinnedAt: 100 }),
      proj({ id: "ar1", archivedAt: 50 }),
      proj({ id: "ar2", archivedAt: 50 }),
      proj({ id: "ar3", archivedAt: 50 }),
    ];
    const { visible, archived } = partitionProjects(projects);
    // 置顶项 pinnedAt 全相等 → 维持原数组序 p1、p2、p3
    expect(visible.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    // 归档项 archivedAt 全相等 → 维持原数组序 ar1、ar2、ar3
    expect(archived.map((p) => p.id)).toEqual(["ar1", "ar2", "ar3"]);
  });
});

describe("defaultAgent 三态", () => {
  it("claude 可用优先 claude", () => {
    expect(defaultAgent({ claude: true, codex: true })).toBe("claude");
  });

  it("claude 不可用、codex 可用回 codex", () => {
    expect(defaultAgent({ claude: false, codex: true })).toBe("codex");
  });

  it("都不可用（或未探测）回内置 pi", () => {
    expect(defaultAgent({ claude: false, codex: false })).toBe("pi");
    expect(defaultAgent(undefined)).toBe("pi");
    expect(defaultAgent({})).toBe("pi");
  });
});

describe("providerSettings 多供应商", () => {
  type Persisted = import("../desktop/types").PersistedState;
  const provider = (
    id: string,
    over: Partial<import("../desktop/types").ProviderProfile> = {},
  ): import("../desktop/types").ProviderProfile => ({
    id,
    name: id,
    baseUrl: `https://${id}.example/v1`,
    endpointFormat: "chat_completions",
    models: [{ id: `${id}-m1` }, { id: `${id}-m2` }],
    enabled: true,
    ...over,
  });

  it("默认空 provider 注册表", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().providerSettings).toEqual({ providers: [] });
  });

  it("hydrate 旧档 piSettings.channels → providerSettings.providers（含 default / lastProviderId 迁移）", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      piSettings: {
        channels: [
          { id: "deepseek", label: "DeepSeek", baseUrl: "u1", models: [{ id: "ds-m1" }], enabled: true },
          { id: "qwen", label: "通义千问", baseUrl: "u2", models: [], enabled: false },
        ],
        defaultChannelId: "deepseek",
        defaultModel: "ds-m1",
      },
      lastPiChannelId: "deepseek",
    } as unknown as Persisted);
    const s = usePersonalStore.getState();
    expect(s.providerSettings.providers.map((p) => p.id)).toEqual(["deepseek", "qwen"]);
    // label→name,补默认 endpointFormat。
    expect(s.providerSettings.providers[0]).toMatchObject({ name: "DeepSeek", endpointFormat: "chat_completions" });
    expect(s.providerSettings.providers[1]?.enabled).toBe(false);
    expect(s.providerSettings.defaultProviderId).toBe("deepseek");
    expect(s.providerSettings.defaultModel).toBe("ds-m1");
    expect(s.lastProviderId).toBe("deepseek");
  });

  it("hydrate 旧会话 piChannelId → providerId（剥离旧名）", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      sessions: [{ id: "s1", title: "T", agent: "pi", piChannelId: "qwen", createdAt: 1, updatedAt: 1 }],
    } as unknown as Persisted);
    const sess = usePersonalStore.getState().sessions[0]!;
    expect(sess.providerId).toBe("qwen");
    expect((sess as unknown as Record<string, unknown>).piChannelId).toBeUndefined();
  });

  // `opus` 别名档已下线,旧会话必须就地改写成 1M 档 —— 否则 UI 回落显示 Sonnet、CLI 仍跑 opus。
  it("hydrate:claude 会话的旧 model \"opus\" → claude-opus-5[1m]", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      sessions: [{ id: "s1", title: "T", agent: "claude", model: "opus", createdAt: 1, updatedAt: 1 }],
    } as unknown as Persisted);
    expect(usePersonalStore.getState().sessions[0]!.model).toBe("claude-opus-5[1m]");
  });

  it("hydrate:非 claude 会话 / 其它模型值不受 opus 迁移影响", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      sessions: [
        // pi 的模型值来自用户自配 provider,同名也不该被改写。
        { id: "s1", title: "T", agent: "pi", model: "opus", createdAt: 1, updatedAt: 1 },
        { id: "s2", title: "T", agent: "claude", model: "sonnet", createdAt: 1, updatedAt: 1 },
      ],
    } as unknown as Persisted);
    const [a, b] = usePersonalStore.getState().sessions;
    expect(a!.model).toBe("opus");
    expect(b!.model).toBe("sonnet");
  });

  it("hydrate 旧单 provider 结构（无 channels）→ 空注册表", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      piSettings: { provider: "openai", model: "x", apiKey: "sk" },
    } as unknown as Persisted);
    expect(usePersonalStore.getState().providerSettings).toEqual({ providers: [] });
  });

  it("addProvider / updateProvider / removeProvider 与默认 provider 联动", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().addProvider(provider("deepseek"));
    usePersonalStore.getState().addProvider(provider("qwen"));
    expect(usePersonalStore.getState().providerSettings.providers.map((p) => p.id)).toEqual(["deepseek", "qwen"]);

    usePersonalStore.getState().updateProvider("deepseek", { apiKey: "sk-ds", enabled: false });
    const ds = usePersonalStore.getState().providerSettings.providers.find((p) => p.id === "deepseek")!;
    expect(ds.apiKey).toBe("sk-ds");
    expect(ds.enabled).toBe(false);
    // 其他 provider 不受影响。
    expect(
      usePersonalStore.getState().providerSettings.providers.find((p) => p.id === "qwen")!.apiKey,
    ).toBeUndefined();

    // 设默认 provider 后删除它 → 默认指向一并清空。
    usePersonalStore.getState().setProviderDefaults({ defaultProviderId: "deepseek", defaultModel: "deepseek-m1" });
    usePersonalStore.getState().removeProvider("deepseek");
    const s = usePersonalStore.getState();
    expect(s.providerSettings.providers.map((p) => p.id)).toEqual(["qwen"]);
    expect(s.providerSettings.defaultProviderId).toBeUndefined();
    expect(s.providerSettings.defaultModel).toBeUndefined();
  });

  it("providerSettings 进入持久化快照", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().addProvider(provider("kimi"));
    const s = usePersonalStore.getState();
    expect(toPersistedState(s).providerSettings).toBe(s.providerSettings);
  });

  it("停用当前默认 provider 时清掉默认指向（与运行时 enabled 过滤一致）", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().addProvider(provider("deepseek"));
    usePersonalStore.getState().setProviderDefaults({ defaultProviderId: "deepseek", defaultModel: "deepseek-m1" });
    usePersonalStore.getState().updateProvider("deepseek", { enabled: false });
    const s = usePersonalStore.getState();
    expect(s.providerSettings.defaultProviderId).toBeUndefined();
    expect(s.providerSettings.defaultModel).toBeUndefined();
  });
});

describe("generalSettings 通用设置", () => {
  it("旧存档默认启用内置 agent-browser", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().generalSettings.agentBrowser).toEqual({ enabled: true });
  });

  it("hydrate 把旧 agent-browser mcp 配置迁移为内置能力", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        mcp: {
          enabled: true,
          servers: [
            { id: "agent-browser", transport: "stdio", command: "agent-browser", args: ["mcp"] },
            { id: "fs", transport: "stdio", command: "/bin/fs" },
          ],
        },
      },
    });

    expect(usePersonalStore.getState().generalSettings.mcp?.servers).toEqual([
      { id: "fs", transport: "stdio", command: "/bin/fs" },
    ]);
  });

  type Persisted = import("../desktop/types").PersistedState;

  it("默认值（closeToTray 默认 true 保留现有关窗隐藏行为）", () => {
    usePersonalStore.getState().hydrate(base);
    const g = usePersonalStore.getState().generalSettings;
    expect(g.desktopBehavior.closeToTray).toBe(true);
    expect(g.desktopBehavior.openAtLogin).toBe(false);
    expect(g.notifications.turnComplete).toBe(true);
    expect(g.log.retentionDays).toBe(2);
  });

  it("hydrate 旧档缺嵌套字段以默认逐层补全", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: { desktopBehavior: { openAtLogin: true } },
    } as unknown as Persisted);
    const g = usePersonalStore.getState().generalSettings;
    expect(g.desktopBehavior.openAtLogin).toBe(true);
    expect(g.desktopBehavior.closeToTray).toBe(true); // 缺字段补默认
    expect(g.log.enabled).toBe(true);
    expect(g.notifications.turnComplete).toBe(true);
  });

  it("setGeneralSettings 改 workspaceRoot 并进入持久化快照", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setGeneralSettings({ workspaceRoot: "/tmp/ws" });
    const s = usePersonalStore.getState();
    expect(s.generalSettings.workspaceRoot).toBe("/tmp/ws");
    expect(toPersistedState(s).generalSettings).toBe(s.generalSettings);
  });

  it("默认 notesHotkey 缺省(undefined),由主进程回退默认常量", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().generalSettings.notesHotkey).toBeUndefined();
  });

  it("setGeneralSettings({notesHotkey}) 生效并进入持久化快照", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setGeneralSettings({ notesHotkey: "Cmd+Alt+Space" });
    const s = usePersonalStore.getState();
    expect(s.generalSettings.notesHotkey).toBe("Cmd+Alt+Space");
    expect(toPersistedState(s).generalSettings?.notesHotkey).toBe("Cmd+Alt+Space");
  });

  it("hydrate 往返保留 notesHotkey;旧档缺嵌套字段补全时不丢 notesHotkey", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: { desktopBehavior: { openAtLogin: true }, notesHotkey: "Control+Shift+F5" },
    } as unknown as Persisted);
    const g = usePersonalStore.getState().generalSettings;
    expect(g.notesHotkey).toBe("Control+Shift+F5");
    // 缺字段仍以默认补全。
    expect(g.desktopBehavior.closeToTray).toBe(true);

    // round-trip:把快照再 hydrate 回去,notesHotkey 一致。
    const persisted = toPersistedState(usePersonalStore.getState());
    usePersonalStore.getState().hydrate({ ...persisted });
    expect(usePersonalStore.getState().generalSettings.notesHotkey).toBe("Control+Shift+F5");
  });
});

describe("setAgentsAvailable 不持久化", () => {
  it("写入探测结果但不进 toPersistedState 快照", () => {
    usePersonalStore.getState().setAgentsAvailable({ claude: true, codex: false });
    expect(usePersonalStore.getState().agentsAvailable).toEqual({ claude: true, codex: false });
    expect("agentsAvailable" in toPersistedState(usePersonalStore.getState())).toBe(false);
  });
});

describe("个人资料 profile (昵称 + 头像)", () => {
  it("默认空对象;旧存档缺 profile 字段时回退空对象且不抛错", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().profile).toEqual({});
  });

  it("setProfile 浅合并:只改昵称不影响已有头像,反之亦然", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setProfile({ nickname: "阿伟" });
    expect(usePersonalStore.getState().profile).toEqual({ nickname: "阿伟" });

    usePersonalStore.getState().setProfile({ avatarMode: "emoji", avatarEmoji: "🦊", avatarBg: "#EDE9FE" });
    expect(usePersonalStore.getState().profile).toEqual({
      nickname: "阿伟",
      avatarMode: "emoji",
      avatarEmoji: "🦊",
      avatarBg: "#EDE9FE",
    });

    usePersonalStore.getState().setProfile({ nickname: "小明" });
    expect(usePersonalStore.getState().profile).toEqual({
      nickname: "小明",
      avatarMode: "emoji",
      avatarEmoji: "🦊",
      avatarBg: "#EDE9FE",
    });
  });

  it("hydrate 旧存档 avatarId 自动迁移为 emoji 头像,不再保留 avatarId", () => {
    usePersonalStore.getState().hydrate({ ...base, profile: { nickname: "测试", avatarId: "cat" } });
    expect(usePersonalStore.getState().profile).toEqual({
      nickname: "测试",
      avatarMode: "emoji",
      avatarEmoji: "🐱",
    });
  });

  it("hydrate 恢复 profile,toPersistedState round-trip 一致", () => {
    const profile = { nickname: "测试", avatarMode: "emoji" as const, avatarEmoji: "🐼", avatarBg: "#22c55e" };
    usePersonalStore.getState().hydrate({ ...base, profile });
    expect(usePersonalStore.getState().profile).toEqual(profile);

    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.profile).toEqual(profile);

    // round-trip:把快照再 hydrate 回去,结果一致。
    usePersonalStore.getState().hydrate({ version: 1, projects: [], sessions: [], profile: persisted.profile });
    expect(usePersonalStore.getState().profile).toEqual(profile);
  });

  it("hydrate 旧存档 pastel 背景色 → 升级为同索引饱和色(migrateProfile)", () => {
    usePersonalStore.getState().hydrate({ ...base, profile: { nickname: "测试", avatarBg: "#DCFCE7" } });
    expect(usePersonalStore.getState().profile?.avatarBg).toBe("#22c55e");
  });
});

describe("lastActiveProjectId 最近活跃项目持久化（浮层默认归属）", () => {
  const hydrateWithProjectsAndSessions = () => {
    usePersonalStore.getState().hydrate({
      ...base,
      projects: [proj({ id: "A" }), proj({ id: "B" })],
      sessions: [
        { id: "sA", projectId: "A", title: "Session A", agent: "claude", createdAt: 1, updatedAt: 1 },
        // 无项目会话（projectId 缺省）。
        { id: "sNo", title: "Session NoProj", agent: "claude", createdAt: 1, updatedAt: 1 },
      ],
    });
  };

  it("setActiveSession 到项目 A 的会话 → lastActiveProjectId=A 并进 toPersistedState", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().setActiveSession("sA");
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
    expect(toPersistedState(usePersonalStore.getState()).lastActiveProjectId).toBe("A");
  });

  it("切到无项目会话不覆盖为 undefined（保留上一个有效项目 A）", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().setActiveSession("sA");
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
    usePersonalStore.getState().setActiveSession("sNo");
    // 无项目会话不应清空 lastActiveProjectId。
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
  });

  it("activateProject 写入 lastActiveProjectId", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().activateProject("B");
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("B");
  });

  it("removeProject(A) 后 lastActiveProjectId 不再是 A", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().setActiveSession("sA");
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
    usePersonalStore.getState().removeProject("A");
    expect(usePersonalStore.getState().lastActiveProjectId).toBeUndefined();
  });

  it("removeProject(其它项目) 不清空 lastActiveProjectId", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().activateProject("A");
    usePersonalStore.getState().removeProject("B");
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
  });

  it("archiveProject(A) 后 lastActiveProjectId 不再是 A", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().setActiveSession("sA");
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
    usePersonalStore.getState().archiveProject("A");
    expect(usePersonalStore.getState().lastActiveProjectId).toBeUndefined();
  });

  it("archiveProject(其它项目) 不清空 lastActiveProjectId", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().activateProject("A");
    usePersonalStore.getState().archiveProject("B");
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
  });

  it("hydrate(toPersistedState(state)) 往返保留 lastActiveProjectId", () => {
    hydrateWithProjectsAndSessions();
    usePersonalStore.getState().activateProject("A");
    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.lastActiveProjectId).toBe("A");

    // round-trip：把快照再 hydrate 回去，结果一致。
    usePersonalStore.getState().hydrate({ ...persisted });
    expect(usePersonalStore.getState().lastActiveProjectId).toBe("A");
  });
});

describe("filePreviewRequest 文件预览请求(消费即清)", () => {
  const req = { projectId: "p1", path: "/code/p1/src/a.ts", name: "a.ts" };

  it("requestFilePreview 存入请求并切右栏到 files", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().requestFilePreview(req);
    const s = usePersonalStore.getState();
    expect(s.filePreviewRequest).toEqual(req);
    expect(s.rightView).toBe("files");
  });

  it("consumeFilePreviewRequest 首次返回请求,之后清空", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().requestFilePreview(req);
    expect(usePersonalStore.getState().consumeFilePreviewRequest()).toEqual(req);
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
    // 二次消费返回 undefined（消费即清不重复触发）。
    expect(usePersonalStore.getState().consumeFilePreviewRequest()).toBeUndefined();
  });

  it("瞬态:不进 toPersistedState 快照", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().requestFilePreview(req);
    expect("filePreviewRequest" in toPersistedState(usePersonalStore.getState())).toBe(false);
  });
});

describe("noteDetailRequest 闪记详情请求(消费即清)", () => {
  const req = { noteId: "note-1" };

  it("requestNoteDetail 存入请求并切右栏到 notes", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.setState({ rightView: "todos", noteDetailRequest: undefined });
    usePersonalStore.getState().requestNoteDetail(req);
    const s = usePersonalStore.getState();
    expect(s.noteDetailRequest).toEqual(req);
    expect(s.rightView).toBe("notes");
  });

  it("consumeNoteDetailRequest 首次返回请求,之后清空", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().requestNoteDetail(req);
    expect(usePersonalStore.getState().consumeNoteDetailRequest()).toEqual(req);
    expect(usePersonalStore.getState().noteDetailRequest).toBeUndefined();
    // 二次消费返回 undefined（消费即清不重复触发）。
    expect(usePersonalStore.getState().consumeNoteDetailRequest()).toBeUndefined();
  });

  it("瞬态:不进 toPersistedState 快照", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().requestNoteDetail(req);
    expect("noteDetailRequest" in toPersistedState(usePersonalStore.getState())).toBe(false);
  });

  it("setRightView 可切到 notes", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setRightView("notes");
    expect(usePersonalStore.getState().rightView).toBe("notes");
  });
});

describe("闪记中心区写作面视图态(noteEditorId)", () => {
  it("openNoteEditor 置 noteEditorId 并互斥清其它中心视图", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.setState({ homeOpen: true, automationOpen: true, timelineProjectId: "p1" });
    usePersonalStore.getState().openNoteEditor("n1");
    const s = usePersonalStore.getState();
    expect(s.noteEditorId).toBe("n1");
    expect(s.homeOpen).toBe(false);
    expect(s.automationOpen).toBe(false);
    expect(s.timelineProjectId).toBeUndefined();
  });

  it("closeNoteEditor 清空 noteEditorId", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().openNoteEditor("n1");
    usePersonalStore.getState().closeNoteEditor();
    expect(usePersonalStore.getState().noteEditorId).toBeUndefined();
  });

  it("切到会话/时间线/首页/自动化时清空 noteEditorId(让位)", () => {
    const seed = () => {
      usePersonalStore.getState().hydrate({
        ...base,
        sessions: [{ id: "c1", title: "会话", agent: "claude", createdAt: 1, updatedAt: 1 }],
        projects: [proj({ id: "p1" })],
      });
      usePersonalStore.getState().openNoteEditor("n1");
    };
    seed();
    usePersonalStore.getState().setActiveSession("c1");
    expect(usePersonalStore.getState().noteEditorId).toBeUndefined();

    seed();
    usePersonalStore.getState().openTimeline("p1");
    expect(usePersonalStore.getState().noteEditorId).toBeUndefined();

    seed();
    usePersonalStore.getState().openHome();
    expect(usePersonalStore.getState().noteEditorId).toBeUndefined();

    seed();
    usePersonalStore.getState().openAutomation();
    expect(usePersonalStore.getState().noteEditorId).toBeUndefined();
  });

  it("noteEditorId 不进 toPersistedState(瞬态,重启不残留)", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().openNoteEditor("n1");
    expect("noteEditorId" in toPersistedState(usePersonalStore.getState())).toBe(false);
  });
});

describe("设置整页视图态(settingsOpen)", () => {
  it("openSettings 置 settingsOpen 且不清底层视图标志(覆盖层叠加,closeSettings 后回原视图)", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.setState({ homeOpen: false, automationOpen: false, timelineProjectId: "p1", noteEditorId: "n1" });
    usePersonalStore.getState().openSettings();
    const s = usePersonalStore.getState();
    expect(s.settingsOpen).toBe(true);
    // KTD2a：openSettings 不清底层标志,故关闭设置后回到原视图。
    expect(s.timelineProjectId).toBe("p1");
    expect(s.noteEditorId).toBe("n1");
  });

  it("closeSettings 清空 settingsOpen", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().openSettings();
    usePersonalStore.getState().closeSettings();
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
  });

  it("切到会话/项目/时间线/首页/自动化/闪记或新建会话时清空 settingsOpen(让位)", () => {
    const seed = () => {
      usePersonalStore.getState().hydrate({
        ...base,
        sessions: [{ id: "c1", title: "会话", agent: "claude", createdAt: 1, updatedAt: 1 }],
        projects: [proj({ id: "p1" })],
      });
      usePersonalStore.setState({ settingsOpen: true });
    };
    seed();
    usePersonalStore.getState().setActiveSession("c1");
    expect(usePersonalStore.getState().settingsOpen).toBe(false);

    seed();
    usePersonalStore.getState().activateProject("p1");
    expect(usePersonalStore.getState().settingsOpen).toBe(false);

    seed();
    usePersonalStore.getState().openTimeline("p1");
    expect(usePersonalStore.getState().settingsOpen).toBe(false);

    seed();
    usePersonalStore.getState().openHome();
    expect(usePersonalStore.getState().settingsOpen).toBe(false);

    seed();
    usePersonalStore.getState().openAutomation();
    expect(usePersonalStore.getState().settingsOpen).toBe(false);

    seed();
    usePersonalStore.getState().openNoteEditor("n1");
    expect(usePersonalStore.getState().settingsOpen).toBe(false);

    seed();
    usePersonalStore.getState().createSession(undefined, "claude");
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
  });

  it("settingsOpen 不进 toPersistedState(瞬态,重启不残留)", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().openSettings();
    expect("settingsOpen" in toPersistedState(usePersonalStore.getState())).toBe(false);
  });
});

describe("插件 Skill 配置（piSkills）", () => {
  it("旧档无 piSkills → hydrate 后兜 DEFAULT_PI_SKILLS", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().generalSettings.piSkills).toEqual(DEFAULT_PI_SKILLS);
  });

  it("旧档缺子字段 → 该子字段兜默认", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        piSkills: { disabledSkills: ["global:x"] } as never, // 故意缺其它子字段
      },
    });
    const pi = usePersonalStore.getState().generalSettings.piSkills!;
    expect(pi.disabledSkills).toEqual(["global:x"]);
    expect(pi.globalRoots).toEqual(DEFAULT_PI_SKILLS.globalRoots);
    expect(pi.workspaceEnabled).toBe(true);
  });

  it("持久化的过期 globalRoots 被代码默认覆盖(内置根用户不可编辑)", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: {
        ...DEFAULT_GENERAL_SETTINGS,
        // 模拟老档:旧默认根 + 用户自增根 + 一个禁用项(旧扁平 shape,故 cast 绕过新必填字段)。
        piSkills: {
          globalRoots: ["~/.agent/skills", "~/.cortex-desktop/skills"],
          userGlobalRoots: ["~/mine"],
          disabledSkills: ["global:foo"],
          trustedWorkspaceSkillDirs: [],
          workspaceEnabled: true,
        } as unknown as typeof DEFAULT_PI_SKILLS,
      },
    });
    const pi = usePersonalStore.getState().generalSettings.piSkills!;
    expect(pi.globalRoots).toEqual(DEFAULT_PI_SKILLS.globalRoots); // 强制为新默认 ~/.agents/skills
    expect(pi.userGlobalRoots).toEqual(["~/mine"]); // 用户根仍保留
    expect(pi.disabledSkills).toEqual(["global:foo"]); // 其它持久字段不动
  });

  it("togglePiSkill:禁用增复合键、再启用移除", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().togglePiSkill("global", "code-review", false);
    expect(usePersonalStore.getState().generalSettings.piSkills!.disabledSkills).toContain("global:code-review");
    usePersonalStore.getState().togglePiSkill("global", "code-review", true);
    expect(usePersonalStore.getState().generalSettings.piSkills!.disabledSkills).not.toContain("global:code-review");
  });

  it("trustWorkspaceSkill:增删授信目录", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().trustWorkspaceSkill("/proj/.cortex-desktop/skills/x", true);
    expect(usePersonalStore.getState().generalSettings.piSkills!.trustedWorkspaceSkillDirs).toContain(
      "/proj/.cortex-desktop/skills/x",
    );
    usePersonalStore.getState().trustWorkspaceSkill("/proj/.cortex-desktop/skills/x", false);
    expect(usePersonalStore.getState().generalSettings.piSkills!.trustedWorkspaceSkillDirs).toHaveLength(0);
  });

  // Design B(plan 002 U7):add/remove 按目标类别(shared / agent)。内置默认根不可删。
  it("addGlobalSkillRoot 按目标写 sharedRoots / agentRoots；内置默认根不可加/不可删", () => {
    usePersonalStore.getState().hydrate(base);
    // 加到共享
    usePersonalStore.getState().addGlobalSkillRoot("~/my/shared", "shared");
    expect(usePersonalStore.getState().generalSettings.piSkills!.sharedRoots).toContain("~/my/shared");
    // 加到 claude 私有
    usePersonalStore.getState().addGlobalSkillRoot("~/my/claude", "claude");
    expect(usePersonalStore.getState().generalSettings.piSkills!.agentRoots.claude).toContain("~/my/claude");
    // 加内置默认共享根 → 无效(不重复)
    usePersonalStore.getState().addGlobalSkillRoot("~/.cortex-desktop/skills", "shared");
    expect(
      usePersonalStore.getState().generalSettings.piSkills!.sharedRoots.filter((r) => r === "~/.cortex-desktop/skills"),
    ).toHaveLength(1);
    // 删内置默认原生根 → 无效(仍在)
    usePersonalStore.getState().removeGlobalSkillRoot("~/.claude/skills", "claude");
    expect(usePersonalStore.getState().generalSettings.piSkills!.agentRoots.claude).toContain("~/.claude/skills");
    // 删用户根 → 生效
    usePersonalStore.getState().removeGlobalSkillRoot("~/my/claude", "claude");
    expect(usePersonalStore.getState().generalSettings.piSkills!.agentRoots.claude).not.toContain("~/my/claude");
  });

  it("toPersistedState 往返保留 piSkills 子字段", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().togglePiSkill("global", "x", false);
    usePersonalStore.getState().addGlobalSkillRoot("~/extra", "shared");
    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.generalSettings!.piSkills!.disabledSkills).toContain("global:x");
    expect(persisted.generalSettings!.piSkills!.sharedRoots).toContain("~/extra");
  });
});

describe("媒体生成设置（mediaGenSettings）", () => {
  it("hydrate 缺 mediaGenSettings → 回落工厂默认值(全部 enabled:false)", () => {
    usePersonalStore.getState().hydrate(base);
    const mg = usePersonalStore.getState().mediaGenSettings;
    expect(mg).toEqual(defaultMediaGenSettings());
    expect(mg.image.enabled).toBe(false);
    expect(mg.speech.enabled).toBe(false);
    expect(mg.music.enabled).toBe(false);
    expect(mg.video.enabled).toBe(false);
  });

  it("hydrate 有 mediaGenSettings → 直接使用持久化值", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      mediaGenSettings: {
        ...defaultMediaGenSettings(),
        image: { ...defaultMediaGenSettings().image, enabled: true, apiKey: "sk-img" },
      },
    });
    expect(usePersonalStore.getState().mediaGenSettings.image.enabled).toBe(true);
    expect(usePersonalStore.getState().mediaGenSettings.image.apiKey).toBe("sk-img");
    // 其他模态不受影响
    expect(usePersonalStore.getState().mediaGenSettings.speech.enabled).toBe(false);
  });

  it("hydrate 旧档缺 quality/defaultResolution → normalize 补默认（deep-merge）", () => {
    // 模拟 quality 时代之前的旧档：image 只有旧字段集。
    const legacyImage = {
      enabled: true,
      providerId: "custom",
      protocol: "openai-images",
      baseUrl: "https://api.openai.com",
      apiKey: "",
      model: "gpt-image-1",
      defaultSize: "1024x1024",
      timeoutMs: 120_000,
    };
    usePersonalStore.getState().hydrate({
      ...base,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mediaGenSettings: { image: legacyImage } as any,
    });
    const mg = usePersonalStore.getState().mediaGenSettings;
    expect(mg.image.quality).toBe("auto");
    expect(mg.image.defaultResolution).toBe("1K");
    expect(mg.image.enabled).toBe(true);
    expect(mg.image.model).toBe("gpt-image-1");
    // 缺失的其余模态整体回落默认。
    expect(mg.video).toEqual(defaultMediaGenSettings().video);
  });

  it("hydrate 非法 providerId（不在媒体供应商目录）→ 归 custom 且保留自填字段", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      mediaGenSettings: {
        ...defaultMediaGenSettings(),
        image: {
          ...defaultMediaGenSettings().image,
          providerId: "dead-profile-id",
          baseUrl: "https://my.example.com",
          model: "m1",
        },
      },
    });
    const img = usePersonalStore.getState().mediaGenSettings.image;
    expect(img.providerId).toBe("custom");
    expect(img.baseUrl).toBe("https://my.example.com");
    expect(img.model).toBe("m1");
  });

  it("hydrate 超限数值 → 按模态钳制（timeoutMs 上限表 / pollIntervalMs 下限）", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      mediaGenSettings: {
        ...defaultMediaGenSettings(),
        image: { ...defaultMediaGenSettings().image, timeoutMs: 9_999_999 },
        video: { ...defaultMediaGenSettings().video, timeoutMs: 9_999_999, pollIntervalMs: 1 },
      },
    });
    const mg = usePersonalStore.getState().mediaGenSettings;
    expect(mg.image.timeoutMs).toBe(290_000);
    expect(mg.video.timeoutMs).toBe(1_500_000);
    expect(mg.video.pollIntervalMs).toBe(1_000);
  });

  it("setMediaGenSettings patch 单模态 enabled → 其他模态不变", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setMediaGenSettings({
      image: { ...defaultMediaGenSettings().image, enabled: true },
    });
    const mg = usePersonalStore.getState().mediaGenSettings;
    expect(mg.image.enabled).toBe(true);
    expect(mg.speech.enabled).toBe(false);
    expect(mg.music.enabled).toBe(false);
    expect(mg.video.enabled).toBe(false);
  });

  it("toPersistedState 带出 mediaGenSettings 并与 state 引用相同", () => {
    usePersonalStore.getState().hydrate(base);
    const s = usePersonalStore.getState();
    expect(toPersistedState(s).mediaGenSettings).toBe(s.mediaGenSettings);
  });

  it("工厂默认:timeoutMs 均不超过按模态钳制表上限（对齐 Kun 默认值）", () => {
    // 旧规则「全部 <300s」已被 MAX_TIMEOUT_MS_BY_MODALITY 按模态钳制取代：
    // music 默认 300s（上限 600s）、video 默认 900s（上限 1500s，仍远低于 30min 看门狗）。
    const d = defaultMediaGenSettings();
    expect(d.image.timeoutMs).toBeLessThanOrEqual(MAX_TIMEOUT_MS_BY_MODALITY.image);
    expect(d.speech.timeoutMs).toBeLessThanOrEqual(MAX_TIMEOUT_MS_BY_MODALITY.speech);
    expect(d.music.timeoutMs).toBeLessThanOrEqual(MAX_TIMEOUT_MS_BY_MODALITY.music);
    expect(d.video.timeoutMs).toBeLessThanOrEqual(MAX_TIMEOUT_MS_BY_MODALITY.video);
    expect(d.music.timeoutMs).toBe(300_000);
    expect(d.video.timeoutMs).toBe(900_000);
  });

  it("视频默认值:defaultDuration=6、defaultResolution='1080P'、pollIntervalMs=10_000", () => {
    const v = defaultMediaGenSettings().video;
    expect(v.defaultDuration).toBe(6);
    expect(v.defaultResolution).toBe("1080P");
    expect(v.pollIntervalMs).toBe(10_000);
  });
});

describe("语音识别设置（asrSettings）", () => {
  it("hydrate 缺 asrSettings → 回落工厂默认值", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().asrSettings).toEqual(defaultAsrSettings());
  });

  it("工厂默认：禁用并预选本地 SenseVoiceSmall", () => {
    const d = defaultAsrSettings();
    expect(d.enabled).toBe(false);
    expect(d.protocol).toBe("local-sensevoice");
    expect(d.language).toBe("auto");
    expect(d.localModelDownloadSource).toBe("huggingface");
    expect(d.timeoutMs).toBe(60_000);
    expect(d.model).toBe("sensevoice-small-q8");
  });

  it("setAsrSettings 切 protocol → state 正确", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setAsrSettings({ protocol: "openai-transcriptions" });
    expect(usePersonalStore.getState().asrSettings.protocol).toBe("openai-transcriptions");
    // 其他字段保持默认
    expect(usePersonalStore.getState().asrSettings.enabled).toBe(false);
  });

  it("setAsrSettings 切 localModelDownloadSource → state 正确", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setAsrSettings({ localModelDownloadSource: "hf-mirror" });
    expect(usePersonalStore.getState().asrSettings.localModelDownloadSource).toBe("hf-mirror");
  });

  it("toPersistedState 带出 asrSettings 并与 state 引用相同", () => {
    usePersonalStore.getState().hydrate(base);
    const s = usePersonalStore.getState();
    expect(toPersistedState(s).asrSettings).toBe(s.asrSettings);
  });
});

describe("统一语音交互设置（voiceSettings）", () => {
  it("hydrate 旧档时补默认值，并在全量持久化快照中保留用户修改", () => {
    const expected = { ...defaultVoiceSettings(), micDeviceId: "built-in-mic", dictationDictionary: ["Cortex"] };
    usePersonalStore.getState().hydrate({ ...base, voiceSettings: expected });

    const state = usePersonalStore.getState() as typeof usePersonalStore extends { getState: () => infer T }
      ? T & { voiceSettings?: typeof expected }
      : never;
    expect(state.voiceSettings).toEqual(expected);
    expect(toPersistedState(state).voiceSettings).toEqual(expected);
  });
});

describe("hydrate 会话权限迁移(旧 permissionMode/approvalPolicy → execPermission;dirPermission 剥离)", () => {
  // 老会话带旧字段(类型已移除,迁移读取靠 cast),构造时 as 绕过类型。
  const legacySession = (perm: string | undefined, approval: string | undefined) =>
    ({ id: "s1", title: "t", agent: "codex", createdAt: 0, updatedAt: 0, permissionMode: perm, approvalPolicy: approval } as never);

  // 被剥离的旧字段已不在 SessionMeta 类型上,用窄类型 cast 校验其确实 undefined。
  const stripped = (s: SessionMeta | undefined) =>
    s as { permissionMode?: unknown; approvalPolicy?: unknown; dirPermission?: unknown };

  it("full-auto + ask → exec=ask,且旧字段被剥离", () => {
    usePersonalStore.getState().hydrate({ ...base, sessions: [legacySession("full-auto", "ask")] });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.execPermission).toBe("ask");
    expect(stripped(s).permissionMode).toBeUndefined();
    expect(stripped(s).approvalPolicy).toBeUndefined();
    expect(stripped(s).dirPermission).toBeUndefined();
  });

  it("accept-edits + auto → exec=auto(目录语义有损丢弃)", () => {
    usePersonalStore.getState().hydrate({ ...base, sessions: [legacySession("accept-edits", undefined)] });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.execPermission).toBe("auto");
  });

  it("plan → exec=plan", () => {
    usePersonalStore.getState().hydrate({ ...base, sessions: [legacySession("plan", "ask")] });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.execPermission).toBe("plan");
  });

  it("缺省老会话(无旧字段)不迁移 → 运行时回退 auto(字段保持 undefined)", () => {
    usePersonalStore.getState().hydrate({ ...base, sessions: [legacySession(undefined, undefined)] });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.execPermission).toBeUndefined();
    expect(stripped(s).dirPermission).toBeUndefined();
  });

  it("已迁移会话(已有 execPermission)不被二次迁移覆盖", () => {
    const migrated = { id: "s1", title: "t", agent: "codex", createdAt: 0, updatedAt: 0, execPermission: "plan" } as never;
    usePersonalStore.getState().hydrate({ ...base, sessions: [migrated] });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.execPermission).toBe("plan");
  });

  it("带 dirPermission 的会话(旧双轴档)→ 字段剥离,execPermission 保留", () => {
    const withDir = { id: "s1", title: "t", agent: "codex", createdAt: 0, updatedAt: 0, execPermission: "ask", dirPermission: "workspace" } as never;
    usePersonalStore.getState().hydrate({ ...base, sessions: [withDir] });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.execPermission).toBe("ask");
    expect(stripped(s).dirPermission).toBeUndefined();
  });

  it("旧 wire 字段 + dirPermission 同存 → 双剥离,exec 由旧 wire 迁得", () => {
    const both = { id: "s1", title: "t", agent: "codex", createdAt: 0, updatedAt: 0, permissionMode: "plan", dirPermission: "sandbox" } as never;
    usePersonalStore.getState().hydrate({ ...base, sessions: [both] });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.execPermission).toBe("plan");
    expect(stripped(s).permissionMode).toBeUndefined();
    expect(stripped(s).dirPermission).toBeUndefined();
  });

  it("旧会话级 subagentOrchestration(已升为全局设置)→ 字段剥离,不迁移值", () => {
    const withOrch = { id: "s1", title: "t", agent: "codex", createdAt: 0, updatedAt: 0, subagentOrchestration: true } as never;
    usePersonalStore.getState().hydrate({ ...base, sessions: [withOrch] });
    const s = usePersonalStore.getState().sessions[0] as unknown as { subagentOrchestration?: unknown };
    expect(s?.subagentOrchestration).toBeUndefined();
  });
});

describe("piSkills per-agent 迁移（Design B, plan 002 U1）", () => {
  // hydrate 一个自定义 piSkills(cast 绕过新类型,模拟旧档/部分档),读回迁移结果。
  const hydratePiSkills = (piSkills: unknown) => {
    usePersonalStore.getState().hydrate({
      ...base,
      generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: piSkills as typeof DEFAULT_PI_SKILLS },
    });
    return usePersonalStore.getState().generalSettings.piSkills!;
  };

  it("全新档(无 piSkills)→ 三端默认原生根 + 默认共享根", () => {
    usePersonalStore.getState().hydrate({ ...base, generalSettings: { ...DEFAULT_GENERAL_SETTINGS, piSkills: undefined } });
    const s = usePersonalStore.getState().generalSettings.piSkills!;
    expect(s.agentRoots.claude).toEqual(["~/.claude/skills"]);
    expect(s.agentRoots.codex).toEqual(["~/.codex/skills"]);
    expect(s.agentRoots.pi).toEqual(["~/.pi/agent/skills"]);
    // ~/.agents/skills 为跨 agent 标准目录 → 共享默认(三端)。
    expect(s.sharedRoots).toEqual(["~/.cortex-desktop/skills", "~/.agents/skills"]);
  });

  it("旧扁平结构(globalRoots+userGlobalRoots)迁移:~/.agents/skills 与 ~/.cortex-desktop/skills→共享;自增根→共享", () => {
    const s = hydratePiSkills({
      globalRoots: ["~/.agents/skills", "~/.cortex-desktop/skills"],
      userGlobalRoots: ["~/x"],
      disabledSkills: ["global:foo"],
      trustedWorkspaceSkillDirs: ["/proj/.cortex-desktop/skills"],
      workspaceEnabled: true,
    });
    // pi 私有根仅 ~/.pi/agent/skills;~/.agents/skills 归共享。
    expect(s.agentRoots.pi).toEqual(["~/.pi/agent/skills"]);
    // 两个旧默认根都是共享默认(恒并入);用户自增 ~/x 也并入共享。
    expect(s.sharedRoots).toContain("~/.cortex-desktop/skills");
    expect(s.sharedRoots).toContain("~/.agents/skills");
    expect(s.sharedRoots).toContain("~/x");
  });

  it("旧结构里非默认 globalRoots 残留兜底并入共享(不丢)", () => {
    const s = hydratePiSkills({
      globalRoots: ["~/.agents/skills", "~/.cortex-desktop/skills", "~/weird-root"],
      userGlobalRoots: [],
      disabledSkills: [],
      trustedWorkspaceSkillDirs: [],
      workspaceEnabled: true,
    });
    expect(s.sharedRoots).toContain("~/weird-root");
  });

  it("新结构再加载幂等:保留用户自增私有/共享根,不重复默认、不叠加", () => {
    const migrated = {
      sharedRoots: ["~/.cortex-desktop/skills", "~/.agents/skills", "~/shared-extra"],
      agentRoots: { claude: ["~/.claude/skills", "~/claude-extra"], codex: ["~/.codex/skills"], pi: ["~/.pi/agent/skills"] },
      globalRoots: ["~/.agents/skills", "~/.cortex-desktop/skills"],
      userGlobalRoots: [],
      disabledSkills: [],
      trustedWorkspaceSkillDirs: [],
      workspaceEnabled: true,
    };
    const once = hydratePiSkills(migrated);
    expect(once.agentRoots.claude).toEqual(["~/.claude/skills", "~/claude-extra"]);
    expect(once.sharedRoots).toEqual(["~/.cortex-desktop/skills", "~/.agents/skills", "~/shared-extra"]);
    // 二次加载幂等:结构逐字不变
    const twice = hydratePiSkills(once);
    expect(twice.agentRoots).toEqual(once.agentRoots);
    expect(twice.sharedRoots).toEqual(once.sharedRoots);
  });

  it("只写了 sharedRoots(无 agentRoots)的档 → 仍识别为新结构,sharedRoots 不丢(哨兵修复)", () => {
    const s = hydratePiSkills({
      sharedRoots: ["~/.cortex-desktop/skills", "~/only-shared"],
      // 无 agentRoots、无旧扁平字段
      disabledSkills: [],
      trustedWorkspaceSkillDirs: [],
      workspaceEnabled: true,
    });
    expect(s.sharedRoots).toContain("~/only-shared"); // 不被当旧结构忽略
    // agentRoots 缺失 → 补回默认原生根
    expect(s.agentRoots.claude).toEqual(["~/.claude/skills"]);
  });

  it("默认原生根恒并入:新结构档缺某 agent 默认根时补回(默认变更对老档生效)", () => {
    const s = hydratePiSkills({
      sharedRoots: ["~/.cortex-desktop/skills"],
      agentRoots: { claude: ["~/only-custom"], codex: [], pi: [] }, // 缺默认根
      globalRoots: [],
      userGlobalRoots: [],
      disabledSkills: [],
      trustedWorkspaceSkillDirs: [],
      workspaceEnabled: true,
    });
    expect(s.agentRoots.claude).toEqual(["~/.claude/skills", "~/only-custom"]);
    expect(s.agentRoots.codex).toEqual(["~/.codex/skills"]);
    expect(s.agentRoots.pi).toEqual(["~/.pi/agent/skills"]);
  });

  it("disabledSkills / trustedWorkspaceSkillDirs 迁移前后逐字不变", () => {
    const s = hydratePiSkills({
      globalRoots: ["~/.agents/skills", "~/.cortex-desktop/skills"],
      userGlobalRoots: [],
      disabledSkills: ["global:a", "workspace:b"],
      trustedWorkspaceSkillDirs: ["/p/.cortex-desktop/skills"],
      workspaceEnabled: false,
    });
    expect(s.disabledSkills).toEqual(["global:a", "workspace:b"]);
    expect(s.trustedWorkspaceSkillDirs).toEqual(["/p/.cortex-desktop/skills"]);
    expect(s.workspaceEnabled).toBe(false);
  });
});

// 「项目管理」工作台已从主窗口内的全屏覆盖层（projectsOpen 视图态）迁为独立桌面窗口（U3）：
// store 不再持有该视图态，入口打开独立 BrowserWindow（desktopAPI.projectsWindow.open）。
// 故原 projectsOpen 全屏互斥断言随状态删除一并移除；openSettings 栈式语义仍由上方
// 「设置整页视图态(settingsOpen)」用例覆盖。

// 写作工作台整窗覆盖层视图态(writingOpen,U1)：与其它中心视图互斥、瞬态不持久化。
describe("写作工作台整窗视图态(writingOpen)", () => {
  it("openWriting 置 writingOpen 并互斥清空其它中心视图标志", () => {
    usePersonalStore.getState().hydrate(base);
    // 预置一批「脏」视图态,验证 openWriting 全部清空。
    usePersonalStore.setState({
      homeOpen: true,
      designOpen: true,
      automationOpen: true,
      workflowOpen: true,
      settingsOpen: true,
      noteEditorId: "n1",
      timelineProjectId: "p1",
    });
    usePersonalStore.getState().openWriting();
    const s = usePersonalStore.getState();
    expect(s.writingOpen).toBe(true);
    expect(s.homeOpen).toBe(false);
    expect(s.designOpen).toBe(false);
    expect(s.automationOpen).toBe(false);
    expect(s.workflowOpen).toBe(false);
    expect(s.settingsOpen).toBe(false);
    expect(s.noteEditorId).toBeUndefined();
    expect(s.timelineProjectId).toBeUndefined();
  });

  it("closeWriting 复位 writingOpen 并回落首页", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().openWriting();
    usePersonalStore.getState().closeWriting();
    const s = usePersonalStore.getState();
    expect(s.writingOpen).toBe(false);
    expect(s.homeOpen).toBe(true);
  });

  // 每个既有 openXxx / 切会话 / 切项目入口都必须清 writingOpen(互斥,最易漏点)。
  it("切到其它任一视图入口时清空 writingOpen(让位)", () => {
    const seed = () => {
      usePersonalStore.getState().hydrate({
        ...base,
        sessions: [{ id: "c1", title: "会话", agent: "claude", createdAt: 1, updatedAt: 1 }],
        projects: [proj({ id: "p1" })],
      });
      usePersonalStore.getState().openWriting();
      expect(usePersonalStore.getState().writingOpen).toBe(true);
    };

    seed();
    usePersonalStore.getState().openHome();
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().openDesign();
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().openAutomation();
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().openWorkflow();
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().openSettings();
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().openNoteEditor("n1");
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().openTimeline("p1");
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().setActiveSession("c1");
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().activateProject("p1");
    expect(usePersonalStore.getState().writingOpen).toBe(false);

    seed();
    usePersonalStore.getState().createSession(undefined, "claude");
    expect(usePersonalStore.getState().writingOpen).toBe(false);
  });

  it("writingOpen 不进 toPersistedState(瞬态,重启不残留 → 消掉 web 恢复白屏)", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().openWriting();
    expect("writingOpen" in toPersistedState(usePersonalStore.getState())).toBe(false);
  });
});

// 会话绑定的研究引用(/skill:research)：researchOpen 整窗覆盖层已移除,研究改走右栏面板,
// 会话与研究的关联只剩 SessionMeta.researchSessions / activeResearchSessionId 两个持久化字段。
// 本块钉住「随 sessions 整体进 toPersistedState 并可 hydrate 回来」——崩溃恢复后卡片必须还在。
describe("会话绑定的研究引用(researchSessions)", () => {
  it("researchSessions / activeResearchSessionId 随 sessions 持久化往返", () => {
    const ref = { sessionId: "r1", objective: "调研市场", createdAt: 123, projectId: "p1" };
    usePersonalStore.getState().hydrate({
      ...base,
      sessions: [
        {
          id: "c1",
          title: "会话",
          agent: "claude",
          createdAt: 1,
          updatedAt: 1,
          researchSessions: [ref],
          activeResearchSessionId: "r1",
        },
      ],
    });
    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.sessions[0]?.researchSessions).toEqual([ref]);
    expect(persisted.sessions[0]?.activeResearchSessionId).toBe("r1");

    // 二次 hydrate（模拟重启）后字段原样回来。
    usePersonalStore.getState().hydrate(persisted);
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.researchSessions).toEqual([ref]);
    expect(s?.activeResearchSessionId).toBe("r1");
  });

  it("旧存档无研究引用字段时 hydrate 不报错且字段缺省", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      sessions: [{ id: "c1", title: "会话", agent: "claude", createdAt: 1, updatedAt: 1 }],
    });
    const s = usePersonalStore.getState().sessions[0];
    expect(s?.researchSessions).toBeUndefined();
    expect(s?.activeResearchSessionId).toBeUndefined();
  });
});

describe("写作 LLM 配置 hydrate（阶段③寻址归并）", () => {
  it("旧档的明文 apiKey / baseUrl / model 被就地丢弃，不进 store、更不回写磁盘", () => {
    // 归并前的旧档形状。清掉这份明文密钥落盘点正是本次归并的目的（计划 §5）——
    // 若 hydrate 用 {...默认, ...旧档} 展开，这三个键会原样穿透并被 toPersistedState 写回。
    const legacy = {
      ...base,
      writingLlmSettings: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-PLAINTEXT-SHOULD-BE-DROPPED",
        model: "old-model",
        completionEnabled: false,
        debounceMs: 1000,
        maxTokens: 200,
      },
    } as unknown as PersistedState;

    usePersonalStore.getState().hydrate(legacy);
    const llm = usePersonalStore.getState().writingLlmSettings as unknown as Record<string, unknown>;

    // 旧键彻底消失（不是空串，是根本没有这个属性）。
    expect(llm.apiKey).toBeUndefined();
    expect(llm.baseUrl).toBeUndefined();
    expect(llm.model).toBeUndefined();
    // 新引用回落未配置：旧 baseUrl/apiKey 无法映射成 Catalog 引用，不迁移、要求用户重选。
    expect(llm.providerId).toBe("");
    expect(llm.modelId).toBe("");
    // 写作独有的行为调优保留（归并的是「用哪个模型」，不是「怎么用」）。
    expect(llm.completionEnabled).toBe(false);
    expect(llm.debounceMs).toBe(1000);
    expect(llm.maxTokens).toBe(200);

    // 落盘快照里同样不含任何明文。
    const persisted = JSON.stringify(toPersistedState(usePersonalStore.getState()));
    expect(persisted).not.toContain("sk-PLAINTEXT-SHOULD-BE-DROPPED");
    expect(persisted).not.toContain("api.example.com");
  });

  it("越界/缺失的调优值被夹取回合法区间", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      writingLlmSettings: { providerId: "p", modelId: "m", maxTokens: 9999 },
    } as unknown as PersistedState);
    const llm = usePersonalStore.getState().writingLlmSettings;
    expect(llm.providerId).toBe("p");
    expect(llm.modelId).toBe("m");
    expect(llm.maxTokens).toBe(512); // WRITING_LLM_MAX_TOKENS_MAX
    expect(llm.debounceMs).toBe(650); // 缺失 → 默认
    expect(llm.completionEnabled).toBe(true); // 缺失 → 默认
  });
});

describe("toPersistedState 白名单", () => {
  // toPersistedState 是**白名单**构造：渲染端每次全量保存都用它整份覆盖磁盘，
  // 不在白名单里的字段会被静默抹掉。主进程窄写的字段尤其危险——用户看不到任何报错，
  // 只会发现「设了默认模型，重启就没了」。这条测试按**键是否存在**断言（不看值），
  // 以后谁往 PersistedState 加字段忘了透传，这里会直接红。
  const MAIN_WRITTEN_KEYS = ["defaultModelRef", "legacyProviderSettingsCleared"] as const;

  it("主进程窄写的字段都在白名单里（键存在，不看值）", () => {
    usePersonalStore.getState().hydrate(base);
    const persisted = toPersistedState(usePersonalStore.getState());
    for (const key of MAIN_WRITTEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(persisted, key)).toBe(true);
    }
  });

  it("defaultModelRef 往返不丢：hydrate 读进来的值原样回写", () => {
    const ref = { providerId: "openai", modelId: "gpt-5.5" };
    usePersonalStore.getState().hydrate({ ...base, defaultModelRef: ref });
    expect(usePersonalStore.getState().defaultModelRef).toEqual(ref);
    expect(toPersistedState(usePersonalStore.getState()).defaultModelRef).toEqual(ref);
  });

  it("半截引用（只有一半 id）hydrate 后视为未配置——不留半截引用", () => {
    usePersonalStore.getState().hydrate({
      ...base,
      defaultModelRef: { providerId: "openai", modelId: "" },
    });
    expect(usePersonalStore.getState().defaultModelRef).toBeUndefined();
  });

  it("setDefaultModelRef 写入后随全量保存落盘", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().setDefaultModelRef({ providerId: "p", modelId: "m" });
    expect(toPersistedState(usePersonalStore.getState()).defaultModelRef).toEqual({
      providerId: "p",
      modelId: "m",
    });
  });
});
