// 写作助手会话索引(U8):按空间管理会话元数据(id/title/spaceId/resumeSessionId),持久化经
// PersistedState.writingUi 分片(WritingUiState.threads / activeThreadBySpace)。消息本体不在此,
// 走 run-manager 的内存镜像(useWritingRunStore);重启后靠 resumeSessionId 让 agent 续上下文。
//
// 与 run-manager 的分工:run-manager 的 resumeByThread 是「发送时用的运行态真源」(从 init 事件捕获);
// 本 store 只做「可持久化的会话目录」——两者按 threadId 对齐。hydrate 时把持久化的 resumeSessionId
// 回灌进 run-manager(setResumeSessionId),使重启后首轮仍能 resume。
import { create } from "zustand";
import type { WritingThreadMeta, WritingUiState } from "../desktop/writing-types";
import { setResumeSessionId as installResumeIntoRunManager } from "./run/writing-run-manager";

// 会话索引的持久化分片:WritingUiState 中与会话相关的两字段(空间列表分片由 spaces store 负责)。
export type WritingThreadsPersisted = Pick<WritingUiState, "threads" | "activeThreadBySpace">;

// 生成稳定 threadUuid(core 跨端,不依赖 crypto.randomUUID):时间戳 + 单调序号 + 随机尾。
let idSeq = 0;
function genThreadId(): string {
  return `wt-${Date.now().toString(36)}-${(idSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// 由用户正文派生会话标题:取首行、截断到 24 字;空则回落默认名。
export function deriveThreadTitle(input: string): string {
  const firstLine = input.trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "新会话";
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

export interface WritingThreadsState {
  // 全部会话(扁平列表,按 spaceId 归属;跨空间共存)。
  threads: WritingThreadMeta[];
  // 每空间最后活跃会话 id(重进恢复)。
  activeThreadBySpace: Record<string, string | null>;

  // 取某空间的会话列表(按 updatedAt 倒序,最近的在前)。
  threadsForSpace: (spaceId: string) => WritingThreadMeta[];
  // 取某空间当前活跃会话 id(无则 null)。
  activeThreadId: (spaceId: string) => string | null;
  // 新建会话:生成新 threadUuid,置为该空间活跃会话,返回新会话。
  createThread: (spaceId: string, title?: string) => WritingThreadMeta;
  // 确保某空间有活跃会话:已有则返回,否则新建一个默认会话。
  ensureActiveThread: (spaceId: string) => WritingThreadMeta;
  // 切换某空间活跃会话(id 不属于该空间时忽略)。
  setActiveThread: (spaceId: string, threadId: string) => void;
  // 更新会话标题(找不到则忽略)。
  setThreadTitle: (threadId: string, title: string) => void;
  // 更新会话续接 id(run-manager 捕获到 agent 真实 sessionId 后,面板据此同步进持久化目录)。
  setThreadResume: (threadId: string, resumeSessionId: string) => void;
  // 移除某空间的全部会话(空间被删时清理),并清其活跃指针。
  removeThreadsForSpace: (spaceId: string) => void;
  // 序列化为持久化分片 / 从分片回灌(hydrate 时把 resumeSessionId 回灌 run-manager)。
  serialize: () => WritingThreadsPersisted;
  hydrate: (state: WritingThreadsPersisted | undefined | null) => void;
}

export const useWritingThreadsStore = create<WritingThreadsState>((set, get) => ({
  threads: [],
  activeThreadBySpace: {},

  threadsForSpace: (spaceId) =>
    get()
      .threads.filter((t) => t.spaceId === spaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt),

  activeThreadId: (spaceId) => get().activeThreadBySpace[spaceId] ?? null,

  createThread: (spaceId, title) => {
    const now = Date.now();
    const thread: WritingThreadMeta = {
      id: genThreadId(),
      title: title?.trim() || "新会话",
      spaceId,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({
      threads: [...s.threads, thread],
      activeThreadBySpace: { ...s.activeThreadBySpace, [spaceId]: thread.id },
    }));
    return thread;
  },

  ensureActiveThread: (spaceId) => {
    const activeId = get().activeThreadBySpace[spaceId];
    const existing = activeId ? get().threads.find((t) => t.id === activeId) : undefined;
    if (existing) return existing;
    // 无活跃会话:若该空间已有会话取最近的,否则新建。
    const forSpace = get().threadsForSpace(spaceId);
    if (forSpace[0]) {
      set((s) => ({ activeThreadBySpace: { ...s.activeThreadBySpace, [spaceId]: forSpace[0]!.id } }));
      return forSpace[0]!;
    }
    return get().createThread(spaceId);
  },

  setActiveThread: (spaceId, threadId) =>
    set((s) => {
      // 防御:只接受属于该空间的会话 id,避免活跃指针指向别空间的会话。
      if (!s.threads.some((t) => t.id === threadId && t.spaceId === spaceId)) return {};
      return { activeThreadBySpace: { ...s.activeThreadBySpace, [spaceId]: threadId } };
    }),

  setThreadTitle: (threadId, title) =>
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, title: title.trim() || t.title, updatedAt: Date.now() } : t,
      ),
    })),

  setThreadResume: (threadId, resumeSessionId) =>
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, resumeSessionId, updatedAt: Date.now() } : t,
      ),
    })),

  removeThreadsForSpace: (spaceId) =>
    set((s) => {
      const threads = s.threads.filter((t) => t.spaceId !== spaceId);
      const activeThreadBySpace = { ...s.activeThreadBySpace };
      delete activeThreadBySpace[spaceId];
      return { threads, activeThreadBySpace };
    }),

  serialize: () => {
    const s = get();
    return { threads: s.threads, activeThreadBySpace: s.activeThreadBySpace };
  },

  hydrate: (state) => {
    const threads = state?.threads ?? [];
    set({
      threads,
      activeThreadBySpace: state?.activeThreadBySpace ?? {},
    });
    // 关键:把持久化的 resumeSessionId 回灌 run-manager,使重启后首轮仍能续接该 agent 会话。
    for (const t of threads) {
      if (t.resumeSessionId) installResumeIntoRunManager(t.id, t.resumeSessionId);
    }
  },
}));

// 测试专用:复位会话索引(避免用例间串扰)。
export function __resetWritingThreadsForTest(): void {
  useWritingThreadsStore.setState({ threads: [], activeThreadBySpace: {} });
}
