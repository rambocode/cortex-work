# Spotlight 浮动聊天框 — 实现规格（精确代码）

> 实现 agent 必读。所有路径都在 worktree `/Users/mike/source/ai/cortex-work-spotlight` 下，**绝不触碰** `/Users/mike/source/ai/cortex-work`。不要 `cd`，文件操作用绝对路径。本阶段只按本规格写文件，不跑 typecheck（Build 阶段统一跑）。

约定：`WT = /Users/mike/source/ai/cortex-work-spotlight`。下面「FIND」是文件中现存的精确片段，「REPLACE」是替换后的内容；标「新建文件」的给出整文件内容。

---

## PART 1 — Scaffold（core 契约 + 逻辑 + 单测）

### 1.1 EDIT `packages/core/desktop/types.ts`

(a) 在 `export interface CliExitEvent { ... }` 之后插入新接口：

```ts
// 菜单栏 Spotlight 浮动框提交的发起意图（bar → 主进程 → 主窗口接力新建会话）。
export interface SpotlightIntent {
  id: string; // 去重用唯一 id
  prompt: string;
  agent: AgentKind;
  model?: string;
  piChannelId?: string; // pi 选中通道
  projectId?: string; // 缺省 = 不使用项目
}
```

(b) PersistedState 增加 last-used 记忆字段。FIND：

```ts
  piSettings?: PiSettings;
  // 右侧面板自定义宽度（px）;未设置时按视图走 CSS 自动档位。
  rightPanelWidth?: number;
}
```

REPLACE：

```ts
  piSettings?: PiSettings;
  // 右侧面板自定义宽度（px）;未设置时按视图走 CSS 自动档位。
  rightPanelWidth?: number;
  // 「最后一次使用」记忆（Spotlight/新会话默认沿用;读取回退见 initialAgent）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastPiChannelId?: string;
}
```

### 1.2 EDIT `apps/desktop/src/main/ipc/types.ts`

在 `export interface ProjectMeta { ... }` 之后插入镜像类型（与 core 完全一致）：

```ts
// 菜单栏 Spotlight 浮动框发起意图（与 packages/core/desktop/types.ts 镜像）。
export interface SpotlightIntent {
  id: string;
  prompt: string;
  agent: AgentKind;
  model?: string;
  piChannelId?: string;
  projectId?: string;
}
```

### 1.3 EDIT `packages/core/desktop/bridge.ts`

(a) 在 import type 块里加入 `SpotlightIntent`（与其它类型并列，注意保持字母序附近即可）：把 `PushTarget,` 一行后或类型列表中加入 `SpotlightIntent,`。

(b) 在 `onAutomationRunEvent?(cb: (event: AutomationRunEvent) => void): () => void;` 之后、接口闭合 `}` 之前插入：

```ts
  // 菜单栏 Spotlight 浮动框 → 主窗口接力:订阅发起意图 + 冷启动兜底拉取。
  // 可选能力（旧壳/web 端没有）。
  onSpotlightIntent?(cb: (intent: SpotlightIntent) => void): () => void;
  consumeSpotlightIntent?(): Promise<SpotlightIntent | null>;
```

### 1.4 EDIT `packages/core/store/personal.ts`

(a) import type 块加入 `SpotlightIntent`。FIND：

```ts
import type {
  AgentKind,
  PersistedState,
  PiChannel,
  PiSettings,
  ProjectMeta,
  PromptNode,
  PushSettings,
  SessionMeta,
  TimelineSettings,
  TodoMeta,
  TtsSettings,
} from "../desktop/types";
```

REPLACE：在 `SessionMeta,` 后加一行 `SpotlightIntent,`（即把 `SpotlightIntent,` 插入到 import 列表中）。

(b) PersonalState 接口增加字段。FIND：

```ts
  // 各 agent 是否可用（主进程探测,不持久化;启动时回填）。
  agentsAvailable?: Partial<Record<AgentKind, boolean>>;
  // 兜底 Agent（内置 pi）配置（持久化）。
  piSettings: PiSettings;
  hydrate: (s: PersistedState) => void;
```

REPLACE：

```ts
  // 各 agent 是否可用（主进程探测,不持久化;启动时回填）。
  agentsAvailable?: Partial<Record<AgentKind, boolean>>;
  // 兜底 Agent（内置 pi）配置（持久化）。
  piSettings: PiSettings;
  // 「最后一次使用」记忆（持久化;Spotlight/新会话默认沿用）。
  lastAgent?: AgentKind;
  lastModel?: string;
  lastPiChannelId?: string;
  // Spotlight 接力:待主窗口个人工作区消费的发起意图（不持久化）。
  pendingSpotlightIntent?: SpotlightIntent;
  hydrate: (s: PersistedState) => void;
```

(c) PersonalState 接口里增加两个 action 声明。FIND：

```ts
  setActiveSession: (sessionId: string) => void;
```

REPLACE：

```ts
  setActiveSession: (sessionId: string) => void;
  // Spotlight 接力:暂存 / 原子消费发起意图。
  setPendingSpotlightIntent: (intent: SpotlightIntent) => void;
  consumePendingSpotlightIntent: () => SpotlightIntent | undefined;
```

(d) hydrate 回填 last-used。FIND：

