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
export const BUBBLE_FALLBACK_BOTTOM_RATIO = 0.68; // 无任何 frame 兜底：置于鼠标所在屏「中下方」的纵向位置比例
// 窗口 frame 兜底锚：聊天 app 输入框大致落在窗口纵向 72%~92% 处，据此在窗口内合成一个「输入条」锚点，
// 使拿不到精确输入框 frame 时气泡仍贴着当前会话窗口底部，而非飘到鼠标位置。
export const WINDOW_INPUT_TOP_RATIO = 0.72;
export const WINDOW_INPUT_BOTTOM_RATIO = 0.92;

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

/// 依锚点矩形（光标插入点 / 输入框 frame）计算气泡窗 bounds。锚点优先级：光标 > 输入框 frame >
/// 窗口 frame 合成的「输入条」> 鼠标。
/// - 默认锚定在锚点「下方」、左缘对齐锚点左缘——输入法候选窗语义：候选出现在光标行正下方,
///   不遮挡光标所在行与上方对话（用户确认的期望行为）；下方放不下（溢出工作区底部）→ 翻转到「上方」；
/// - 无精确输入框但有窗口 frame（微信等 AX 不完整）→ 用窗口纵向 72%~92% 合成输入条锚点，
///   使气泡贴着当前会话窗口底部（而非飘到鼠标位置）；
/// - 最终按锚点所在屏工作区 clamp（跨屏/边缘不越界）；
/// - 两种 frame 都缺失 → 兜底到鼠标所在屏「中下方」。
export function bubbleWindowBounds(input: {
  frame: ReplyRect | null;
  windowFrame?: ReplyRect | null;
  bubbleHeight: number;
  displays: ReplyRect[];
  cursor: { x: number; y: number };
}): ReplyRect {
  const { frame, windowFrame, bubbleHeight, displays, cursor } = input;
  const height = Math.max(1, Math.round(bubbleHeight));
  const width = BUBBLE_WIDTH;

  // 锚点解析：优先精确输入框；否则用窗口 frame 合成一个「底部输入条」矩形作为锚。
  const anchor: ReplyRect | null =
    frame ??
    (windowFrame
      ? {
          x: windowFrame.x,
          y: windowFrame.y + windowFrame.height * WINDOW_INPUT_TOP_RATIO,
          width: windowFrame.width,
          height: windowFrame.height * (WINDOW_INPUT_BOTTOM_RATIO - WINDOW_INPUT_TOP_RATIO),
        }
      : null);

  // 兜底：无任何 frame（AX 完全不可用）→ 鼠标所在屏中下方居中。
  if (!anchor) {
    const area = displayContaining(displays, cursor.x, cursor.y);
    const x = area.x + (area.width - width) / 2;
    const y = area.y + area.height * BUBBLE_FALLBACK_BOTTOM_RATIO;
    const c = clampToArea(area, x, y, width, height);
    return { x: c.x, y: c.y, width, height };
  }

  // 锚点所在屏：以锚点中心判定，避免跨屏锚点归错屏。
  const area = displayContaining(displays, anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);

  const x = anchor.x - 6; // 左缘略微外扩，与卡片左内边距对齐视觉（-6 抵消 root padding）
  // 默认锚定锚点「下方」（输入法候选窗语义,用户确认）；下方放不下（溢出工作区底部）→ 翻转到上方。
  const below = anchor.y + anchor.height + BUBBLE_GAP;
  const overflowBottom = below + height > area.y + area.height - BUBBLE_EDGE_MARGIN;
  const y = overflowBottom ? anchor.y - height - BUBBLE_GAP : below;

  const c = clampToArea(area, x, y, width, height);
  return { x: c.x, y: c.y, width, height };
}
