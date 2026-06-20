import { describe, expect, it } from "vitest";
import type { PersistedState, ProjectMeta, PushSettings } from "../desktop/types";
import { DEFAULT_GENERAL_SETTINGS, DEFAULT_PI_SKILLS } from "../desktop/types";
import { usePersonalStore, toPersistedState, partitionProjects, defaultAgent } from "./personal";

const base: PersistedState = { version: 1, projects: [], sessions: [] };

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

function proj(patch: Partial<ProjectMeta> & Pick<ProjectMeta, "id">): ProjectMeta {
  return { name: patch.id, path: `/code/${patch.id}`, addedAt: 1, ...patch };
}

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

    usePersonalStore.getState().setProfile({ avatarId: "fox" });
    expect(usePersonalStore.getState().profile).toEqual({ nickname: "阿伟", avatarId: "fox" });

    usePersonalStore.getState().setProfile({ nickname: "小明" });
    expect(usePersonalStore.getState().profile).toEqual({ nickname: "小明", avatarId: "fox" });
  });

  it("hydrate 恢复 profile,toPersistedState round-trip 一致", () => {
    usePersonalStore.getState().hydrate({ ...base, profile: { nickname: "测试", avatarId: "cat" } });
    expect(usePersonalStore.getState().profile).toEqual({ nickname: "测试", avatarId: "cat" });

    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.profile).toEqual({ nickname: "测试", avatarId: "cat" });

    // round-trip:把快照再 hydrate 回去,结果一致。
    usePersonalStore.getState().hydrate({ version: 1, projects: [], sessions: [], profile: persisted.profile });
    expect(usePersonalStore.getState().profile).toEqual({ nickname: "测试", avatarId: "cat" });
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
        // 模拟老档:旧默认根 + 用户自增根 + 一个禁用项。
        piSkills: {
          globalRoots: ["~/.agent/skills", "~/.cortex-desktop/skills"],
          userGlobalRoots: ["~/mine"],
          disabledSkills: ["global:foo"],
          trustedWorkspaceSkillDirs: [],
          workspaceEnabled: true,
        },
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

  it("addGlobalSkillRoot 追加 userGlobalRoots；内置根不可加/不可删", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().addGlobalSkillRoot("~/my/skills");
    expect(usePersonalStore.getState().generalSettings.piSkills!.userGlobalRoots).toContain("~/my/skills");
    // 加内置默认根 → 无效（不重复）
    usePersonalStore.getState().addGlobalSkillRoot("~/.agents/skills");
    expect(usePersonalStore.getState().generalSettings.piSkills!.userGlobalRoots).not.toContain("~/.agents/skills");
    // 删内置根 → 无效（仅删 userGlobalRoots）
    usePersonalStore.getState().removeGlobalSkillRoot("~/.agents/skills");
    expect(usePersonalStore.getState().generalSettings.piSkills!.globalRoots).toEqual(DEFAULT_PI_SKILLS.globalRoots);
    // 删用户根 → 生效
    usePersonalStore.getState().removeGlobalSkillRoot("~/my/skills");
    expect(usePersonalStore.getState().generalSettings.piSkills!.userGlobalRoots).not.toContain("~/my/skills");
  });

  it("toPersistedState 往返保留 piSkills 子字段", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().togglePiSkill("global", "x", false);
    usePersonalStore.getState().addGlobalSkillRoot("~/extra");
    const persisted = toPersistedState(usePersonalStore.getState());
    expect(persisted.generalSettings!.piSkills!.disabledSkills).toContain("global:x");
    expect(persisted.generalSettings!.piSkills!.userGlobalRoots).toContain("~/extra");
  });
});
