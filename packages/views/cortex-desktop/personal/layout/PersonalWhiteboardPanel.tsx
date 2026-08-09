import { useEffect, useRef } from "react";
import { usePersonalChat, usePersonalStore } from "@cortex-work/core";
import { applyCanvasOpsSince, setLastCanvasOpErrors } from "@cortex-work/core/design/canvas/apply-shape-ops";
import { useCanvasSelectionStore } from "@cortex-work/core/design/canvas/canvas-selection-store";
import { codeCanvasErrorKey } from "@cortex-work/core/design/canvas/code-canvas";
import { CodeCanvasPanel } from "../../design/canvas/CodeCanvasPanel";

/**
 * 把个人会话消息流接到 Kun 同源 CodeCanvasPanel。画布引擎负责手动画图和落盘；本层只负责
 * 当前 run 的 `design_canvas`/`shapeops` 流式回放，并按 sessionId 做 exactly-once 隔离。
 */
export function PersonalWhiteboardPanel({
  sessionId,
  workspaceRoot,
  onCollapse,
}: {
  sessionId: string;
  workspaceRoot: string;
  onCollapse: () => void;
}) {
  const { allMessages } = usePersonalChat(sessionId);
  const runningId = usePersonalStore((state) => state.runningBySession[sessionId]);
  const trackedRunRef = useRef<string | null>(null);
  const appliedCountRef = useRef(0);

  useEffect(() => {
    if (runningId && trackedRunRef.current !== runningId) {
      trackedRunRef.current = runningId;
      appliedCountRef.current = 0;
    }
    if (!trackedRunRef.current) return;

    // 当前回合从最后一条用户消息开始；主 agent 可能把正文拆成多段，拼接后再按 block 游标执行。
    let userIndex = -1;
    for (let index = allMessages.length - 1; index >= 0; index -= 1) {
      const message = allMessages[index];
      if (message?.kind === "text" && message.who === "me") {
        userIndex = index;
        break;
      }
    }
    const assistantText = allMessages
      .slice(userIndex + 1)
      .filter((message) => message.kind === "text" && message.who !== "me" && typeof message.text === "string")
      .map((message) => (message.kind === "text" ? String(message.text) : ""))
      .join("\n");
    const result = applyCanvasOpsSince(assistantText, appliedCountRef.current, {
      screenFallback: "plain-frame",
      lintFeedbackKey: codeCanvasErrorKey(sessionId),
    });
    appliedCountRef.current = result.totalBlocks;
    if (result.errors.length > 0) setLastCanvasOpErrors(result.errors, codeCanvasErrorKey(sessionId));
    if (result.affectedIds.length > 0) useCanvasSelectionStore.getState().select(result.affectedIds);

    // running 清除与最后一批正文通常同一批提交；上面的 final pass 完成后才能清游标。
    if (!runningId) {
      trackedRunRef.current = null;
      appliedCountRef.current = 0;
    }
  }, [allMessages, runningId, sessionId]);

  return (
    <CodeCanvasPanel
      workspaceRoot={workspaceRoot}
      activeThreadId={sessionId}
      onCollapse={onCollapse}
      className="pw-code-canvas h-full"
    />
  );
}