```ts
      // 旧结构（单 provider,无 channels）按空通道重置;用户重新配置。
      piSettings: Array.isArray(s.piSettings?.channels) ? s.piSettings : DEFAULT_PI_SETTINGS,
      rightPanelWidth: s.rightPanelWidth,
    }),
```

REPLACE：

```ts
      // 旧结构（单 provider,无 channels）按空通道重置;用户重新配置。
      piSettings: Array.isArray(s.piSettings?.channels) ? s.piSettings : DEFAULT_PI_SETTINGS,
      rightPanelWidth: s.rightPanelWidth,
      lastAgent: s.lastAgent,
      lastModel: s.lastModel,
      lastPiChannelId: s.lastPiChannelId,
    }),
```

(e) createSession 的 set 块写入 last-used。FIND：

```ts
    set((s) => ({
      sessions: [...s.sessions, sess],
      // projectId 为 undefined 即清空 activeProjectId（无项目会话不归属任何项目）。
      activeProjectId: projectId,
      activeSessionId: sess.id,
      homeOpen: false,
      automationOpen: false,
    }));
    return sess;
```

REPLACE：

```ts
    set((s) => ({
      sessions: [...s.sessions, sess],
      // projectId 为 undefined 即清空 activeProjectId（无项目会话不归属任何项目）。
      activeProjectId: projectId,
      activeSessionId: sess.id,
      homeOpen: false,
      automationOpen: false,
      // 记忆本次选择（下次 Spotlight/新会话默认沿用;用 sess.* 取已 resolve 的值）。
      lastAgent: agent,
      lastModel: sess.model,
      lastPiChannelId: sess.piChannelId,
    }));
    return sess;
```

(f) 在 `setActiveSession` 的实现附近加入两个 action 实现。FIND（实现处）：

```ts
  setActiveSession: (sessionId) =>
```

在该实现语句**之前**插入：

```ts
  setPendingSpotlightIntent: (intent) => set({ pendingSpotlightIntent: intent }),
  consumePendingSpotlightIntent: () => {
    const cur = get().pendingSpotlightIntent;
    if (cur) set({ pendingSpotlightIntent: undefined });
    return cur;
  },

```

> 注意：`setActiveSession:` 实现的确切形态以文件为准，插入点为该 action 实现行的上一行；保证逗号分隔合法。

(g) toPersistedState 透传 last-used。FIND：

```ts
    piSettings: s.piSettings,
    rightPanelWidth: s.rightPanelWidth,
  };
}
```

REPLACE：

```ts
    piSettings: s.piSettings,
    rightPanelWidth: s.rightPanelWidth,
    lastAgent: s.lastAgent,
    lastModel: s.lastModel,
    lastPiChannelId: s.lastPiChannelId,
  };
}
```

(h) 在文件末尾 `defaultAgent` 函数之后追加两个选择器：

```ts

// Spotlight/新会话发起的初始 agent:优先记忆,回退按安装情况派生（记忆 agent 不可用则回退）。
export function initialAgent(s: Pick<PersonalState, "lastAgent" | "agentsAvailable">): AgentKind {
  if (s.lastAgent && (s.lastAgent === "pi" || s.agentsAvailable?.[s.lastAgent])) return s.lastAgent;
  return defaultAgent(s.agentsAvailable);
}

// 与 initialAgent 配对的初始模型/通道（pi 走通道;其余 lastModel 仅同 agent 时沿用,否则取该 agent 默认）。
export function initialModelDraft(
  s: Pick<PersonalState, "lastAgent" | "lastModel" | "lastPiChannelId" | "agentsAvailable" | "piSettings">,
): { agent: AgentKind; model: string | undefined; piChannelId: string | undefined } {
  const agent = initialAgent(s);
  const sameAgent = agent === s.lastAgent;
  if (agent === "pi") {
    const ch =
      s.piSettings.channels.find((c) => c.id === (s.lastPiChannelId ?? s.piSettings.defaultChannelId)) ??
      s.piSettings.channels[0];
    return {
      agent,
      model: (sameAgent ? s.lastModel : undefined) ?? s.piSettings.defaultModel ?? ch?.models[0]?.id,
      piChannelId: ch?.id,
    };
  }
  return { agent, model: (sameAgent ? s.lastModel : undefined) ?? DEFAULT_MODEL[agent], piChannelId: undefined };
}
```

### 1.5 EDIT `packages/core/desktop/usePersonalPersistence.ts`

saveUrgency 的 throttled 条件加入 last-used。FIND：

```ts
  if (
    s.sessions !== prev.sessions ||
    s.todos !== prev.todos ||
    s.timelineSettings !== prev.timelineSettings ||
    s.pushSettings !== prev.pushSettings ||
    s.ttsSettings !== prev.ttsSettings ||
    s.rightPanelWidth !== prev.rightPanelWidth
  )
    return "throttled";
```

REPLACE：

```ts
  if (
    s.sessions !== prev.sessions ||
    s.todos !== prev.todos ||
    s.timelineSettings !== prev.timelineSettings ||
    s.pushSettings !== prev.pushSettings ||
    s.ttsSettings !== prev.ttsSettings ||
    s.rightPanelWidth !== prev.rightPanelWidth ||
    s.lastAgent !== prev.lastAgent ||
    s.lastModel !== prev.lastModel ||
    s.lastPiChannelId !== prev.lastPiChannelId
  )
    return "throttled";
```

