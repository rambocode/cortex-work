// 研究会话的后台观察：让研究不必守在整窗覆盖层里。
//
// **要解决的问题**：研究是分钟级的长任务，而它的 UI 是一个互斥整窗覆盖层——用户一旦切走去
// 聊天或写作，就完全看不到它跑到哪了、什么时候完事。主进程侧其实早就支持后台跑
// （覆盖层卸载不中断编排），缺的只是「切走之后还能知道进度」这一层。
//
// **为什么不复用 ui-store**：那个 store 的事件订阅与 list() 都发生在 ResearchWorkspace 挂载时，
// 覆盖层一关就断供。这里需要的是一个**始终在线**的订阅（挂在常驻的工作区根组件上），
// 只跟踪两件极小的事：还有几个在跑、刚有哪个跑完了。
//
// 相关文件：覆盖层内部的完整状态见 ./ui-store；事件类型见 ./types。
import { useEffect } from "react";
import { create } from "zustand";

import { NON_TERMINAL_RESEARCH_STATUSES } from "./session-status";
import type { ResearchEvent, ResearchSessionStatus, ResearchSessionSummary } from "./types";

/// 一次刚刚结束的研究，供宿主弹一次通知。**消费后必须调 clearFinished 清掉**，
/// 否则每次组件重渲染都会再弹一次。
export interface FinishedResearch {
  sessionId: string;
  objective: string;
  status: ResearchSessionStatus;
}

interface ResearchBackgroundState {
  /// sessionId → 该会话当前是否处于非终态。用 Record 而非计数器：
  /// 事件可能重复到达（同一状态推两次），计数器会越加越多，而按 id 覆盖写天然幂等。
  running: Record<string, true>;
  /// 待展示的完成通知队列。
  finished: FinishedResearch[];
  /// sessionId → 研究目标，用于完成通知的文案（事件里不带目标原文）。
  objectives: Record<string, string>;

  seed: (sessions: readonly ResearchSessionSummary[]) => void;
  apply: (event: ResearchEvent) => void;
  /// 取走一条完成通知（宿主弹完 toast 后调用）。
  clearFinished: (sessionId: string) => void;
  reset: () => void;
}

const INITIAL = {
  running: {} as Record<string, true>,
  finished: [] as FinishedResearch[],
  objectives: {} as Record<string, string>,
};

/// 是否是非终态（还在跑）。
function isRunning(status: ResearchSessionStatus): boolean {
  return (NON_TERMINAL_RESEARCH_STATUSES as readonly string[]).includes(status);
}

export const useResearchBackgroundStore = create<ResearchBackgroundState>((set) => ({
  ...INITIAL,

  /// 用 list() 的结果播种。**只播种不清空**：list() 是一次快照，
  /// 而事件流可能已经先一步把某个会话标成结束了，用快照整体覆盖会让它复活。
  seed: (sessions) =>
    set((state) => {
      const running = { ...state.running };
      const objectives = { ...state.objectives };
      for (const session of sessions) {
        objectives[session.sessionId] = session.objective;
        if (isRunning(session.status)) running[session.sessionId] = true;
        else delete running[session.sessionId];
      }
      return { running, objectives };
    }),

  apply: (event) =>
    set((state) => {
      if (event.type === "status") {
        const running = { ...state.running };
        if (isRunning(event.status)) running[event.sessionId] = true;
        else delete running[event.sessionId];
        return { running };
      }
      if (event.type === "done") {
        const running = { ...state.running };
        delete running[event.sessionId];
        // 同一 sessionId 只排一条：done 事件在极端情况下可能重发（重试路径），
        // 不去重的话用户会连着看到两条一模一样的通知。
        const finished = state.finished.some((item) => item.sessionId === event.sessionId)
          ? state.finished
          : [
              ...state.finished,
              {
                sessionId: event.sessionId,
                objective: state.objectives[event.sessionId] ?? "",
                status: event.status,
              },
            ];
        return { running, finished };
      }
      return {};
    }),

  clearFinished: (sessionId) =>
    set((state) => ({ finished: state.finished.filter((item) => item.sessionId !== sessionId) })),

  reset: () => set({ ...INITIAL }),
}));

/// 在跑的研究数量（侧栏角标用）。
export function useRunningResearchCount(): number {
  return useResearchBackgroundStore((s) => Object.keys(s.running).length);
}

/// 观察者所需的最小桥面。收窄到两个方法，让宿主与测试都能传手写替身。
export interface ResearchWatchBridge {
  list(): Promise<ResearchSessionSummary[]>;
  onEvent(listener: (event: ResearchEvent) => void): () => void;
}

/// 挂在**常驻**组件上的观察 hook（个人工作区根组件），而不是研究覆盖层——
/// 挂在覆盖层上就等于没做，那正是本模块要解决的问题。
///
/// enabled 为 false（研究引擎未开启 / 无桥）时不订阅也不 list：
/// 绝大多数用户没开这个功能，不该为此在每次启动时多打一次 IPC。
export function useResearchBackgroundWatch(
  bridge: ResearchWatchBridge | null | undefined,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!bridge || !enabled) return;
    let disposed = false;

    // 播种：覆盖层从没打开过时（用户从 agent 的 deep_research 工具发起研究），
    // 事件订阅之前就已经在跑的会话只能靠这一次快照拿到。
    void bridge
      .list()
      .then((sessions) => {
        if (!disposed) useResearchBackgroundStore.getState().seed(sessions);
      })
      // 播种失败不影响订阅：事件照样能把后续状态补上，角标只是起始值不准。
      .catch(() => {});

    const off = bridge.onEvent((event) => useResearchBackgroundStore.getState().apply(event));
    return () => {
      disposed = true;
      off();
    };
  }, [bridge, enabled]);
}
