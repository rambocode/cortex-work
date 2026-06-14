// 个人工作区持久化 wiring：mount 时从主进程加载 → hydrate store；
// 之后订阅持久化切片（projects/promptRoot/sessions）变更，节流回写主进程。
// 仅在 desktopBridge 存在（桌面端）时生效。

import { useEffect, useRef } from "react";
import { useDesktopBridge } from "../provider";
import { usePersonalStore, toPersistedState, type PersonalState } from "../store/personal";

const SAVE_THROTTLE_MS = 500;

export type SaveUrgency = "none" | "immediate" | "throttled";

// 保存紧迫度（纯函数,便于单测）：projects/promptRoot 是主进程 fs 路径白名单的
// 数据源,变更必须立即落盘——否则「添加项目 → 马上扫描目录」会被白名单误拒;
// 其余切片高频变更,维持节流。
export function saveUrgency(s: PersonalState, prev: PersonalState): SaveUrgency {
  if (!s.hydrated) return "none";
  if (s.projects !== prev.projects || s.promptRoot !== prev.promptRoot) return "immediate";
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
  return "none";
}

export function usePersonalPersistence(): void {
  const bridge = useDesktopBridge();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    bridge
      .loadState()
      .then(async (state) => {
        if (cancelled) return;
        usePersonalStore.getState().hydrate(state);
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
        if (!cancelled) usePersonalStore.getState().hydrate({ version: 1, projects: [], sessions: [] });
      });

    const unsub = usePersonalStore.subscribe((s, prev) => {
      const urgency = saveUrgency(s, prev);
      if (urgency === "none") return;
      if (timer.current) clearTimeout(timer.current);
      if (urgency === "immediate") {
        // 立即发起保存（含全部切片）,同源 IPC 按序处理,保证先于后续 fs 调用。
        timer.current = null;
        void bridge.saveState(toPersistedState(usePersonalStore.getState()));
        return;
      }
      timer.current = setTimeout(() => {
        void bridge.saveState(toPersistedState(usePersonalStore.getState()));
      }, SAVE_THROTTLE_MS);
    });

    return () => {
      cancelled = true;
      unsub();
      if (timer.current) {
        clearTimeout(timer.current);
        // 卸载前冲刷一次，避免丢最后一笔变更。
        void bridge.saveState(toPersistedState(usePersonalStore.getState()));
      }
    };
  }, [bridge]);
}
