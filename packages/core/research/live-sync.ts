// 研究事件的**唯一常驻订阅点**，挂在 PersonalWorkspace，与右栏面板开合无关。
//
// **红线：applyEvent 每个事件只能被调用一次，任何其它组件不得再调它。**
// ui-store 的 applyEvent 里，report_delta 是增量拼接、activity 是环形追加，**都不是幂等的**——
// 同一条事件扇出两次，报告正文就会翻倍、流水就会出现重影。所以订阅只能有这一处，
// 右栏研究面板之类的消费者只允许读 store、或者自己订阅 onEvent 做防抖重拉详情，
// 绝不允许再调 applyEvent。
//
// **为什么必须常驻**：研究是分钟级长任务，而事件流是补不回来的增量。订阅一旦挂在会随
// 界面开合而卸载的组件上（历史上挂在研究整窗覆盖层里），用户切走再切回，这段时间的
// report_delta 就永久丢失了——重拉详情只能拿到落库的最终稿，拿不回中途的草稿与流水。
//
// **订阅必须先于 list()**：反过来（先拿快照再订阅）会漏掉这段窗口期内到达的事件。
// list() 的快照本身也不可省：用户可能从 agent 的 deep_research 工具发起研究，
// 那些在订阅之前就已经在跑的会话只有靠这一次快照才能进入列表。
//
// 相关文件：完整 UI 状态见 ./ui-store；侧栏角标与完成通知的最小状态见 ./background-watch。
import { useEffect } from "react";

import { useResearchBackgroundStore } from "./background-watch";
import { useResearchUiStore } from "./ui-store";
import type { ResearchEvent, ResearchSessionSummary } from "./types";

/// 常驻同步所需的最小桥面。收窄到两个方法，让宿主与测试都能传手写替身。
export interface ResearchLiveSyncBridge {
  list(): Promise<ResearchSessionSummary[]>;
  /// 订阅 main 推来的研究事件；**返回值是退订函数，卸载时必须调用**。
  onEvent(listener: (event: ResearchEvent) => void): () => void;
}

/// 统一的错误消息提取（Error / 任意抛出物都能变成一句可展示的话）。
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// 研究事件与会话列表的常驻同步。**只在个人工作区根组件挂一次**。
///
/// enabled 为 false（研究引擎未开启 / 深度研究未开启 / 无桥）时不订阅也不 list：
/// 绝大多数用户没开这个功能，不该为此在每次启动时多打一次 IPC。
export function useResearchLiveSync(
  bridge: ResearchLiveSyncBridge | null | undefined,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!bridge || !enabled) return;
    let alive = true;

    // 先订阅再拉列表：顺序是硬约束，见文件头。
    const off = bridge.onEvent((event) => {
      // 一个事件、两个 store，各扇出恰好一次。ui-store 管完整展示状态，
      // background store 只管「还有几个在跑 / 刚有哪个跑完」这两件小事。
      useResearchUiStore.getState().applyEvent(event);
      useResearchBackgroundStore.getState().apply(event);
    });

    useResearchUiStore.getState().setLoading(true);
    useResearchUiStore.getState().setError(null);
    void bridge
      .list()
      .then((sessions) => {
        if (!alive) return;
        useResearchUiStore.getState().setSessions(sessions);
        useResearchBackgroundStore.getState().seed(sessions);
      })
      // 播种失败不影响订阅：事件照样能把后续状态补上，只是列表起始值缺失。
      .catch((e: unknown) => {
        if (!alive) return;
        useResearchUiStore.getState().setError(`加载研究列表失败：${errText(e)}`);
      })
      .finally(() => {
        if (alive) useResearchUiStore.getState().setLoading(false);
      });

    return () => {
      alive = false;
      off();
    };
  }, [bridge, enabled]);
}