### 1.6 EDIT `packages/core/personal/messages.ts`

(a) import type 加 `ProjectMeta`。FIND：

```ts
import type { AgentKind, CliStreamEvent, HiddenHistoryMeta, SessionMeta } from "../desktop/types";
```

REPLACE：

```ts
import type { AgentKind, CliStreamEvent, HiddenHistoryMeta, ProjectMeta, SessionMeta } from "../desktop/types";
```

(b) 在 `buildAttachmentSystemPrompt` 函数之后插入 `buildProjectSystemPrompt`：

```ts

// 个人工作区项目清单 → system prompt 块（让 agent 知道用户有哪些本地项目及绝对路径）。
// 排除归档项目;无可用项目返回 undefined。Spotlight 默认「不使用项目」时 cwd 是 no-project
// 目录,但此块仍列出项目,便于 agent 按需进入某项目。
export function buildProjectSystemPrompt(projects: ProjectMeta[]): string | undefined {
  const active = projects.filter((p) => p.archivedAt == null);
  if (active.length === 0) return undefined;
  const lines = active.map((p) => `- ${p.name}: ${p.path}`).join("\n");
  return [
    "<personal_workspace_projects>",
    "以下是用户「个人工作区」中登记的本地项目(名称: 绝对路径)。",
    "当前会话默认不在任何项目目录下工作;如需操作某项目,请使用其绝对路径。",
    lines,
    "</personal_workspace_projects>",
  ].join("\n");
}
```

(c) PersonalActions.send 类型加可选第 5 参。FIND：

```ts
  send: (session: SessionMeta, projectPath: string, text: string, attachments: PersonalAttachment[]) => Promise<void>;
```

REPLACE：

```ts
  send: (
    session: SessionMeta,
    projectPath: string,
    text: string,
    attachments: PersonalAttachment[],
    extraSystemPrompt?: string,
  ) => Promise<void>;
```

(d) send 实现签名加形参。FIND：

```ts
  const send = useCallback<PersonalActions["send"]>(
    async (session, projectPath, text, attachments) => {
```

REPLACE：

```ts
  const send = useCallback<PersonalActions["send"]>(
    async (session, projectPath, text, attachments, extraSystemPrompt) => {
```

(e) appendSystemPrompt 合并 extraSystemPrompt。FIND：

```ts
      const appendSystemPrompt = buildAttachmentSystemPrompt(attachments);
```

REPLACE：

```ts
      const attachmentPrompt = buildAttachmentSystemPrompt(attachments);
      // 项目信息（Spotlight 注入）在前、附件 skills/todos 在后;两者皆空仍传 undefined。
      const appendSystemPrompt = [extraSystemPrompt, attachmentPrompt].filter(Boolean).join("\n\n") || undefined;
```

### 1.7 新建文件 `packages/core/personal/spotlightHandoff.ts`

```ts
// 菜单栏 Spotlight 浮动框 → 主窗口接力。拆两个 hook 规避竞态:
// - useSpotlightIntentRouter:始终挂载（CortexDesktopView 根部）。收到发起意图后切到
//   个人工作区并把 intent 暂存进 store,由 handoff 在 hydrate 后消费。
// - useSpotlightHandoff:与 usePersonalCliEvents 同处挂载（PersonalWorkspace）。store
//   hydrate 完成且有待处理意图时,新建会话 + 注入项目信息 system prompt + 发首条消息。
//   co-mount 保证 CLI 事件监听已注册、且 hydrate 不会覆盖刚建的会话。

import { useEffect } from "react";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import { useCortexUIStore } from "../store/ui";
import { usePersonalActions, buildProjectSystemPrompt } from "./messages";
import { dayKey } from "./timeline";
import type { SpotlightIntent } from "../desktop/types";

// 跨重挂去重:同一 intent 经 live 事件 + 冷启动 consume 可能两路抵达。
const routedIds = new Set<string>();

export function useSpotlightIntentRouter(): void {
  const bridge = useDesktopBridge();
  useEffect(() => {
    if (!bridge?.onSpotlightIntent) return;
    const route = (intent: SpotlightIntent) => {
      if (!intent || routedIds.has(intent.id)) return;
      routedIds.add(intent.id);
      useCortexUIStore.getState().setWorkspace("personal");
      usePersonalStore.getState().setPendingSpotlightIntent(intent);
    };
    void bridge.consumeSpotlightIntent?.().then((i) => {
      if (i) route(i);
    });
    return bridge.onSpotlightIntent(route);
  }, [bridge]);
}

export function useSpotlightHandoff(): void {
  const bridge = useDesktopBridge();
  const { send } = usePersonalActions();
  const hydrated = usePersonalStore((s) => s.hydrated);
  const pending = usePersonalStore((s) => s.pendingSpotlightIntent);
  useEffect(() => {
    if (!bridge || !hydrated || !pending) return;
    const intent = usePersonalStore.getState().consumePendingSpotlightIntent();
    if (!intent) return;
    void (async () => {
      const st = usePersonalStore.getState();
      const proj = intent.projectId ? st.projects.find((p) => p.id === intent.projectId) : undefined;
      let cwd = proj?.path;
      if (!cwd) {
        cwd = (await bridge.ensureNoProjectDir?.(dayKey(Date.now()))) ?? undefined;
      }
      if (!cwd) return; // 无 no-project 目录能力,放弃
      const sess = st.createSession(intent.projectId, intent.agent, intent.model, proj ? undefined : { noProjectDir: cwd });
      if (intent.agent === "pi" && intent.piChannelId) st.updateSession(sess.id, { piChannelId: intent.piChannelId });
      const sysPrompt = buildProjectSystemPrompt(st.projects);
      await send(sess, cwd, intent.prompt, [], sysPrompt);
    })();
  }, [bridge, hydrated, pending, send]);
}
```

