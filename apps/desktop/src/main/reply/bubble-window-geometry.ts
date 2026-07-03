// 候选气泡窗几何纯函数（无 electron 依赖，便于单测）。把「焦点输入框 frame → 气泡窗 bounds」
// 的定位/翻转/clamp 计算从 bubble-window.ts 抽离。仿 notification-window-geometry.ts。
//
// 坐标系契约（重要）：所有矩形均为「屏幕左上原点、y 向下、单位 point」——
// ax-capture 输出的输入框 frame、Electron screen 的 display bounds/workArea、setBounds 三者同系，
// 故此处直接按数值运算，不做 Cocoa(左下原点) 翻转。多屏用 workArea 数组表达（可含负坐标副屏）。

import type { ReplyRect } from "../ipc/reply-types";

export const BUBBLE_WIDTH = 372; // 卡片 360 + 左右各 6 留白（与 reply-bubble.css 的 .rb-root padding 对齐）
export const BUBBLE_GAP = 8; // 气泡与输入框之间的间隙
export const BUBBLE_EDGE_MARGIN = 12; // 气泡离屏幕工作区边缘的最小留白
export const BUBBLE_FALLBACK_BOTTOM_RATIO = 0.68; // frame 缺失兜底：置于鼠标所在屏「中下方」的纵向位置比例

/// 判断点是否落在某工作区内（含左闭右开边界，避免相邻屏重复命中）。
function contains(area: ReplyRect, px: number, py: number): boolean {
  return px >= area.x && px < area.x + area.width && py >= area.y && py < area.y + area.height;
}

/// 选出包含指定点的工作区；无命中时回落第一个（主屏），displays 为空时返回一个安全默认屏。
export function displayContaining(
  displays: ReplyRect[],
  px: number,
  py: number,
): ReplyRect {
  if (displays.length === 0) return { x: 0, y: 0, width: 1440, height: 900 };
  return displays.find((d) => contains(d, px, py)) ?? displays[0];
}

/// 把气泡 x/y 夹到目标工作区内（左右上下各留 BUBBLE_EDGE_MARGIN；窗口比工作区还大时以左上角为准）。
function clampToArea(area: ReplyRect, x: number, y: number, width: number, height: number): { x: number; y: number } {
  const minX = area.x + BUBBLE_EDGE_MARGIN;
  const maxX = area.x + area.width - width - BUBBLE_EDGE_MARGIN;
  const minY = area.y + BUBBLE_EDGE_MARGIN;
  const maxY = area.y + area.height - height - BUBBLE_EDGE_MARGIN;
  return {
    x: Math.round(maxX >= minX ? Math.min(Math.max(x, minX), maxX) : minX),
    y: Math.round(maxY >= minY ? Math.min(Math.max(y, minY), maxY) : minY),
  };
}

/// 依焦点输入框 frame 计算气泡窗 bounds。
/// - 默认锚定输入框「上方」、左缘对齐输入框左缘（留 BUBBLE_GAP）；
/// - 上方溢出所在屏顶部 → 翻转到输入框「下方」；
/// - 最终按输入框所在屏工作区 clamp（跨屏/边缘不越界）；
/// - frame 缺失（AX 取不到）→ 兜底到鼠标所在屏「中下方」。
export function bubbleWindowBounds(input: {
  frame: ReplyRect | null;
  bubbleHeight: number;
  displays: ReplyRect[];
  cursor: { x: number; y: number };
}): ReplyRect {
  const { frame, bubbleHeight, displays, cursor } = input;
  const height = Math.max(1, Math.round(bubbleHeight));
  const width = BUBBLE_WIDTH;

  // 兜底：无输入框 frame（如微信 AX 不完整）→ 鼠标所在屏中下方居中。
  if (!frame) {
    const area = displayContaining(displays, cursor.x, cursor.y);
    const x = area.x + (area.width - width) / 2;
    const y = area.y + area.height * BUBBLE_FALLBACK_BOTTOM_RATIO;
    const c = clampToArea(area, x, y, width, height);
    return { x: c.x, y: c.y, width, height };
  }

  // 输入框所在屏：以输入框中心判定，避免跨屏输入框归错屏。
  const area = displayContaining(displays, frame.x + frame.width / 2, frame.y + frame.height / 2);

  const x = frame.x - 6; // 左缘略微外扩，与卡片左内边距对齐视觉（-6 抵消 root padding）
  const above = frame.y - height - BUBBLE_GAP;
  // 上方放不下（溢出工作区顶部）→ 翻转到输入框下方。
  const overflowTop = above < area.y + BUBBLE_EDGE_MARGIN;
  const y = overflowTop ? frame.y + frame.height + BUBBLE_GAP : above;

  const c = clampToArea(area, x, y, width, height);
  return { x: c.x, y: c.y, width, height };
}
