// 会话拆分使用不可变二叉树描述二维布局：horizontal 表示左右，vertical 表示上下。
// 每个会话只允许出现一次；所有结构变更都从这些纯函数进入，避免组件事件里散落树操作。

import type { SessionDropPlacement } from "./conversation-drag";

export type ConversationLayout =
  | {
      kind: "pane";
      sessionId: string;
      columns: 1;
      rows: 1;
    }
  | {
      kind: "split";
      axis: "horizontal" | "vertical";
      first: ConversationLayout;
      second: ConversationLayout;
      columns: number;
      rows: number;
    };

export function createPane(sessionId: string): ConversationLayout {
  return { kind: "pane", sessionId, columns: 1, rows: 1 };
}

function createBranch(
  axis: "horizontal" | "vertical",
  first: ConversationLayout,
  second: ConversationLayout,
): ConversationLayout {
  return {
    kind: "split",
    axis,
    first,
    second,
    // 预先记录最小网格跨度，渲染时可直接换算最小像素尺寸。这样深层混合拆分仍会
    // 正确撑开双向滚动区，而不是把输入框压缩到不可操作。
    columns: axis === "horizontal" ? first.columns + second.columns : Math.max(first.columns, second.columns),
    rows: axis === "vertical" ? first.rows + second.rows : Math.max(first.rows, second.rows),
  };
}

export function collectPaneIds(layout: ConversationLayout): string[] {
  if (layout.kind === "pane") return [layout.sessionId];
  return [...collectPaneIds(layout.first), ...collectPaneIds(layout.second)];
}

export function hasPane(layout: ConversationLayout, sessionId: string): boolean {
  if (layout.kind === "pane") return layout.sessionId === sessionId;
  return hasPane(layout.first, sessionId) || hasPane(layout.second, sessionId);
}

/** 在目标叶子指定方向插入新会话；目标不存在时保持原树不变。 */
export function insertPane(
  layout: ConversationLayout,
  targetSessionId: string,
  newSessionId: string,
  placement: SessionDropPlacement,
): ConversationLayout {
  if (layout.kind === "pane") {
    if (layout.sessionId !== targetSessionId) return layout;
    const incoming = createPane(newSessionId);
    const axis = placement === "left" || placement === "right" ? "horizontal" : "vertical";
    const incomingFirst = placement === "left" || placement === "top";
    return createBranch(axis, incomingFirst ? incoming : layout, incomingFirst ? layout : incoming);
  }

  const first = insertPane(layout.first, targetSessionId, newSessionId, placement);
  if (first !== layout.first) return createBranch(layout.axis, first, layout.second);
  const second = insertPane(layout.second, targetSessionId, newSessionId, placement);
  return second === layout.second ? layout : createBranch(layout.axis, layout.first, second);
}

/** 侧栏普通点击只替换当前活动叶子，不改变用户已经排好的拆分结构。 */
export function replacePane(
  layout: ConversationLayout,
  targetSessionId: string,
  replacementSessionId: string,
): ConversationLayout {
  if (layout.kind === "pane") {
    return layout.sessionId === targetSessionId ? createPane(replacementSessionId) : layout;
  }
  const first = replacePane(layout.first, targetSessionId, replacementSessionId);
  if (first !== layout.first) return createBranch(layout.axis, first, layout.second);
  const second = replacePane(layout.second, targetSessionId, replacementSessionId);
  return second === layout.second ? layout : createBranch(layout.axis, layout.first, second);
}

/** 删除叶子后折叠只剩一个子节点的父分支；删除整棵树时返回 null。 */
export function removePane(layout: ConversationLayout, sessionId: string): ConversationLayout | null {
  if (layout.kind === "pane") return layout.sessionId === sessionId ? null : layout;
  const first = removePane(layout.first, sessionId);
  const second = removePane(layout.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return createBranch(layout.axis, first, second);
}

/** 会话或项目删除时清理全部失效叶子，并保持剩余分支的相对布局。 */
export function pruneLayout(layout: ConversationLayout, validSessionIds: ReadonlySet<string>): ConversationLayout | null {
  if (layout.kind === "pane") return validSessionIds.has(layout.sessionId) ? layout : null;
  const first = pruneLayout(layout.first, validSessionIds);
  const second = pruneLayout(layout.second, validSessionIds);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return createBranch(layout.axis, first, second);
}
