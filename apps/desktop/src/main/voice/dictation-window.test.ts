import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
}));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));

import { DICTATION_BAR_HEIGHT, DICTATION_BAR_WIDTH, dictationWindowBounds } from "./dictation-window";

describe("dictationWindowBounds", () => {
  it("将不抢焦听写栏放在工作区底部居中", () => {
    expect(dictationWindowBounds({ x: 10, y: 20, width: 1000, height: 800 })).toEqual({
      x: 10 + (1000 - DICTATION_BAR_WIDTH) / 2,
      y: 20 + 800 - DICTATION_BAR_HEIGHT - 24,
      width: DICTATION_BAR_WIDTH,
      height: DICTATION_BAR_HEIGHT,
    });
  });

  it("窄屏时把横条钳在工作区内", () => {
    expect(dictationWindowBounds({ x: 100, y: 200, width: 200, height: 100 })).toEqual({
      x: 100,
      y: 200,
      width: DICTATION_BAR_WIDTH,
      height: DICTATION_BAR_HEIGHT,
    });
  });
});
