// artifacts 工具的专属步骤渲染:「📄 创建产物 chart.html」可点击 pill,点击经
// usePiArtifactsStore.requestOpen 请求打开右栏产物面板（PersonalWorkspace 的 effect 消费）。
// detail 形如「创建产物 chart.html」(messages.ts 的 artifact 分支拼装);store 里查不到该
// 产物(已删/会话已清)时回退默认渲染,不出死按钮。

import React from "react";
import { usePersonalStore } from "@cortex-work/core";
import { usePiArtifactsStore } from "@cortex-work/core/store/piArtifacts";
import { Icon } from "@cortex-work/ui/icons";

import type { ToolStepRendererProps } from "./registry";

/** 从 detail 文案里取文件名(最后一个空格后的 token)。 */
function filenameFromDetail(detail: string | undefined): string | undefined {
  const name = detail?.trim().split(" ").pop();
  return name && name.includes(".") ? name : undefined;
}

export function ArtifactStepCard({ item, fallback }: ToolStepRendererProps): React.ReactNode {
  const sessionId = usePersonalStore((s) => s.activeSessionId);
  const filename = filenameFromDetail(item.detail);
  const exists = usePiArtifactsStore((s) => !!(sessionId && filename && s.sessions[sessionId]?.byName[filename]));
  const requestOpen = usePiArtifactsStore((s) => s.requestOpen);
  if (!sessionId || !filename || !exists) return fallback;
  return (
    <button
      type="button"
      className="pw-pa-step"
      title="在侧栏查看产物"
      onClick={() => requestOpen(sessionId, filename)}
    >
      <Icon.FileText size={12} />
      <span>{item.detail}</span>
    </button>
  );
}