### 1.8 EDIT `packages/core/index.ts`

(a) store/personal 导出块加 `initialAgent, initialModelDraft`。FIND：

```ts
export {
  usePersonalStore,
  toPersistedState,
  partitionProjects,
  defaultAgent,
  type PersonalState,
} from "./store/personal";
```

REPLACE：

```ts
export {
  usePersonalStore,
  toPersistedState,
  partitionProjects,
  defaultAgent,
  initialAgent,
  initialModelDraft,
  type PersonalState,
} from "./store/personal";
```

(b) desktop/types 导出块加 `type SpotlightIntent`。FIND：

```ts
  type SessionMeta,
  type TodoMeta,
  type TodoStatus,
  type PersistedState,
```

REPLACE：

```ts
  type SessionMeta,
  type SpotlightIntent,
  type TodoMeta,
  type TodoStatus,
  type PersistedState,
```

(c) messages 导出块加 `buildProjectSystemPrompt`。FIND：

```ts
export {
  personalChatKeys,
  buildAttachmentSystemPrompt,
  usePersonalChat,
```

REPLACE：

```ts
export {
  personalChatKeys,
  buildAttachmentSystemPrompt,
  buildProjectSystemPrompt,
  usePersonalChat,
```

(d) 在 `export { usePersonalPersistence } from "./desktop/usePersonalPersistence";` 之后追加一行：

```ts
export { useSpotlightIntentRouter, useSpotlightHandoff } from "./personal/spotlightHandoff";
```

### 1.9 新建测试 `packages/core/personal/spotlightPrompt.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildProjectSystemPrompt } from "./messages";
import type { ProjectMeta } from "../desktop/types";

const proj = (over: Partial<ProjectMeta>): ProjectMeta => ({
  id: "p", name: "n", path: "/p", addedAt: 0, ...over,
});

describe("buildProjectSystemPrompt", () => {
  it("空项目列表返回 undefined", () => {
    expect(buildProjectSystemPrompt([])).toBeUndefined();
  });
  it("全部归档返回 undefined", () => {
    expect(buildProjectSystemPrompt([proj({ archivedAt: 1 })])).toBeUndefined();
  });
  it("列出未归档项目的名称与路径,排除归档", () => {
    const out = buildProjectSystemPrompt([
      proj({ id: "a", name: "alpha", path: "/code/alpha" }),
      proj({ id: "b", name: "beta", path: "/code/beta", archivedAt: 123 }),
    ]);
    expect(out).toContain("<personal_workspace_projects>");
    expect(out).toContain("- alpha: /code/alpha");
    expect(out).not.toContain("beta");
  });
});
```

### 1.10 新建测试 `packages/core/store/initialDraft.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { initialAgent, initialModelDraft } from "./personal";
import { DEFAULT_PI_SETTINGS } from "../desktop/types";

describe("initialAgent", () => {
  it("无记忆时按安装情况派生（claude 可用 → claude）", () => {
    expect(initialAgent({ agentsAvailable: { claude: true } })).toBe("claude");
  });
  it("记忆 agent 不可用时回退 defaultAgent", () => {
    expect(initialAgent({ lastAgent: "codex", agentsAvailable: { claude: true, codex: false } })).toBe("claude");
  });
  it("记忆 pi 恒可用", () => {
    expect(initialAgent({ lastAgent: "pi", agentsAvailable: {} })).toBe("pi");
  });
  it("记忆 agent 可用则沿用", () => {
    expect(initialAgent({ lastAgent: "codex", agentsAvailable: { claude: true, codex: true } })).toBe("codex");
  });
});

describe("initialModelDraft", () => {
  const base = { agentsAvailable: { claude: true, codex: true }, piSettings: DEFAULT_PI_SETTINGS };
  it("无记忆 → 该 agent 默认模型", () => {
    const d = initialModelDraft({ ...base, lastAgent: undefined, lastModel: undefined, lastPiChannelId: undefined });
    expect(d.agent).toBe("claude");
    expect(d.model).toBe("sonnet");
    expect(d.piChannelId).toBeUndefined();
  });
  it("记忆 agent+model 一致则沿用 lastModel", () => {
    const d = initialModelDraft({ ...base, lastAgent: "codex", lastModel: "gpt-5.4", lastPiChannelId: undefined });
    expect(d.agent).toBe("codex");
    expect(d.model).toBe("gpt-5.4");
  });
  it("记忆 agent 不可用回退后不沿用旧 model（取新 agent 默认）", () => {
    const d = initialModelDraft({
      agentsAvailable: { claude: true, codex: false },
      piSettings: DEFAULT_PI_SETTINGS,
      lastAgent: "codex",
      lastModel: "gpt-5.4",
      lastPiChannelId: undefined,
    });
    expect(d.agent).toBe("claude");
    expect(d.model).toBe("sonnet");
  });
});
```

---

## PART 2 — Module A（主进程 / preload / 构建配置）

### 2.1 新建文件 `apps/desktop/src/main/spotlight.ts`

```ts
// 菜单栏 Spotlight 浮动聊天框窗口（第二窗口）。frameless + 透明 + 置顶,复用主窗口同一
// preload（window.desktopAPI 可用）。左键托盘 toggle 唤起,失焦自动隐藏。发送由
// ipc/spotlight.ts 接力到主窗口。

