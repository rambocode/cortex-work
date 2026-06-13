import { describe, expect, it } from "vitest";
import type { PersistedState, ProjectMeta, PushSettings } from "../desktop/types";
import { usePersonalStore, toPersistedState, partitionProjects, defaultAgent } from "./personal";

const base: PersistedState = { version: 1, projects: [], sessions: [] };

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

describe("piSettings 多通道", () => {
  const channel = (id: string, over: Partial<import("../desktop/types").PiChannel> = {}) => ({
    id,
    label: id,
    baseUrl: `https://${id}.example/v1`,
    models: [{ id: `${id}-m1` }, { id: `${id}-m2` }],
    enabled: true,
    ...over,
  });

  it("默认空通道;旧单 provider 结构 hydrate 时被重置为空", () => {
    usePersonalStore.getState().hydrate(base);
    expect(usePersonalStore.getState().piSettings).toEqual({ channels: [] });

    // 旧结构（无 channels 数组）→ 安全回退到默认空通道。
    usePersonalStore.getState().hydrate({
      ...base,
      piSettings: { provider: "openai", model: "x", apiKey: "sk" } as unknown as import("../desktop/types").PiSettings,
    });
    expect(usePersonalStore.getState().piSettings).toEqual({ channels: [] });
  });

  it("addPiChannel / updatePiChannel / removePiChannel 与默认通道联动", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().addPiChannel(channel("deepseek"));
    usePersonalStore.getState().addPiChannel(channel("qwen"));
    expect(usePersonalStore.getState().piSettings.channels.map((c) => c.id)).toEqual(["deepseek", "qwen"]);

    usePersonalStore.getState().updatePiChannel("deepseek", { apiKey: "sk-ds", enabled: false });
    const ds = usePersonalStore.getState().piSettings.channels.find((c) => c.id === "deepseek")!;
    expect(ds.apiKey).toBe("sk-ds");
    expect(ds.enabled).toBe(false);
    // 其他通道不受影响。
    expect(usePersonalStore.getState().piSettings.channels.find((c) => c.id === "qwen")!.apiKey).toBeUndefined();

    // 设默认通道后删除它 → 默认指向一并清空。
    usePersonalStore.getState().setPiDefaults({ defaultChannelId: "deepseek", defaultModel: "deepseek-m1" });
    usePersonalStore.getState().removePiChannel("deepseek");
    const s = usePersonalStore.getState();
    expect(s.piSettings.channels.map((c) => c.id)).toEqual(["qwen"]);
    expect(s.piSettings.defaultChannelId).toBeUndefined();
    expect(s.piSettings.defaultModel).toBeUndefined();
  });

  it("piSettings 进入持久化快照", () => {
    usePersonalStore.getState().hydrate(base);
    usePersonalStore.getState().addPiChannel(channel("kimi"));
    const s = usePersonalStore.getState();
    expect(toPersistedState(s).piSettings).toBe(s.piSettings);
  });
});

describe("setAgentsAvailable 不持久化", () => {
  it("写入探测结果但不进 toPersistedState 快照", () => {
    usePersonalStore.getState().setAgentsAvailable({ claude: true, codex: false });
    expect(usePersonalStore.getState().agentsAvailable).toEqual({ claude: true, codex: false });
    expect("agentsAvailable" in toPersistedState(usePersonalStore.getState())).toBe(false);
  });
});
