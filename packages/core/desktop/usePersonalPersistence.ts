// 个人工作区持久化 wiring：mount 时从主进程加载 → hydrate store；
// 之后订阅持久化切片（projects/promptRoot/sessions）变更，节流回写主进程。
// 仅在 desktopBridge 存在（桌面端）时生效。

import { useEffect, useRef } from "react";
import { useDesktopBridge } from "../provider";
import { usePersonalStore, toPersistedState } from "../store/personal";

const SAVE_THROTTLE_MS = 500;

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
      if (!s.hydrated) return;
      if (
        s.projects === prev.projects &&
        s.promptRoot === prev.promptRoot &&
        s.sessions === prev.sessions &&
        s.timelineSettings === prev.timelineSettings &&
        s.pushSettings === prev.pushSettings
      )
        return;
      if (timer.current) clearTimeout(timer.current);
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