import { BrowserWindow, screen } from "electron";
import { join } from "path";
import { existsSync } from "fs";
import { is } from "@electron-toolkit/utils";

const BAR_WIDTH = 720;
const BAR_HEIGHT = 96; // 折叠态(单行输入条 + 内边距)
const MAX_HEIGHT = 460; // New Chat 弹层展开上限
const BOTTOM_MARGIN = 120; // 离屏幕底部留白

let win: BrowserWindow | null = null;

function spotlightHtml(): string {
  const flat = join(__dirname, "../renderer/spotlight.html");
  const nested = join(__dirname, "../renderer/src/spotlight.html");
  return existsSync(flat) ? flat : nested;
}

function position(w: BrowserWindow, height: number): void {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const x = Math.round(workArea.x + (workArea.width - BAR_WIDTH) / 2);
  const y = Math.round(workArea.y + workArea.height - height - BOTTOM_MARGIN);
  w.setBounds({ x, y, width: BAR_WIDTH, height });
}

function create(): BrowserWindow {
  win = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/spotlight.html`);
  } else {
    void win.loadFile(spotlightHtml());
  }
  win.on("blur", () => hideSpotlight());
  win.on("closed", () => {
    win = null;
  });
  return win;
}

export function showSpotlight(): void {
  const w = win && !win.isDestroyed() ? win : create();
  position(w, BAR_HEIGHT);
  if (process.platform === "darwin") w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.showInactive();
  w.focus();
}

export function hideSpotlight(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function toggleSpotlight(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideSpotlight();
  else showSpotlight();
}

export function resizeSpotlight(height: number): void {
  if (!win || win.isDestroyed()) return;
  const h = Math.max(BAR_HEIGHT, Math.min(Math.round(height), MAX_HEIGHT));
  position(win, h);
}

export function getSpotlightWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function destroySpotlight(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
```

### 2.2 新建文件 `apps/desktop/src/main/ipc/spotlight.ts`

```ts
// Spotlight 浮动框 IPC:接收 bar 的发起意图,隐藏浮动框 + 唤起主窗口 + 把 intent
// 接力给主窗口（暖窗口走 live 事件;冷启动/加载中走 pending,主窗口 mount 时 consume）。

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { hideSpotlight, resizeSpotlight } from "../spotlight";
import type { SpotlightIntent } from "./types";

let pending: SpotlightIntent | null = null;

export function registerSpotlightHandlers(opts: {
  showMainWindow: () => void;
  getMainWindow: () => BrowserWindow | null;
}): void {
  ipcMain.handle("spotlight:submit", (_e, intent: SpotlightIntent) => {
    hideSpotlight();
    const existing = opts.getMainWindow();
    const warm = !!existing && !existing.isDestroyed() && !existing.webContents.isLoading();
    opts.showMainWindow();
    const win = opts.getMainWindow();
    if (warm && win && !win.isDestroyed()) {
      win.webContents.send("spotlight:intent", intent);
    } else {
      // 冷启动/加载中:主窗口 mount 时 consumePending 兜底（避免在 listener 注册前发丢）。
      pending = intent;
    }
  });
  ipcMain.handle("spotlight:consumePending", () => {
    const i = pending;
    pending = null;
    return i;
  });
  ipcMain.on("spotlight:resize", (_e, height: number) => resizeSpotlight(height));
  ipcMain.on("spotlight:hide", () => hideSpotlight());
}
```

### 2.3 EDIT `apps/desktop/src/main/automation/tray.ts`

整文件替换为：

```ts
// 系统托盘:关窗后应用驻留后台时的入口。左键唤起菜单栏 Spotlight 浮动框,右键弹出菜单
// （显示主窗口 / 退出）。让定时任务在窗口关闭后仍能触发。图标暂复用应用图标。

import { Menu, Tray, nativeImage } from "electron";
import { app } from "electron";
import { join } from "path";

let tray: Tray | null = null;

function trayIconPath(): string {
  const name = "cortex-neuron-icon.png";
  return app.isPackaged
    ? join(app.getAppPath(), "assets", name)
    : join(__dirname, "../../assets", name);
}

export function createTray(opts: {
  onShow: () => void;
  onQuit: () => void;
  onToggleSpotlight: () => void;
}): void {
  if (tray) return;
  let image = nativeImage.createFromPath(trayIconPath());
  if (!image.isEmpty()) image = image.resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip("Cortex Desktop");
  const menu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => opts.onShow() },
    { type: "separator" },
    { label: "退出 Cortex", click: () => opts.onQuit() },
  ]);
  // 不用 setContextMenu:否则 macOS 左键也弹菜单,吃掉 toggle。
  // 左键:toggle Spotlight 浮动框;右键:手动弹菜单。
  tray.on("click", () => opts.onToggleSpotlight());
  tray.on("right-click", () => tray?.popUpContextMenu(menu));
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
```

### 2.4 EDIT `apps/desktop/src/main/index.ts`

(a) 顶部 import 追加（在 `import { createTray, destroyTray } from "./automation/tray";` 之后）：

```ts
import { toggleSpotlight, destroySpotlight, getSpotlightWindow } from "./spotlight";
import { registerSpotlightHandlers } from "./ipc/spotlight";
```

(b) createTray 调用加 onToggleSpotlight,并在其后注册 spotlight handlers。FIND：

```ts
    registerIpcHandlers();
    // 先建托盘:即使建窗失败也保留后台入口与调度。
    createTray({
      onShow: showMainWindow,
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
    });
```

REPLACE：

```ts
    registerIpcHandlers();
    registerSpotlightHandlers({ showMainWindow, getMainWindow: () => mainWindow });
    // 先建托盘:即使建窗失败也保留后台入口与调度。
    createTray({
      onShow: showMainWindow,
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
      onToggleSpotlight: toggleSpotlight,
    });
```

(c) activate 重建判断排除 spotlight。FIND：

```ts
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
```

REPLACE：

```ts
    app.on("activate", () => {
      // 排除 Spotlight 浮动窗口:避免「主窗口已关、只剩 Spotlight」时点 Dock 不重建主窗口。
      const real = BrowserWindow.getAllWindows().filter((w) => w !== getSpotlightWindow());
      if (real.length === 0) createWindow();
      else showMainWindow();
    });
```

(d) before-quit 销毁 spotlight。FIND：

```ts
    killAllPty();
    closeAllWatchers();
    destroyTray();
  });
```

REPLACE：

```ts
    killAllPty();
    closeAllWatchers();
    destroyTray();
    destroySpotlight();
  });
```

### 2.5 EDIT `apps/desktop/electron.vite.config.ts`

renderer 段加多入口。FIND：

```ts
  renderer: {
    server: {
      port: Number.isFinite(configuredRendererPort) ? configuredRendererPort : 0,
      strictPort: false,
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      dedupe: ["react", "react-dom"],
    },
  },
```

REPLACE：

```ts
  renderer: {
    server: {
      port: Number.isFinite(configuredRendererPort) ? configuredRendererPort : 0,
      strictPort: false,
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      dedupe: ["react", "react-dom"],
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve("src/renderer/index.html"),
          spotlight: resolve("src/renderer/spotlight.html"),
        },
      },
    },
  },
```

### 2.6 EDIT `apps/desktop/src/preload/index.ts`

(a) import type 块加入 `SpotlightIntent`（与其它类型并列）。在 `PromptNode,` 一行附近加 `SpotlightIntent,`。

(b) 在 `personal` 对象末尾（`onAutomationRunEvent: (...) => {...},` 之后、对象闭合 `};` 之前）加入：

```ts
  // Spotlight 浮动框 → 主窗口接力:主窗口订阅发起意图 + mount 时 consume 冷启动 pending。
  onSpotlightIntent: (cb: (intent: SpotlightIntent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, intent: SpotlightIntent) => cb(intent);
    ipcRenderer.on("spotlight:intent", listener);
    return () => ipcRenderer.removeListener("spotlight:intent", listener);
  },
  consumeSpotlightIntent: (): Promise<SpotlightIntent | null> => ipcRenderer.invoke("spotlight:consumePending"),
```

(c) 在 `const desktopAPI = {` 之前新增 `spotlight` 命名空间（bar 专用,app 层调用）：

```ts
// 菜单栏 Spotlight 浮动框窗口专用桥（bar renderer 直接调用,不属于 DesktopBridge）。
const spotlight = {
  submit: (intent: SpotlightIntent): Promise<void> => ipcRenderer.invoke("spotlight:submit", intent),
  resize: (height: number): void => ipcRenderer.send("spotlight:resize", height),
  hide: (): void => ipcRenderer.send("spotlight:hide"),
};
```

(d) desktopAPI 对象加入 spotlight。FIND：

```ts
  } satisfies RuntimeConfig,
  personal,
};
```

REPLACE：

```ts
  } satisfies RuntimeConfig,
  personal,
  spotlight,
};
```

---

## PART 3 — Module B（渲染层 bar）

### 3.1 新建文件 `apps/desktop/src/renderer/spotlight.html`

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cortex Spotlight</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/spotlight.tsx"></script>
  </body>
</html>
```

### 3.2 新建文件 `apps/desktop/src/renderer/src/spotlight.tsx`

```tsx
import ReactDOM from "react-dom/client";
import { SpotlightBar } from "./SpotlightBar";
import "./spotlight.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<SpotlightBar />);
```

### 3.3 新建文件 `apps/desktop/src/renderer/src/SpotlightBar.tsx`

> bar 直接用 `window.desktopAPI`（app 层允许）。只读 `loadState()/detectAgents()`，提交 `spotlight.submit`。不持有 store、不渲染聊天。控件收进「New Chat ▼」弹层。

```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  AGENT_MODELS,
  DEFAULT_MODEL,
  DEFAULT_PI_SETTINGS,
  initialModelDraft,
  type AgentKind,
  type PiSettings,
  type ProjectMeta,
  type SpotlightIntent,
} from "@cortex-work/core";

