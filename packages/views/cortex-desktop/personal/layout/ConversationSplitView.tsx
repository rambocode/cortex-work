// 会话拆分容器：把侧栏会话拖到任一会话窗格的上、下、左、右，即在该方向局部拆分。
// 布局使用瞬态二叉树，不写入 personal 持久化；重启后不恢复可能已经删除或归档的陈旧窗格。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import type { SessionMeta } from "@cortex-work/core";
import { PersonalChatArea } from "../chat/PersonalChatArea";
import {
  collectPaneIds,
  createPane,
  hasPane,
  insertPane,
  pruneLayout,
  removePane,
  replacePane,
} from "./conversation-layout";
import type { ConversationLayout } from "./conversation-layout";
import { resolveSessionDropPlacement, SESSION_DRAG_MIME } from "./conversation-drag";
import type { SessionDropPlacement } from "./conversation-drag";

const DROP_LABELS: Record<SessionDropPlacement, string> = {
  top: "上方",
  right: "右侧",
  bottom: "下方",
  left: "左侧",
};

type DropTarget = {
  sessionId: string;
  placement: SessionDropPlacement;
};

type PaneEventHandlers = {
  onActivate: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onDragPosition: (event: React.DragEvent<HTMLElement>, sessionId: string) => void;
  onDragExit: (event: React.DragEvent<HTMLElement>, sessionId: string) => void;
  onDrop: (event: React.DragEvent<HTMLElement>, sessionId: string) => void;
};

function hasSessionDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(SESSION_DRAG_MIME);
}

function ConversationDropTarget({ placement }: { placement: SessionDropPlacement }) {
  return (
    <div className={`pw-session-drop-target is-${placement}`} role="status">
      <Icon.Split size={22} />
      <strong>在{DROP_LABELS[placement]}拆分会话</strong>
      <span>松开即可放置</span>
    </div>
  );
}

function ConversationPane({
  session,
  active,
  showHeader,
  dropPlacement,
  onToast,
  handlers,
}: {
  session: SessionMeta;
  active: boolean;
  showHeader: boolean;
  dropPlacement?: SessionDropPlacement;
  onToast: (text: string) => void;
  handlers: PaneEventHandlers;
}) {
  const Tag = showHeader ? "section" : "div";
  return (
    <Tag
      className={`${showHeader ? "pw-conversation-pane" : "pw-conversation-single"} ${active ? "is-active" : ""}`}
      data-session-id={session.id}
      data-testid={showHeader ? undefined : "conversation-single-pane"}
      onPointerDownCapture={() => handlers.onActivate(session.id)}
      onFocusCapture={() => handlers.onActivate(session.id)}
      onDragEnter={(event) => handlers.onDragPosition(event, session.id)}
      onDragOver={(event) => handlers.onDragPosition(event, session.id)}
      onDragLeave={(event) => handlers.onDragExit(event, session.id)}
      onDrop={(event) => handlers.onDrop(event, session.id)}
    >
      {showHeader ? (
        <div className="pw-split-pane-head">
          <span className="pw-split-pane-dot" aria-hidden="true" />
          <strong title={session.title}>{session.title}</strong>
          <button
            type="button"
            className="pw-icon-btn"
            aria-label={`关闭 ${session.title} 窗格`}
            title="关闭拆分窗格"
            onClick={() => handlers.onClose(session.id)}
          >
            <Icon.X size={12} />
          </button>
        </div>
      ) : null}
      <PersonalChatArea sessionId={session.id} onToast={onToast} />
      {dropPlacement ? <ConversationDropTarget placement={dropPlacement} /> : null}
    </Tag>
  );
}

function ConversationLayoutNode({
  layout,
  sessionsById,
  activeSessionId,
  dropTarget,
  onToast,
  handlers,
}: {
  layout: ConversationLayout;
  sessionsById: ReadonlyMap<string, SessionMeta>;
  activeSessionId: string | undefined;
  dropTarget: DropTarget | null;
  onToast: (text: string) => void;
  handlers: PaneEventHandlers;
}) {
  if (layout.kind === "pane") {
    const session = sessionsById.get(layout.sessionId);
    if (!session) return null;
    return (
      <ConversationPane
        session={session}
        active={session.id === activeSessionId}
        showHeader
        dropPlacement={dropTarget?.sessionId === session.id ? dropTarget.placement : undefined}
        onToast={onToast}
        handlers={handlers}
      />
    );
  }

  return (
    <div
      className={`pw-conversation-branch is-${layout.axis}`}
      data-split-axis={layout.axis}
      style={{ minWidth: layout.columns * 320, minHeight: layout.rows * 240 }}
    >
      <ConversationLayoutNode
        layout={layout.first}
        sessionsById={sessionsById}
        activeSessionId={activeSessionId}
        dropTarget={dropTarget}
        onToast={onToast}
        handlers={handlers}
      />
      <ConversationLayoutNode
        layout={layout.second}
        sessionsById={sessionsById}
        activeSessionId={activeSessionId}
        dropTarget={dropTarget}
        onToast={onToast}
        handlers={handlers}
      />
    </div>
  );
}

