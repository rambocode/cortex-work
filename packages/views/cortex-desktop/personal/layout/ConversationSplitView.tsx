// 会话拆分容器：左侧会话行通过 HTML5 drag-and-drop 拖到会话区右半边后，
// 在同一中心栏并排承载任意数量的完整会话。拆分布局是窗口内瞬态，不写入 personal 持久化：
// 重启后会话列表可能已删除或归档，恢复陈旧窗格反而会把用户带进无效状态。

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import type { SessionMeta } from "@cortex-work/core";
import { PersonalChatArea } from "../chat/PersonalChatArea";
import { SESSION_DRAG_MIME } from "./conversation-drag";

function hasSessionDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(SESSION_DRAG_MIME);
}

function findSession(sessions: SessionMeta[], sessionId: string): SessionMeta | undefined {
  return sessions.find((session) => session.id === sessionId);
}

export function ConversationSplitView({ onToast }: { onToast: (text: string) => void }) {
  const sessions = usePersonalStore((state) => state.sessions);
  const activeSessionId = usePersonalStore((state) => state.activeSessionId);
  const setActiveSession = usePersonalStore((state) => state.setActiveSession);
  const [paneIds, setPaneIds] = useState<string[] | null>(null);
  const [rightDropActive, setRightDropActive] = useState(false);
  // 普通点击侧栏会话仍走既有 setActiveSession。拆分后用 ref 记住用户最后聚焦的窗格，
  // 这样侧栏选择会替换该窗格，而不会因为 transient focus 变化多做一次 React render。
  const activePaneRef = useRef(0);

  useEffect(() => {
    if (!paneIds) return;
    const remaining = paneIds.filter((id) => findSession(sessions, id));
    if (remaining.length === paneIds.length) return;

    // 删除项目/会话可能一次移除任意数量的窗格。少于两个时自然收回单窗格；仍有多个时
    // 只剔除失效 id，不打乱其它窗格顺序。活动窗格失效时选相邻窗格接管全局上下文。
    setPaneIds(remaining.length >= 2 ? remaining : null);
    if (activeSessionId && remaining.includes(activeSessionId)) {
      activePaneRef.current = remaining.indexOf(activeSessionId);
      return;
    }
    const fallbackIndex = Math.min(activePaneRef.current, remaining.length - 1);
    const fallbackSessionId = remaining[fallbackIndex];
    if (fallbackSessionId) {
      activePaneRef.current = fallbackIndex;
      setActiveSession(fallbackSessionId);
    }
  }, [activeSessionId, paneIds, sessions, setActiveSession]);

  useEffect(() => {
    if (!paneIds || !activeSessionId) return;
    const paneIndex = paneIds.indexOf(activeSessionId);
    if (paneIndex >= 0) {
      activePaneRef.current = paneIndex;
      return;
    }

    // 侧栏点击仍只需要调用既有 setActiveSession：这里把新会话装入当前聚焦窗格。
    // 若新会话已经在另一窗格，上面的 includes 分支只切焦点，不会制造重复窗格。
    setPaneIds((current) => {
      if (!current || current.includes(activeSessionId)) return current;
      const next = [...current];
      const replaceIndex = Math.min(activePaneRef.current, next.length - 1);
      next[replaceIndex] = activeSessionId;
      return next;
    });
  }, [activeSessionId, paneIds]);

  const activatePane = useCallback(
    (index: number, sessionId: string) => {
      activePaneRef.current = index;
      if (activeSessionId !== sessionId) setActiveSession(sessionId);
    },
    [activeSessionId, setActiveSession],
  );

  const closePane = useCallback(
    (index: number) => {
      if (!paneIds) return;
      const closingSessionId = paneIds[index];
      const remainingIds = paneIds.filter((_, paneIndex) => paneIndex !== index);
      setPaneIds(remainingIds.length >= 2 ? remainingIds : null);

      if (closingSessionId === activeSessionId) {
        const fallbackIndex = Math.min(index, remainingIds.length - 1);
        const fallbackSessionId = remainingIds[fallbackIndex];
        activePaneRef.current = Math.max(0, fallbackIndex);
        if (fallbackSessionId) setActiveSession(fallbackSessionId);
        return;
      }
      const activeIndex = activeSessionId ? remainingIds.indexOf(activeSessionId) : -1;
      activePaneRef.current = Math.max(0, activeIndex);
    },
    [activeSessionId, paneIds, setActiveSession],
  );

  const updateDropState = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const validSessionDrag = hasSessionDrag(event.dataTransfer);
      const rect = event.currentTarget.getBoundingClientRect();
      const inRightHalf = event.clientX >= rect.left + rect.width / 2;
      const canSplit = validSessionDrag && !!activeSessionId && inRightHalf;
      setRightDropActive(canSplit);
      if (canSplit) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [activeSessionId],
  );

  const dropSession = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      setRightDropActive(false);
      if (!hasSessionDrag(event.dataTransfer) || !activeSessionId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) return;

      const droppedSessionId = event.dataTransfer.getData(SESSION_DRAG_MIME);
      if (!droppedSessionId || !findSession(sessions, droppedSessionId)) return;
      event.preventDefault();

      if (paneIds) {
        const existingIndex = paneIds.indexOf(droppedSessionId);
        if (existingIndex >= 0) {
          activatePane(existingIndex, droppedSessionId);
          return;
        }
        // 不限制窗格数量：右侧 drop target 每次追加新窗格；同一会话由上面的分支去重。
        setPaneIds([...paneIds, droppedSessionId]);
        activePaneRef.current = paneIds.length;
      } else {
        if (droppedSessionId === activeSessionId) return;
        setPaneIds([activeSessionId, droppedSessionId]);
        activePaneRef.current = 1;
      }
      setActiveSession(droppedSessionId);
    },
    [activatePane, activeSessionId, paneIds, sessions, setActiveSession],
  );

  return (
    <div
      className="pw-conversation-surface"
      data-testid="conversation-split-surface"
      onDragEnter={updateDropState}
      onDragOver={updateDropState}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setRightDropActive(false);
        }
      }}
      onDrop={dropSession}
    >
      {paneIds ? (
        <div className="pw-conversation-split" data-testid="conversation-split">
          {paneIds.map((sessionId, index) => {
            const session = findSession(sessions, sessionId);
            if (!session) return null;
            const active = sessionId === activeSessionId;
            return (
              <section
                key={sessionId}
                className={`pw-conversation-pane ${active ? "is-active" : ""}`}
                data-session-id={sessionId}
                onPointerDownCapture={() => activatePane(index, sessionId)}
                onFocusCapture={() => activatePane(index, sessionId)}
              >
                <div className="pw-split-pane-head">
                  <span className="pw-split-pane-dot" aria-hidden="true" />
                  <strong title={session.title}>{session.title}</strong>
                  <button
                    type="button"
                    className="pw-icon-btn"
                    aria-label={`关闭 ${session.title} 窗格`}
                    title="关闭拆分窗格"
                    onClick={() => closePane(index)}
                  >
                    <Icon.X size={12} />
                  </button>
                </div>
                <PersonalChatArea sessionId={sessionId} onToast={onToast} />
              </section>
            );
          })}
        </div>
      ) : (
        <PersonalChatArea onToast={onToast} />
      )}

      {rightDropActive ? (
        <div className="pw-session-drop-target" role="status">
          <Icon.Split size={22} />
          <strong>在右侧拆分会话</strong>
          <span>松开即可并排打开</span>
        </div>
      ) : null}
    </div>
  );
}