interface Draft {
  agent: AgentKind;
  model: string | undefined;
  piChannelId: string | undefined;
  projectId: string | undefined; // undefined = 不使用项目
}

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `spot-${Date.now().toString(36)}-${nextId}`;
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };

export function SpotlightBar(): JSX.Element {
  const api = typeof window !== "undefined" ? window.desktopAPI : undefined;
  const [prompt, setPrompt] = useState("");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [piSettings, setPiSettings] = useState<PiSettings>(DEFAULT_PI_SETTINGS);
  const [avail, setAvail] = useState<Partial<Record<AgentKind, boolean>>>({});
  const [draft, setDraft] = useState<Draft>({ agent: "claude", model: "sonnet", piChannelId: undefined, projectId: undefined });
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 读取持久化状态 + 探测可用性 → 算默认 draft（记忆上次 agent/model;项目默认不使用项目）。
  const refresh = useCallback(async () => {
    if (!api?.personal) return;
    try {
      const ps = await api.personal.loadState();
      const availability = await api.personal.detectAgents().catch(() => ({}) as Partial<Record<AgentKind, boolean>>);
      const pi = (ps.piSettings && Array.isArray(ps.piSettings.channels) ? ps.piSettings : DEFAULT_PI_SETTINGS) as PiSettings;
      setProjects(ps.projects ?? []);
      setPiSettings(pi);
      setAvail(availability);
      const d = initialModelDraft({
        lastAgent: ps.lastAgent,
        lastModel: ps.lastModel,
        lastPiChannelId: ps.lastPiChannelId,
        agentsAvailable: availability,
        piSettings: pi,
      });
      setDraft({ agent: d.agent, model: d.model, piChannelId: d.piChannelId, projectId: undefined });
    } catch {
      // 读取失败保持默认 draft。
    }
  }, [api]);

  // 挂载 + 每次窗口获得焦点（托盘再次唤起）时刷新并清空输入、聚焦。
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      setPrompt("");
      setMenuOpen(false);
      void refresh();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("focus", onFocus);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // 弹层开合时上报所需高度,主进程把窗口向上长高/收回（底边固定）。
  useLayoutEffect(() => {
    if (!api?.spotlight) return;
    const h = menuOpen ? (rootRef.current?.scrollHeight ?? 0) + 24 : 96;
    api.spotlight.resize(h);
  }, [menuOpen, api]);

  const modelOptions =
    draft.agent === "pi"
      ? (piSettings.channels.find((c) => c.id === draft.piChannelId)?.models ?? []).map((m) => ({
          label: m.label ?? m.id,
          value: m.id,
        }))
      : AGENT_MODELS[draft.agent];

  function pickAgent(agent: AgentKind): void {
    if (agent === "pi") {
      const ch = piSettings.channels.find((c) => c.id === (piSettings.defaultChannelId ?? piSettings.channels[0]?.id)) ?? piSettings.channels[0];
      setDraft((d) => ({ ...d, agent, piChannelId: ch?.id, model: piSettings.defaultModel ?? ch?.models[0]?.id }));
    } else {
      setDraft((d) => ({ ...d, agent, piChannelId: undefined, model: DEFAULT_MODEL[agent] }));
    }
  }

  function submit(): void {
    const text = prompt.trim();
    if (!text || !api?.spotlight) return;
    const intent: SpotlightIntent = {
      id: makeId(),
      prompt: text,
      agent: draft.agent,
      model: draft.model,
      piChannelId: draft.agent === "pi" ? draft.piChannelId : undefined,
      projectId: draft.projectId,
    };
    void api.spotlight.submit(intent);
    setPrompt("");
    setMenuOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (menuOpen) setMenuOpen(false);
      else api?.spotlight?.hide();
    }
  }

  const projectLabel = draft.projectId ? projects.find((p) => p.id === draft.projectId)?.name ?? "项目" : "不使用项目";

  return (
    <div className="spot-root" ref={rootRef}>
      <div className="spot-bar">
        <span className="spot-logo" aria-hidden>
          <Icon.Sparkle size={20} />
        </span>
        <textarea
          ref={inputRef}
          className="spot-input"
          rows={1}
          placeholder="What can I help you with today?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="spot-menu-btn" onClick={() => setMenuOpen((v) => !v)} type="button">
          New Chat <Icon.Chevron size={14} />
        </button>
        <button className="spot-send" onClick={submit} disabled={!prompt.trim()} type="button" aria-label="发送">
          <Icon.Send size={16} />
        </button>
      </div>
      {menuOpen ? (
        <div className="spot-menu">
          <label className="spot-row">
            <span>Agent</span>
            <select
              value={draft.agent}
              onChange={(e) => pickAgent(e.target.value as AgentKind)}
            >
              {(Object.keys(AGENT_MODELS) as AgentKind[]).map((a) => (
                <option key={a} value={a} disabled={a !== "pi" && avail[a] === false}>
                  {AGENT_LABEL[a]}
                  {a !== "pi" && avail[a] === false ? "（未安装）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="spot-row">
            <span>模型</span>
            <select
              value={draft.model ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || undefined }))}
            >
              {modelOptions.length === 0 ? <option value="">（无可用模型）</option> : null}
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="spot-row">
            <span>项目</span>
            <select
              value={draft.projectId ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, projectId: e.target.value || undefined }))}
            >
              <option value="">不使用项目</option>
              {projects
                .filter((p) => p.archivedAt == null)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="spot-menu-foot">{projectLabel === "不使用项目" ? "将在 Documents/cortex 下新建临时会话" : `将在项目「${projectLabel}」目录工作`}</div>
        </div>
      ) : null}
    </div>
  );
}
```

> 若 `Icon.Sparkle` / `Icon.Chevron` / `Icon.Send` 任一不存在，用 `@cortex-work/ui/icons` 中存在的近似图标替换（已确认这三个存在）。`JSX.Element` 若 lint 报未定义可改返回类型为 `React.ReactElement` 并 `import type React from "react"`。

### 3.4 新建文件 `apps/desktop/src/renderer/src/spotlight.css`

```css
/* Spotlight 浮动框:透明窗口 + 底部圆角白卡。app 层私有,不污染 views 共享样式。 */
html,
body {
  margin: 0;
  height: 100%;
  background: transparent;
  overflow: hidden;
  font-family:
    -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
}

