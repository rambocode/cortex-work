import { describe, expect, it } from "vitest";
import { PETDEX_CELL_H, PETDEX_CELL_W, detectPetdexGrid } from "./grid";

describe("detectPetdexGrid", () => {
  // 三种网格都来自 petdex 实测抽样,不是构造出来的边界。
  it.each([
    ["8×9 主流(1536×1872,49/60)", 8, 9, { cols: 8, rows: 9, frames: 6 }],
    ["8×11(1536×2288,10/60)", 8, 11, { cols: 8, rows: 11, frames: 6 }],
    ["9×8(1728×1664,1/60)", 9, 8, { cols: 9, rows: 8, frames: 6 }],
  ])("%s", (_name, cols, rows, expected) => {
    expect(detectPetdexGrid(cols * PETDEX_CELL_W, rows * PETDEX_CELL_H)).toEqual(expected);
  });

  it("列数不足 6 时帧数跟着降,不会越列取帧", () => {
    expect(detectPetdexGrid(3 * PETDEX_CELL_W, 9 * PETDEX_CELL_H)).toEqual({ cols: 3, rows: 9, frames: 3 });
  });

  // 未加载的图片 naturalWidth/Height 是 0;退化成 1×1 会把坏图当单帧 sprite 铺满宠物框。
  it.each([
    ["尚未加载", 0, 0],
    ["不足一格", 190, 200],
    ["只有宽度够", 1536, 100],
    ["NaN", Number.NaN, 1872],
  ])("%s → null", (_name, w, h) => {
    expect(detectPetdexGrid(w, h)).toBeNull();
  });

  it("畸形超大图被钳到上限", () => {
    const g = detectPetdexGrid(999 * PETDEX_CELL_W, 999 * PETDEX_CELL_H);
    expect(g).toEqual({ cols: 16, rows: 16, frames: 6 });
  });
});
