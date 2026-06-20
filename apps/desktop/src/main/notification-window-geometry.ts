// 独立通知窗体几何纯函数(无 electron 依赖,便于单测)。窗口实测高度的夹取与右上角定位
// 计算从 notification-window.ts 抽离。仿 notes-overlay-geometry.ts。
//
// 设计取舍:窗体宽度 = 卡片宽 + 极小留白,高度由 renderer 实测内容上报,使窗口「紧贴」
// 卡片包围盒 → 几乎无透明死区,故无需 setIgnoreMouseEvents 点击穿透(空白处即在窗口外,
// 关闭按钮在窗口内可点)。

export const NTF_WIDTH = 332; // 卡片 320 + 左右各 6 留白
export const NTF_MIN_HEIGHT = 1; // 空栈哨兵:renderer 上报 <=1 → 调用方隐藏窗口
export const NTF_MAX_HEIGHT_RATIO = 0.85; // 不超过工作区高度的 85%(超长时窗体内部滚动)
export const NTF_TOP_MARGIN = 14; // 离工作区顶部留白(让位菜单栏下方)
export const NTF_RIGHT_MARGIN = 14; // 离工作区右缘留白

// 把 renderer 实测高度夹取到 [NTF_MIN_HEIGHT, workArea*ratio]。
export function clampNotificationHeight(height: number, workAreaHeight: number): number {
  const max = Math.max(NTF_MIN_HEIGHT, Math.round(workAreaHeight * NTF_MAX_HEIGHT_RATIO));
  return Math.max(NTF_MIN_HEIGHT, Math.min(Math.round(height), max));
}

// 据工作区与窗口高度算右上角定位(右缘固定留白、顶边固定留白)。
export function notificationWindowBounds(
  workArea: { x: number; y: number; width: number; height: number },
  height: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.round(workArea.x + workArea.width - NTF_WIDTH - NTF_RIGHT_MARGIN);
  const y = Math.round(workArea.y + NTF_TOP_MARGIN);
  return { x, y, width: NTF_WIDTH, height };
}