#root {
  height: 100%;
}

.spot-root {
  box-sizing: border-box;
  padding: 8px 12px;
}

.spot-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #ffffff;
  border-radius: 16px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.12);
  padding: 14px 16px;
}

.spot-logo {
  display: inline-flex;
  color: #e0623a;
  flex: 0 0 auto;
}

.spot-input {
  flex: 1 1 auto;
  border: none;
  outline: none;
  resize: none;
  font-size: 20px;
  line-height: 1.4;
  color: #1d1d1f;
  background: transparent;
  max-height: 120px;
}

.spot-input::placeholder {
  color: #9a9a9e;
}

.spot-menu-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: #6b6b70;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
}

.spot-menu-btn:hover {
  background: #f1f1f3;
}

.spot-send {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 12px;
  background: #e0623a;
  color: #fff;
  cursor: pointer;
}

.spot-send:disabled {
  opacity: 0.4;
  cursor: default;
}

.spot-menu {
  margin-top: 8px;
  background: #ffffff;
  border-radius: 14px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.12);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.spot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: #4a4a4f;
}

.spot-row select {
  flex: 0 0 auto;
  min-width: 180px;
  font-size: 13px;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid #e2e2e6;
  background: #fafafa;
}

.spot-menu-foot {
  font-size: 12px;
  color: #9a9a9e;
  padding-top: 2px;
}
```

---

## PART 4 — Module C（views 挂 hook）

### 4.1 EDIT `packages/views/cortex-desktop/CortexDesktopView.tsx`

(a) 从 `@cortex-work/core` 的 import 里加入 `useSpotlightIntentRouter`。FIND（import 块内某行）：

```ts
  useCortexUIStore,
  usePersonalStore,
  useWorkspaceId,
} from "@cortex-work/core";
```

REPLACE：

```ts
  useCortexUIStore,
  usePersonalStore,
  useSpotlightIntentRouter,
  useWorkspaceId,
} from "@cortex-work/core";
```

(b) 在组件体内（`const wsId = useWorkspaceId();` 之后）调用 hook：

FIND：

```ts
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
```

REPLACE：

```ts
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const qc = useQueryClient();
  // 始终挂载:接收菜单栏 Spotlight 发起意图,切到个人工作区并暂存待 handoff 消费。
  useSpotlightIntentRouter();
