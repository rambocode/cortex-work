// 会话回合结束 → 重扫设计稿目录,把 agent 这一轮写出来的屏幕搬上画布。
//
// **为什么需要**:设计产物没有任何写盘推送(slides 有 deckChanged 事件,design 没有)。
// 目录扫描只在面板挂载时的 loadDesignSettings 里跑过一次,agent 之后写的文件不会自己出现——
// 用户看到 agent 说「已生成」,画布却还是空的,只能关掉面板重开(实测)。
//
// 用会话的 running 状态当刷新信号:agent 这一轮跑完了,盘上就是最终态。
// rehydrateArtifacts 是增量合并(保留内存里的文稿与当前选中项,只补盘上新出现的产物),
// 所以按轮重放是安全的。
import { useEffect, useRef } from "react";
import type { ConversationArtifactRef } from "@cortex-work/core";
import { useDesignWorkspaceStore } from "@cortex-work/core/design/design-workspace-store";
import { usePersonalStore } from "@cortex-work/core/store/personal";

export function useDesignArtifactAutoRefresh(artifact: ConversationArtifactRef): void {
  const sessionId = usePersonalStore((s) => s.activeSessionId);
  const running = usePersonalStore((s) => (sessionId ? s.runningBySession[sessionId] : undefined));
  // 只在「跑过一轮之后」刷:面板刚挂载时 loadDesignSettings 已经扫过一次,
  // 没这个门闩会白扫一遍整个工作区目录。
  const ranRef = useRef(false);

  useEffect(() => {
    if (artifact.kind !== "design") return;
    if (running) {
      ranRef.current = true;
      return;
    }
    if (!ranRef.current) return;
    ranRef.current = false;
    void useDesignWorkspaceStore.getState().rehydrateArtifacts();
  }, [artifact.kind, running]);
}
