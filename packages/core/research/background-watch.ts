// 研究会话的后台观察：让研究不必守在研究界面里。
//
// **要解决的问题**：研究是分钟级的长任务，用户一旦切走去聊天或写作，就完全看不到它跑到
// 哪了、什么时候完事。主进程侧其实早就支持后台跑（界面卸载不中断编排），缺的只是
// 「切走之后还能知道进度」这一层。
//
// **为什么不复用 ui-store**：这里只跟踪两件极小的事——还有几个在跑、刚有哪个跑完了，
// 供侧栏角标与完成通知使用，不关心报告草稿、流水这些只有研究界面才看的状态。
//
// 相关文件：完整展示状态见 ./ui-store；喂给本 store 的常驻订阅见 ./live-sync；事件类型见 ./types。
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

// 本模块**不再自己订阅事件**：seed / apply 由 ./live-sync 的 useResearchLiveSync 统一驱动。
// 两处各订阅一次曾是可行的（这里只看 status / done，都是幂等的），但两份订阅意味着两条
// 生命周期与两次 list() IPC，而且很容易被后人照抄到 applyEvent 上——那条路径非幂等，
// 扇出两次报告就翻倍。收成一处订阅、一处扇出，是唯一不会出错的形状。
