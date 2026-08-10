import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktopBridge, usePersonalChat, usePersonalStore } from "@cortex-work/core";
import { applyCanvasOpsSince, setLastCanvasOpErrors } from "@cortex-work/core/design/canvas/apply-shape-ops";
import { useCanvasSelectionStore } from "@cortex-work/core/design/canvas/canvas-selection-store";
import { codeCanvasErrorKey } from "@cortex-work/core/design/canvas/code-canvas";
import { useTranslation } from "@cortex-work/core/i18n";
import { CodeCanvasPanel } from "../../design/canvas/CodeCanvasPanel";
import { createWhiteboardFilePort } from "../whiteboard/file-port";
import { ensureWhiteboardWorkspaceRoot } from "../whiteboard/workspace";

/**
 * 把个人会话消息流接到借鉴 Kun 交互的 CodeCanvasPanel。画布引擎负责手动画图和落盘；
 * Cortex DesktopBridge 负责文件能力，本层同时处理当前 run 的 `design_canvas`/`shapeops`
 * 流式回放，并按 sessionId 做 exactly-once 隔离。
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
  const { t } = useTranslation("design");
  const bridge = useDesktopBridge();
  const { allMessages } = usePersonalChat(sessionId);
  const session = usePersonalStore((state) => state.sessions.find((item) => item.id === sessionId));
  const updateSession = usePersonalStore((state) => state.updateSession);
  const runningId = usePersonalStore((state) => state.runningBySession[sessionId]);
  const trackedRunRef = useRef<string | null>(null);
  const appliedCountRef = useRef(0);
  const filePort = useMemo(() => createWhiteboardFilePort(bridge), [bridge]);
  // null 表示已尝试但不可用；undefined 表示仍在解析。按 sessionId 缓存，切会话时绝不短暂
  // 用上一条会话的目录加载新 canvas 文档。
  const [fallbackRoots, setFallbackRoots] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (workspaceRoot.trim()) return;
    if (!session) {
      setFallbackRoots((current) => ({ ...current, [sessionId]: null }));
      return;
    }
    let cancelled = false;
    void ensureWhiteboardWorkspaceRoot({ session, workspaceRoot, bridge, updateSession }).then((root) => {
      if (!cancelled) {
        setFallbackRoots((current) => ({ ...current, [sessionId]: root || null }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, session, sessionId, updateSession, workspaceRoot]);

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

  const resolvedWorkspaceRoot = workspaceRoot.trim() || fallbackRoots[sessionId];
  if (resolvedWorkspaceRoot === undefined) {
    return (
      <div className="pw-code-canvas pw-canvas-loading" role="status">
        {t("designCanvasLoading")}
      </div>
    );
  }

  return (
    <CodeCanvasPanel
      workspaceRoot={resolvedWorkspaceRoot ?? ""}
      activeThreadId={sessionId}
      onCollapse={onCollapse}
      className="pw-code-canvas h-full"
      filePort={filePort ?? undefined}
    />
  );
}
