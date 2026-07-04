// Kun store/chat-store 的 compat 镜像 store：design 树把它当「当前设计会话的
// 消息流快照」来读（活跃线程/流式文本/工具块/忙碌态），Kun 里由其 runtime SSE 填充。
// cortex 侧改由 design-run-manager（批7）消费 CliStreamEvent 后写入本镜像——
// 这是设计画布「实时应用 canvas ops / 判断回合进行中」的数据源。
// 仅保留 design 树实际消费的字段与最小 action 面。
import { create } from "zustand";
import type { ChatBlock, NormalizedThread } from "./agent-types";

// 设置页路由分区 id（DesignSidebar 跳设置用；保留 Kun 全集以免联合类型不匹配）。
export type SettingsRouteSection =
  | "general"
  | "providers"
  | "write"
  | "design"
  | "imageGeneration"
  | "mediaGeneration"
  | "speechToText"
  | "agents"
  | "archives"
  | "permissions"
  | "skill"
  | "mcp"
  | "shortcuts"
  | "easterEgg"
  | "claw"
  | "updates"
  | "terminal";

// design 树消费的 chat-store 状态子集（字段形状与 Kun 对齐）。
export interface DesignChatMirrorState {
  threads: NormalizedThread[];
  activeThreadId: string | null;
  // 当前活跃线程的消息块时间线（run-manager 折叠 CliStreamEvent 后写入）。
  blocks: ChatBlock[];
  // 流式中的 assistant 增量文本（尚未落定成 assistant block 的部分）。
  liveAssistant: string;
  busy: boolean;
  currentTurnId: string | null;
  currentTurnUserId: string | null;

  // --- run-manager 写入口（Kun 无此显式 action，SSE reducer 内部写；此处开放给批7） ---
  setThreads: (threads: NormalizedThread[]) => void;
  setActiveThread: (threadId: string | null) => void;
  setBlocks: (blocks: ChatBlock[]) => void;
  appendLiveAssistant: (delta: string) => void;
  beginTurn: (turnId: string, userBlockId: string) => void;
  endTurn: () => void;
  resetMirror: () => void;
}

export const useChatStore = create<DesignChatMirrorState>((set) => ({
  threads: [],
  activeThreadId: null,
  blocks: [],
  liveAssistant: "",
  busy: false,
  currentTurnId: null,
  currentTurnUserId: null,

  setThreads: (threads) => set({ threads }),
  setActiveThread: (activeThreadId) => set({ activeThreadId }),
  setBlocks: (blocks) => set({ blocks }),
  appendLiveAssistant: (delta) => set((s) => ({ liveAssistant: s.liveAssistant + delta })),
  // 开始一个回合：busy 置位并记录 turn/user 块 id（use-apply-shape-ops-live 以此界定回合边界）。
  beginTurn: (turnId, userBlockId) =>
    set({ busy: true, currentTurnId: turnId, currentTurnUserId: userBlockId, liveAssistant: "" }),
  endTurn: () => set({ busy: false, currentTurnId: null, currentTurnUserId: null, liveAssistant: "" }),
  resetMirror: () =>
    set({
      threads: [],
      activeThreadId: null,
      blocks: [],
      liveAssistant: "",
      busy: false,
      currentTurnId: null,
      currentTurnUserId: null,
    }),
}));