export function ConversationSplitView({ onToast }: { onToast: (text: string) => void }) {
  const sessions = usePersonalStore((state) => state.sessions);
  const activeSessionId = usePersonalStore((state) => state.activeSessionId);
  const setActiveSession = usePersonalStore((state) => state.setActiveSession);
  const [layout, setLayout] = useState<ConversationLayout | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // 侧栏点击仍走全局 setActiveSession；ref 记录最后聚焦叶子，避免 transient focus 额外触发渲染。
  const activePaneRef = useRef(activeSessionId);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  useEffect(() => {
    if (!layout) {
      activePaneRef.current = activeSessionId;
      return;
    }
    const nextLayout = pruneLayout(layout, new Set(sessionsById.keys()));
    if (nextLayout === layout) return;

    const remainingIds = nextLayout ? collectPaneIds(nextLayout) : [];
    setLayout(remainingIds.length >= 2 ? nextLayout : null);
    if (activeSessionId && remainingIds.includes(activeSessionId)) {
      activePaneRef.current = activeSessionId;
      return;
    }
    const fallbackSessionId = remainingIds[0];
    activePaneRef.current = fallbackSessionId;
    if (fallbackSessionId) setActiveSession(fallbackSessionId);
  }, [activeSessionId, layout, sessionsById, setActiveSession]);

  useEffect(() => {
    if (!layout || !activeSessionId) return;
    if (hasPane(layout, activeSessionId)) {
      activePaneRef.current = activeSessionId;
      return;
    }

    // 拆分后从侧栏选择新会话时，只替换最后聚焦叶子；若目标已在布局里，上方分支只聚焦。
    const targetSessionId = activePaneRef.current;
    if (!targetSessionId) return;
    setLayout((current) => (current ? replacePane(current, targetSessionId, activeSessionId) : current));
    activePaneRef.current = activeSessionId;
  }, [activeSessionId, layout]);

  const activatePane = useCallback(
    (sessionId: string) => {
      activePaneRef.current = sessionId;
      if (activeSessionId !== sessionId) setActiveSession(sessionId);
    },
    [activeSessionId, setActiveSession],
  );

  const closePane = useCallback(
    (sessionId: string) => {
      if (!layout) return;
      const currentIds = collectPaneIds(layout);
      const closingIndex = currentIds.indexOf(sessionId);
      const nextLayout = removePane(layout, sessionId);
      const remainingIds = nextLayout ? collectPaneIds(nextLayout) : [];
      setLayout(remainingIds.length >= 2 ? nextLayout : null);

      if (sessionId === activeSessionId) {
        const fallbackSessionId = remainingIds[Math.min(closingIndex, remainingIds.length - 1)];
        activePaneRef.current = fallbackSessionId;
        if (fallbackSessionId) setActiveSession(fallbackSessionId);
      }
    },
    [activeSessionId, layout, setActiveSession],
  );

  const updateDropTarget = useCallback(
    (event: React.DragEvent<HTMLElement>, targetSessionId: string) => {
      if (!hasSessionDrag(event.dataTransfer) || !sessionsById.has(targetSessionId)) return;
      const placement = resolveSessionDropPlacement(
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropTarget((current) =>
        current?.sessionId === targetSessionId && current.placement === placement
          ? current
          : { sessionId: targetSessionId, placement },
      );
    },
    [sessionsById],
  );

  const clearDropTarget = useCallback((event: React.DragEvent<HTMLElement>, targetSessionId: string) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setDropTarget((current) => (current?.sessionId === targetSessionId ? null : current));
    }
  }, []);

  const dropSession = useCallback(
    (event: React.DragEvent<HTMLElement>, targetSessionId: string) => {
      setDropTarget(null);
      if (!hasSessionDrag(event.dataTransfer) || !sessionsById.has(targetSessionId)) return;
      const droppedSessionId = event.dataTransfer.getData(SESSION_DRAG_MIME);
      if (!droppedSessionId || !sessionsById.has(droppedSessionId)) return;
      event.preventDefault();
      event.stopPropagation();

      if (droppedSessionId === targetSessionId || (layout && hasPane(layout, droppedSessionId))) {
        activatePane(droppedSessionId);
        return;
      }
      const placement = resolveSessionDropPlacement(
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      const baseLayout = layout ?? createPane(targetSessionId);
      setLayout(insertPane(baseLayout, targetSessionId, droppedSessionId, placement));
      activePaneRef.current = droppedSessionId;
      setActiveSession(droppedSessionId);
    },
    [activatePane, layout, sessionsById, setActiveSession],
  );

  const handlers = useMemo<PaneEventHandlers>(
    () => ({
      onActivate: activatePane,
      onClose: closePane,
      onDragPosition: updateDropTarget,
      onDragExit: clearDropTarget,
      onDrop: dropSession,
    }),
    [activatePane, clearDropTarget, closePane, dropSession, updateDropTarget],
  );

  const singleSession = activeSessionId ? sessionsById.get(activeSessionId) : undefined;
  return (
    <div className="pw-conversation-surface" data-testid="conversation-split-surface">
      {layout ? (
        <div className="pw-conversation-split" data-testid="conversation-split">
          <ConversationLayoutNode
            layout={layout}
            sessionsById={sessionsById}
            activeSessionId={activeSessionId}
            dropTarget={dropTarget}
            onToast={onToast}
            handlers={handlers}
          />
        </div>
      ) : singleSession ? (
        <ConversationPane
          session={singleSession}
          active
          showHeader={false}
          dropPlacement={dropTarget?.sessionId === singleSession.id ? dropTarget.placement : undefined}
          onToast={onToast}
          handlers={handlers}
        />
      ) : (
        <PersonalChatArea onToast={onToast} />
      )}
    </div>
  );
}
