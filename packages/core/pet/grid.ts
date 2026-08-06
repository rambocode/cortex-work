// petdex sprite sheet 的网格契约。两端共享(渲染进程按 naturalWidth/Height 探测,
// 主进程按 WebP 头部的画布尺寸探测),故放 core 作单一真源。
//
// ⚠️ 关键事实(实测 60 张 petdex sprite 得出,别按直觉简化):
// **格子尺寸恒为 192×208,但网格的行列数并不统一**——
//   8 列 × 9 行 (1536×1872) 49 张 / 8 列 × 11 行 (1536×2288) 10 张 / 9 列 × 8 行 (1728×1664) 1 张。
// 参考实现 hermes-studio 把行数硬编码成 9,对只有 8 行的 sprite 会算出
// sy = 8×208 = 1664 —— 正好等于图高,drawImage 的源矩形整个落在图外,那一行画出来是空白。
// 所以行列数一律运行时探测,行索引再按回落链 clamp(见 views 侧的 rows.ts)。

/** 单格宽(设计像素)。 */
export const PETDEX_CELL_W = 192;
/** 单格高(设计像素)。 */
export const PETDEX_CELL_H = 208;

/**
 * 每行取用的帧数**上限**。
 *
 * ⚠️ 「每行至少 6 帧非空」曾是本文件写下的实测结论,**它是错的**。逐格量 alpha 后的
 * 真实分布(shiba-2 / lemon 两只完全一致):行 0/6/7/8 六帧、行 1/2/5 八帧,而
 * **行 3(waving)只有 4 帧、行 4(jumping)只有 5 帧**。照 6 帧硬播的后果是 replying
 * (落行 3)每轮空白两帧 =「agent 回复时宠物偶尔不见了」。
 * 故真实帧数由渲染端运行时逐行探测(views 的 sheet.ts `measureRowFrames`),这里只留
 * 上限:探测不可用时(jsdom / 画布被污染)退回它,取 6 仍是全行统计下最安全的固定值。
 */
export const PETDEX_FRAMES = 6;

/** 网格尺寸上限:挡住畸形图把背景尺寸/帧索引撑成天文数字。 */
const MAX_COLS = 16;
const MAX_ROWS = 16;

export interface PetdexGrid {
  cols: number;
  rows: number;
  /** 实际可播帧数 = min(PETDEX_FRAMES, cols)。 */
  frames: number;
}

/**
 * 从图片画布尺寸探测网格。
 * 任一维不足一格(含尚未加载的 0×0)返回 null,调用方按「资源不可用」处理,
 * 不要退化成 1×1 —— 那会把一张坏图当成单帧 sprite 铺满整个宠物框。
 */
export function detectPetdexGrid(width: number, height: number): PetdexGrid | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const cols = Math.floor(width / PETDEX_CELL_W);
  const rows = Math.floor(height / PETDEX_CELL_H);
  if (cols < 1 || rows < 1) return null;
  return {
    cols: Math.min(cols, MAX_COLS),
    rows: Math.min(rows, MAX_ROWS),
    frames: Math.min(PETDEX_FRAMES, cols),
  };
}
