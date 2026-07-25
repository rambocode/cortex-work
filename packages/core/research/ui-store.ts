// Deep Research 渲染端的 UI 状态 store（模块级 zustand 单例，无需 CoreProvider 参与）。
//
// 为什么是 zustand 而不是 React Query：会话数据的真源在 main 进程（SQLite + 编排器），
// 变更是**由 IPC 事件推送**过来的，不是 HTTP 轮询。React Query 的 staleTime / 重新拉取 /
// 缓存键那套语义在这里没有价值，反而要为每个事件手写 setQueryData。写作（writing）与记忆
// （memory）两块 main-owned 的本地态也是同样的选择，保持一致。
//
// 隐私红线（spec §19.3.2）：本 store 的 sessions 只放 ResearchSessionSummary，**不含任何正文**。
// 证据正文只经 detailCache（bridge.get(id, "evidence") 的结果）按需进入，且只在用户显式展开
// 来源面板时才拉取。渲染列表的代码永远不要去读 detailCache 里的 chunk.text。

import { create } from "zustand";
import { TERMINAL_RESEARCH_STATUSES } from "./session-status";
import type {
  PlannerDecision,
  ResearchEvent,
  ResearchSessionStatus,
  ResearchSessionSummary,
  ResearchSessionView,
  ResearchStage,
} from "./types";

/// 单个会话的实时阶段与进度。它是纯事件派生的运行态，不落持久化，也不属于 summary
/// （summary 只有 status，没有「抓到第几篇」这种瞬时进度）。
export interface ResearchProgress {
  stage: ResearchStage;
  completed?: number;
  total?: number;
}

/// 非终态错误事件的降级展示项（spec §16：terminal:false 的错误不结束会话，UI 应降级为警告）。
export interface ResearchWarning {
  code: string;
  message: string;
}

/// 单会话警告条数上限。长跑的 deep 会话可能产生成百上千条单 URL 抓取失败，
/// 全留在内存里既没人看也白占内存，只保留最近若干条。
const MAX_WARNINGS_PER_SESSION = 50;

/// 终态集合的运行时查表（乱序事件守卫用）。
const TERMINAL: readonly ResearchSessionStatus[] = TERMINAL_RESEARCH_STATUSES;

export interface ResearchUiState {
  /// 会话列表（只含元数据摘要，无正文）。真源是 main，本地只是投影。
  sessions: ResearchSessionSummary[];
  /// 当前选中的会话 id；null 表示未选中（中/右栏展示空态）。
  activeSessionId: string | null;
  /// 按 sessionId 缓存的详情视图（bridge.get 的结果）。evidence 级别只在展开来源时才写入。
  detailCache: Record<string, ResearchSessionView>;
  /// 列表/详情的加载中标记（供左栏骨架态）。
  loading: boolean;
  /// 可展示的加载错误（bridge 调用失败等）；null 表示无错。
  error: string | null;
  /// 事件派生的实时阶段进度，按 sessionId 索引。
  progress: Record<string, ResearchProgress>;
  /// 非终态错误累积的警告，按 sessionId 索引。
  warnings: Record<string, ResearchWarning[]>;
  /// 最近一次 Gap Planner 决策，按 sessionId 索引（供中栏展示「本轮在补搜/补抓/收尾」）。
  lastDecision: Record<string, PlannerDecision["action"]>;

  /// 用 bridge.list() 的结果整体覆盖列表；同时丢弃已不在列表中的会话的派生缓存，防止内存泄漏。
  setSessions: (sessions: ResearchSessionSummary[]) => void;
  /// 选中/取消选中会话。
  selectSession: (sessionId: string | null) => void;
  /// 插入或就地替换一个会话摘要（新建返回、事件刷新均走这里）。
  upsertSession: (summary: ResearchSessionSummary) => void;
  /// 移除会话及其全部派生缓存（删除操作成功后调用）。
  removeSession: (sessionId: string) => void;
  /// 写入详情缓存，并把其中的 summary 回填列表，避免「列表说进行中、详情说已完成」的漂移。
  setDetail: (sessionId: string, view: ResearchSessionView) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /// 把一条 main → renderer 的研究事件落到状态上。未知 sessionId 一律忽略（不凭空造会话）。
  applyEvent: (event: ResearchEvent) => void;
  /// 复位到初始状态（测试与「切换用户/工作区」时用）。
  reset: () => void;
}

/// 从若干 Record 中删掉一批 key，返回新对象（引用变化才能触发订阅方刷新）。
function omitKeys<T>(record: Record<string, T>, shouldDrop: (key: string) => boolean) {
  const next: Record<string, T> = {};
  for (const key of Object.keys(record)) {
    if (!shouldDrop(key)) next[key] = record[key] as T;
  }
  return next;
}

