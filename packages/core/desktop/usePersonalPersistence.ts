// 个人工作区持久化 wiring：mount 时从主进程加载 → hydrate store；
// 之后订阅持久化切片（projects/promptRoot/sessions）变更，节流回写主进程。
// 仅在 desktopBridge 存在（桌面端）时生效。

import { useEffect, useRef } from "react";
import { useDesktopBridge } from "../provider";
import { usePersonalStore, toPersistedState, type PersonalState } from "../store/personal";
import { useReplyStore, replyToPersisted, replySaveUrgency } from "../store/reply";
import type { PersistedState } from "./types";

const SAVE_THROTTLE_MS = 500;

export type SaveUrgency = "none" | "immediate" | "throttled";

// 保存紧迫度（纯函数,便于单测）：projects/promptRoot 是主进程 fs 路径白名单的
// 数据源,变更必须立即落盘——否则「添加项目 → 马上扫描目录」会被白名单误拒;
// 其余切片高频变更,维持节流。
export function saveUrgency(s: PersonalState, prev: PersonalState): SaveUrgency {
  if (!s.hydrated) return "none";
  // projects/promptRoot 是 fs 白名单数据源;generalSettings 被主进程消费
  //（workspaceRoot 兜底 cwd、桌面行为）—— 均须立即落盘,避免主进程读到旧值。
  if (
    s.projects !== prev.projects ||
    s.promptRoot !== prev.promptRoot ||
    s.generalSettings !== prev.generalSettings ||
    s.lastActiveProjectId !== prev.lastActiveProjectId // 浮层经主进程 cached 读它,必须立即落盘绕过 500ms 节流
  )
    return "immediate";
  if (
    s.sessions !== prev.sessions ||
    s.todos !== prev.todos ||
    s.timelineSettings !== prev.timelineSettings ||
    s.pushSettings !== prev.pushSettings ||
    s.ttsSettings !== prev.ttsSettings ||
    s.mediaGenSettings !== prev.mediaGenSettings ||
    s.asrSettings !== prev.asrSettings ||
    s.providerSettings !== prev.providerSettings ||
    s.profile !== prev.profile ||
    s.rightPanelWidth !== prev.rightPanelWidth ||
    s.lastAgent !== prev.lastAgent ||
    s.lastModel !== prev.lastModel ||
    s.lastProviderId !== prev.lastProviderId
  )
    return "throttled";
  return "none";
}

export function usePersonalPersistence(): void {
  const bridge = useDesktopBridge();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    // 合并序列化（KTD6 内定「倾向前者」）：个人分片 + reply 三分片同写一份 PersistedState，
    // 复用既有单条 store:save 通道，避免另建独立节流管线。
    const buildPersisted = (): PersistedState => ({
      ...toPersistedState(usePersonalStore.getState()),
      ...replyToPersisted(useReplyStore.getState()),
    });

    // 两个 store 的订阅共用同一节流计时器与保存例程；urgency 由各自的判定函数给出。
    const scheduleSave = (urgency: SaveUrgency): void => {
      if (urgency === "none") return;
      if (timer.current) clearTimeout(timer.current);
      if (urgency === "immediate") {
        // 立即发起保存（含全部切片）,同源 IPC 按序处理,保证先于后续 fs 调用。
        timer.current = null;
        void bridge.saveState(buildPersisted());
        return;
      }
      timer.current = setTimeout(() => {
        void bridge.saveState(buildPersisted());
      }, SAVE_THROTTLE_MS);
    };

    bridge
      .loadState()
      .then(async (state) => {
        if (cancelled) return;
        usePersonalStore.getState().hydrate(state);
        // reply 持久化分片一并 hydrate（缺失/半缺分片由 store 内部补空默认）。
        useReplyStore.getState().hydrateReply(state);
        // 分区记忆缓存装填（KTD6 修订）：真源在 main 侧 memory.json（含首启旧分片迁移），
        // 经 IPC 读入渲染端只读缓存；bridge 无此方法（Web/旧壳）则保持空缓存。
        void bridge
          .replyGetMemory?.()
          .then((memory) => {
            if (!cancelled) useReplyStore.getState().hydrateMemory(memory);
          })
          .catch(() => {});
        // 启动时重扫 prompt 树（不持久化树本身）。
        if (state.promptRoot) {
          try {
            const tree = await bridge.scanPromptTree(state.promptRoot);
            if (!cancelled) usePersonalStore.getState().setPromptTree(tree);
          } catch {
            // 目录可能已被删除/移动，保留 promptRoot 让 UI 提示重新选择。
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          usePersonalStore.getState().hydrate({ version: 1, projects: [], sessions: [] });
          useReplyStore.getState().hydrateReply({});
        }
      });

    const unsubPersonal = usePersonalStore.subscribe((s, prev) => scheduleSave(saveUrgency(s, prev)));
    const unsubReply = useReplyStore.subscribe((s, prev) => scheduleSave(replySaveUrgency(s, prev)));

    // U10 / KTD6 修订：main 蒸馏直写 memory-store 后推全量记忆 → 刷新渲染端只读缓存。
    // 缓存变更不触发保存（replySaveUrgency 不看 memory），持久化真源在 main。
    const unsubMemoryChanged =
      bridge.onReplyMemoryChanged?.((memory) => {
        useReplyStore.getState().hydrateMemory(memory);
      }) ?? (() => {});

    return () => {
      cancelled = true;
      unsubPersonal();
      unsubReply();
      unsubMemoryChanged();
      if (timer.current) {
        clearTimeout(timer.current);
        // 卸载前冲刷一次，避免丢最后一笔变更。
        void bridge.saveState(buildPersisted());
      }
    };
  }, [bridge]);
}
