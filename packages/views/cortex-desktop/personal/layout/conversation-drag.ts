// 左侧会话行与中心拆分容器之间唯一的拖放契约。使用自定义 MIME，避免文件、文本等
// 外部拖放误触会话拆分；payload 只携带 session id，不复制标题或其它易漂移元数据。
export const SESSION_DRAG_MIME = "application/x-cortex-session-id";

export type SessionDropPlacement = "top" | "right" | "bottom" | "left";

/**
 * 把指针映射到目标窗格四个方向之一。按相对中心距离的主轴判定，能让非正方形窗格的
 * 四块命中区域保持自然比例，也不会在中心留下无法放置的死区。
 */
export function resolveSessionDropPlacement(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
): SessionDropPlacement {
  const horizontal = (clientX - (rect.left + rect.width / 2)) / Math.max(rect.width, 1);
  const vertical = (clientY - (rect.top + rect.height / 2)) / Math.max(rect.height, 1);
  if (Math.abs(horizontal) >= Math.abs(vertical)) return horizontal < 0 ? "left" : "right";
  return vertical < 0 ? "top" : "bottom";
}
