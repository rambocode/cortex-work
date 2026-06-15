import { describe, it, expect } from "vitest";
import {
  clampNotesHeight,
  notesOverlayBounds,
  NOTES_HEIGHT,
  NOTES_MAX_HEIGHT,
  NOTES_WIDTH,
  NOTES_BOTTOM_MARGIN,
} from "./notes-overlay-geometry";

describe("clampNotesHeight", () => {
  it("低于折叠高度时夹到 NOTES_HEIGHT(保证白卡+投影不被硬切)", () => {
    expect(clampNotesHeight(0)).toBe(NOTES_HEIGHT);
    expect(clampNotesHeight(NOTES_HEIGHT - 50)).toBe(NOTES_HEIGHT);
  });

  it("超过上限时夹到 NOTES_MAX_HEIGHT", () => {
    expect(clampNotesHeight(NOTES_MAX_HEIGHT + 200)).toBe(NOTES_MAX_HEIGHT);
  });

  it("区间内四舍五入透传", () => {
    const mid = (NOTES_HEIGHT + NOTES_MAX_HEIGHT) / 2;
    expect(clampNotesHeight(mid + 0.4)).toBe(Math.round(mid));
  });
});

describe("notesOverlayBounds", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };

  it("水平居中、底边固定留白", () => {
    const h = 300;
    const b = notesOverlayBounds(workArea, h);
    expect(b.width).toBe(NOTES_WIDTH);
    expect(b.height).toBe(h);
    expect(b.x).toBe(Math.round((1440 - NOTES_WIDTH) / 2));
    expect(b.y).toBe(900 - h - NOTES_BOTTOM_MARGIN);
  });

  it("尊重工作区偏移(多显示器/菜单栏)", () => {
    const offset = { x: 100, y: 25, width: 1280, height: 800 };
    const b = notesOverlayBounds(offset, 220);
    expect(b.x).toBe(Math.round(100 + (1280 - NOTES_WIDTH) / 2));
    expect(b.y).toBe(25 + 800 - 220 - NOTES_BOTTOM_MARGIN);
  });
});
