// Slides 演示模式的「双屏分屏」纯几何决策:不 import electron,只吃 display 列表 + 主屏 id,
// 决定观众窗与演讲者窗各落哪块屏。抽成纯函数是为了能脱离 electron/BrowserWindow 单测。

/** 显示器的最小形状(对齐 Electron Display 的 id + bounds 子集)。 */
export interface DisplayLike {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * 选出观众屏与演讲者屏。
 *
 * 规则(为何观众放非主屏):投影/大屏通常是外接屏,而系统菜单栏、Dock、演讲者本人
 * 的操作都在主屏 —— 所以观众幻灯片放到「第一块非主屏」的外接屏对着听众,演讲者页
 * 留在主屏(笔记本本体)给自己看。少于 2 块屏或找不到非主屏时返回 null,调用方退回单窗全屏。
 */
export function pickPresentDisplays(
  displays: DisplayLike[],
  primaryId: number,
): { audience: DisplayLike; speaker: DisplayLike } | null {
  // 单屏(或空)无从分屏:交给调用方走原单窗路径,零回归。
  if (displays.length < 2) return null;

  // 观众屏 = 第一块非主屏的外接屏;一块都没有(全是主屏 id)则无法分屏。
  const audience = displays.find((d) => d.id !== primaryId);
  if (!audience) return null;

  // 演讲者屏 = 主屏;主屏不在列表里(异常)时兜底取第一块,保证两窗不落同一块屏。
  const speaker = displays.find((d) => d.id === primaryId) ?? displays[0]!;

  return { audience, speaker };
}
