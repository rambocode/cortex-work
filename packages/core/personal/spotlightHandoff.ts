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
