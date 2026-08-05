// 把「当前选中的宠物 + 当前姿态」解析成一次具体的取帧指令。
//
// 这是内置资产与 petdex 图鉴唯一的分叉点:分叉之后两者完全同构,PetCanvas 只认
// ResolvedSheet,不知道也不关心这只宠物是随包发布的还是从图鉴下载的。

import type { PetState } from "@cortex-work/core";
import type { PetSpriteSource } from "@cortex-work/core/desktop/petdex-types";
import { PETDEX_CELL_H, PETDEX_CELL_W, PETDEX_FRAMES } from "@cortex-work/core/pet/grid";
import { ONE_SHOT, ROW_FALLBACK, SLEEP_SLOWDOWN, resolveRow } from "./rows";
import { BUILTIN_CELL_H, BUILTIN_CELL_W, BUILTIN_SHEETS, builtinAnimFor } from "./sheets";

/** 一次具体的取帧指令:去哪张图、取第几行、播几帧、多快。 */
export interface ResolvedSheet {
  url: string;
  /** 取第几行(内置资产恒为 0)。 */
  row: number;
  /** 本次播放的帧数。 */
  frames: number;
  /** 每帧间隔(毫秒)。 */
  frameMs: number;
  cellW: number;
  cellH: number;
  /** 播到末帧停住,不循环。 */
  oneShot: boolean;
  /** 换到不同的取帧指令时用它作 key 重置帧游标(同一指令不重置,保持动作连续)。 */
  key: string;
}

/** petdex sprite 的播放节奏。6 帧 ≈ 1.1s 一轮,与内置 idle 的呼吸感接近。 */
const PETDEX_FRAME_MS = 180;

/**
 * 解析当前该画什么。
 *
 * sprite 为 null(尚未选过图鉴宠物 / 还没解析出来)时回落到内置角色 —— 这条回落是
 * 首启与离线时宠物仍然可见的保证,不要为了「统一」把它去掉。
 * petdex sprite 的行数不统一,行号必须经降级链解析(见 rows.ts)。
 */
export function resolveSheet(sprite: PetSpriteSource | null, state: PetState): ResolvedSheet | null {
  const slow = state === "sleeping" ? SLEEP_SLOWDOWN : 1;

  if (!sprite || sprite.origin === "builtin") {
    const anim = builtinAnimFor(state);
    const sheet = BUILTIN_SHEETS[anim];
    return {
      url: sheet.src,
      row: 0, // 内置资产每个动作一张单行 sheet
      frames: sheet.frames,
      frameMs: (1000 / sheet.fps) * slow,
      cellW: BUILTIN_CELL_W,
      cellH: BUILTIN_CELL_H,
      oneShot: ONE_SHOT.has(state),
      key: `builtin:${anim}`,
    };
  }

  if (!sprite.url || sprite.cols < 1 || sprite.rows < 1) return null;
  const row = resolveRow(ROW_FALLBACK[state], sprite.rows);
  return {
    url: sprite.url,
    row,
    // 帧数取 min(6, 列数):实测 idle 行恰好 6 帧、其余行 8 帧,6 是安全下限,
    // 多播会在 idle 行撞上透明尾帧让宠物凭空消失。
    frames: Math.min(PETDEX_FRAMES, sprite.cols),
    frameMs: PETDEX_FRAME_MS * slow,
    cellW: PETDEX_CELL_W,
    cellH: PETDEX_CELL_H,
    oneShot: ONE_SHOT.has(state),
    // key 绑定到「图 + 行」而非姿态:多个姿态映射到同一行时(如 idle/typing 都可能落 0 行)
    // 不重置帧游标,呼吸保持连续不闪。
    key: `${sprite.id}:${row}`,
  };
}