```

### 4.2 EDIT `packages/views/cortex-desktop/personal/PersonalWorkspace.tsx`

(a) import 加 `useSpotlightHandoff`。FIND：

```ts
  usePersonalCliEvents,
  usePersonalPersistence,
  usePersonalStore,
} from "@cortex-work/core";
```

REPLACE：

```ts
  usePersonalCliEvents,
  usePersonalPersistence,
  usePersonalStore,
  useSpotlightHandoff,
} from "@cortex-work/core";
```

(b) 与 cli 事件同处挂载。FIND：

```ts
  usePersonalPersistence();
  usePersonalCliEvents();
```

REPLACE：

```ts
  usePersonalPersistence();
  usePersonalCliEvents();
  // 与 CLI 事件同处挂载:hydrate 后消费 Spotlight 意图,新建会话并发首条消息。
  useSpotlightHandoff();
```

---

## 完成判定（Build/Verify 用）
- `pnpm -C /Users/mike/source/ai/cortex-work-spotlight typecheck` 全绿（含 desktop 的 node+web 两套）。
- `pnpm -C /Users/mike/source/ai/cortex-work-spotlight --filter @cortex-work/desktop build` 成功，且 `apps/desktop/out/renderer/spotlight.html` 存在。
- `pnpm -C /Users/mike/source/ai/cortex-work-spotlight --filter @cortex-work/core test` 通过（含新增 2 个测试文件）。
- 契约一致：`SpotlightIntent` 在 core 与 ipc/types 形状相同；preload 暴露 `spotlight` 命名空间 + `personal.onSpotlightIntent/consumeSpotlightIntent`。
- 无回归：现存 `send(` 调用点全部 ≤4 实参（新参 optional）；`appendSystemPrompt` 合并逻辑保持「项目在前、附件在后、皆空为 undefined」。