/// 就地替换列表中某个会话；不存在则返回原数组（调用方据此决定是否插入）。
function patchSession(
  sessions: ResearchSessionSummary[],
  sessionId: string,
  patch: (prev: ResearchSessionSummary) => ResearchSessionSummary,
): ResearchSessionSummary[] | null {
  const index = sessions.findIndex((s) => s.sessionId === sessionId);
  if (index < 0) return null;
  const next = sessions.slice();
  next[index] = patch(sessions[index] as ResearchSessionSummary);
  return next;
}

const INITIAL = {
  sessions: [] as ResearchSessionSummary[],
  activeSessionId: null as string | null,
  detailCache: {} as Record<string, ResearchSessionView>,
  loading: false,
  error: null as string | null,
  progress: {} as Record<string, ResearchProgress>,
  warnings: {} as Record<string, ResearchWarning[]>,
  lastDecision: {} as Record<string, PlannerDecision["action"]>,
};

export const useResearchUiStore = create<ResearchUiState>((set) => ({
  ...INITIAL,

  setSessions: (sessions) =>
    set((state) => {
      const alive = new Set(sessions.map((s) => s.sessionId));
      const drop = (key: string) => !alive.has(key);
      return {
        sessions,
        detailCache: omitKeys(state.detailCache, drop),
        progress: omitKeys(state.progress, drop),
        warnings: omitKeys(state.warnings, drop),
        lastDecision: omitKeys(state.lastDecision, drop),
        // 选中的会话若已被服务端删除，回落到未选中，避免中栏指向不存在的 id。
        activeSessionId:
          state.activeSessionId && alive.has(state.activeSessionId) ? state.activeSessionId : null,
      };
    }),

  selectSession: (sessionId) => set({ activeSessionId: sessionId }),

  upsertSession: (summary) =>
    set((state) => {
      const patched = patchSession(state.sessions, summary.sessionId, () => summary);
      // 新会话插到列表头：列表按 updatedAt 倒序，刚创建的一定最新。
      return { sessions: patched ?? [summary, ...state.sessions] };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const drop = (key: string) => key === sessionId;
      return {
        sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
        detailCache: omitKeys(state.detailCache, drop),
        progress: omitKeys(state.progress, drop),
        warnings: omitKeys(state.warnings, drop),
        lastDecision: omitKeys(state.lastDecision, drop),
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
      };
    }),

  setDetail: (sessionId, view) =>
    set((state) => ({
      detailCache: { ...state.detailCache, [sessionId]: view },
      sessions: patchSession(state.sessions, sessionId, () => view.summary) ?? state.sessions,
    })),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  applyEvent: (event) =>
    set((state) => {
      // 事件只描述已存在会话的变化；来自其它窗口/已删除会话的事件直接丢弃。
      if (!state.sessions.some((s) => s.sessionId === event.sessionId)) return {};
      const id = event.sessionId;

      switch (event.type) {
        case "stage": {
          const current = state.sessions.find((s) => s.sessionId === id)?.status;
          // 乱序守卫：done 事件先到、stage 事件后到时，不能把已完成/已取消的会话拉回运行中。
          const stale = current !== undefined && TERMINAL.includes(current);
          return {
            progress: {
              ...state.progress,
              [id]: {
                stage: event.stage,
                completed: event.progress?.completed,
                total: event.progress?.total,
              },
            },
            sessions: stale
              ? state.sessions
              : (patchSession(state.sessions, id, (prev) => ({ ...prev, status: event.stage })) ??
                state.sessions),
          };
        }

        case "round": {
          // roundIndex 是 0 基；取最大值而非直接赋值，防止乱序的旧轮次事件把计数改小。
          const sessions =
            patchSession(state.sessions, id, (prev) => ({
              ...prev,
              roundCount: Math.max(prev.roundCount, event.roundIndex + 1),
            })) ?? state.sessions;
          return {
            sessions,
            lastDecision: event.decision
              ? { ...state.lastDecision, [id]: event.decision }
              : state.lastDecision,
          };
        }

        case "error": {
          // 非终态错误（单 URL 抓取失败等）只是警告：status 与 errorMessage 都不动，
          // 否则一次 404 就会让整个会话在 UI 上显示为失败。
          if (!event.terminal) {
            const prev = state.warnings[id] ?? [];
            const next = [...prev, { code: event.code, message: event.message }].slice(
              -MAX_WARNINGS_PER_SESSION,
            );
            return { warnings: { ...state.warnings, [id]: next } };
          }
          return {
            sessions:
              patchSession(state.sessions, id, (prev) => ({
                ...prev,
                status: "failed",
                errorMessage: event.message,
              })) ?? state.sessions,
          };
        }

        case "done": {
          return {
            sessions:
              patchSession(state.sessions, id, (prev) => ({ ...prev, status: event.status })) ??
              state.sessions,
            // 会话已结束，实时进度失去意义；留着会让 UI 一直显示进度条。
            progress: omitKeys(state.progress, (key) => key === id),
          };
        }
      }
    }),

  reset: () => set({ ...INITIAL }),
}));
