// 闪记浮层几何纯函数（无 electron 依赖,便于单测）。窗口实测高度的夹取与定位计算
// 从 notes-overlay.ts 抽离,使「高度夹取」可独立于 BrowserWindow / screen 单测。

// 浮层尺寸常量（仿 spotlight.ts,按闪记 UI 另设）。
export const NOTES_WIDTH = 720;
export const NOTES_HEIGHT = 220; // 折叠态(单卡 + textarea + 内边距 + 投影留白);实际由 renderer 实测上报
export const NOTES_MAX_HEIGHT = 620; // 内容展开上限
export const NOTES_BOTTOM_MARGIN = 120; // 离屏幕底部留白

// 把 renderer 实测高度夹取到 [NOTES_HEIGHT, NOTES_MAX_HEIGHT]（透明窗口高度必须 ≥ 白卡+投影,
// 否则投影被窗口下边缘硬切成半透明带）。仿 spotlight.ts:87。
export function clampNotesHeight(height: number): number {
  return Math.max(NOTES_HEIGHT, Math.min(Math.round(height), NOTES_MAX_HEIGHT));
}

// 据工作区与窗口高度算左下定位（水平居中、底边固定留白）。仿 spotlight.ts:26-27。
export function notesOverlayBounds(
  workArea: { x: number; y: number; width: number; height: number },
  height: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.round(workArea.x + (workArea.width - NOTES_WIDTH) / 2);
  const y = Math.round(workArea.y + workArea.height - height - NOTES_BOTTOM_MARGIN);
  return { x, y, width: NOTES_WIDTH, height };
}
