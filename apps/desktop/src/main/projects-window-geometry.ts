// 项目管理独立窗口的几何纯函数（无 electron 依赖，便于单测）。仿 notes-overlay-geometry.ts。
// 职责：① 首开无持久值时的默认居中；② 把持久化 bounds 夹回「现存显示器工作区」——外接屏断开后，
// 存档坐标可能整块落在已消失的显示器上，直接建窗会离屏、标题栏拖不回；③ 关窗前判定是否可持久化
// （最小化/全屏态几何非正常值，不能覆盖正常 bounds）。抽离于 projects-window.ts，使 clamp
// 逻辑独立于 BrowserWindow / screen 可测。

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 显示器可用工作区（已扣除菜单栏/程序坞），对应 electron screen.Display.workArea。
export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PROJECTS_WINDOW_DEFAULT_WIDTH = 1180;
export const PROJECTS_WINDOW_DEFAULT_HEIGHT = 800;
export const PROJECTS_WINDOW_MIN_WIDTH = 720;
export const PROJECTS_WINDOW_MIN_HEIGHT = 520;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

// 首开（无持久值）时的默认 bounds：在给定工作区内居中；尺寸取默认值并夹到工作区上限，防小屏溢出。
export function defaultProjectsBounds(workArea: DisplayWorkArea): WindowBounds {
  const width = Math.min(PROJECTS_WINDOW_DEFAULT_WIDTH, workArea.width);
  const height = Math.min(PROJECTS_WINDOW_DEFAULT_HEIGHT, workArea.height);
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  return { x, y, width, height };
}

// 两矩形交叠面积（≤0 视为不相交）。
function overlapArea(a: WindowBounds, b: DisplayWorkArea): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// 把持久化 bounds 夹回现存显示器工作区：
//  ① 选与之交叠最多的工作区为目标；与所有工作区均无交叠（外接屏断开导致离屏）时落到首个工作区；
//  ② 尺寸先夹到 [MIN, 工作区尺寸]；③ 位置再夹回目标工作区内，保证标题栏可见、可拖回。
// workAreas 为空时原样返回（防御，正常至少存在主屏）。
export function clampProjectsBounds(saved: WindowBounds, workAreas: DisplayWorkArea[]): WindowBounds {
  if (workAreas.length === 0) return saved;
  let target = workAreas[0]!;
  let best = -1;
  for (const wa of workAreas) {
    const area = overlapArea(saved, wa);
    if (area > best) {
      best = area;
      target = wa;
    }
  }
  const width = clamp(saved.width, PROJECTS_WINDOW_MIN_WIDTH, target.width);
  const height = clamp(saved.height, PROJECTS_WINDOW_MIN_HEIGHT, target.height);
  const x = clamp(saved.x, target.x, target.x + target.width - width);
  const y = clamp(saved.y, target.y, target.y + target.height - height);
  return { x, y, width, height };
}

// 关窗持久化前决定是否写入：最小化/全屏态下窗口几何非正常值（全屏尺寸 / 最小化态），
// 覆盖会污染下次还原的正常 bounds → 返回 null 表示「保持上次持久值」；正常态返回传入的 normalBounds。
export function boundsToPersist(
  normalBounds: WindowBounds,
  state: { minimized: boolean; fullscreen: boolean },
): WindowBounds | null {
  if (state.minimized || state.fullscreen) return null;
  return normalBounds;
}
