// 候选气泡窗几何纯函数单测：上方锚定 / 顶部溢出翻转下方 / 跨屏 clamp / frame 缺失兜底。

import { describe, it, expect } from "vitest";
import {
  bubbleWindowBounds,
  displayContaining,
  BUBBLE_WIDTH,
  BUBBLE_GAP,
  BUBBLE_EDGE_MARGIN,
} from "./bubble-window-geometry";

const PRIMARY = { x: 0, y: 0, width: 1440, height: 900 };
// 右侧副屏（不同尺寸，用于跨屏归属测试）。
const SECONDARY = { x: 1440, y: 0, width: 1920, height: 1080 };

describe("displayContaining", () => {
  it("命中包含点的工作区", () => {
    expect(displayContaining([PRIMARY, SECONDARY], 1500, 200)).toBe(SECONDARY);
    expect(displayContaining([PRIMARY, SECONDARY], 100, 100)).toBe(PRIMARY);
  });

  it("无命中回落第一个（主屏）", () => {
    expect(displayContaining([PRIMARY, SECONDARY], 5000, 5000)).toBe(PRIMARY);
  });

  it("空 displays 返回安全默认屏", () => {
    expect(displayContaining([], 0, 0)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });
});

describe("bubbleWindowBounds - 下方锚定（默认）", () => {
  it("输入框下方留白放置，宽度固定，左缘对齐输入框", () => {
    const frame = { x: 300, y: 400, width: 400, height: 40 };
    const b = bubbleWindowBounds({
      frame,
      bubbleHeight: 100,
      displays: [PRIMARY],
      cursor: { x: 0, y: 0 },
    });
    expect(b.width).toBe(BUBBLE_WIDTH);
    expect(b.height).toBe(100);
    // 下方：y = frame.y + frame.height + gap
    expect(b.y).toBe(400 + 40 + BUBBLE_GAP);
    // 左缘对齐（-6 视觉抵消），在屏内不被 clamp
    expect(b.x).toBe(300 - 6);
  });
});

describe("bubbleWindowBounds - 底部溢出翻转上方", () => {
  it("下方放不下时翻到输入框上方", () => {
    const frame = { x: 300, y: 850, width: 400, height: 40 };
    const b = bubbleWindowBounds({
      frame,
      bubbleHeight: 120,
      displays: [PRIMARY],
      cursor: { x: 0, y: 0 },
    });
    // below = 850 + 40 + 8 = 898；+120 溢出底部（>900-12）→ 翻上方：y = frame.y - height - gap
    expect(b.y).toBe(850 - 120 - BUBBLE_GAP);
  });
});

describe("bubbleWindowBounds - 跨屏与边缘 clamp", () => {
  it("输入框贴近右缘时气泡右侧不越界", () => {
    const frame = { x: 1380, y: 500, width: 60, height: 40 };
    const b = bubbleWindowBounds({
      frame,
      bubbleHeight: 100,
      displays: [PRIMARY],
      cursor: { x: 0, y: 0 },
    });
    expect(b.x + b.width).toBeLessThanOrEqual(PRIMARY.x + PRIMARY.width - BUBBLE_EDGE_MARGIN);
  });

  it("输入框在副屏时按副屏工作区定位与 clamp", () => {
    const frame = { x: 1500, y: 300, width: 400, height: 40 };
    const b = bubbleWindowBounds({
      frame,
      bubbleHeight: 100,
      displays: [PRIMARY, SECONDARY],
      cursor: { x: 0, y: 0 },
    });
    // 归属副屏：x 起点在副屏范围内
    expect(b.x).toBeGreaterThanOrEqual(SECONDARY.x + BUBBLE_EDGE_MARGIN - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(SECONDARY.x + SECONDARY.width - BUBBLE_EDGE_MARGIN);
  });
});

describe("bubbleWindowBounds - 窗口 frame 兜底锚定", () => {
  it("无输入框 frame 但有窗口 frame 时贴窗口底部输入区（微信等 AX 不完整）", () => {
    const windowFrame = { x: 100, y: 100, width: 600, height: 500 };
    const b = bubbleWindowBounds({
      frame: null,
      windowFrame,
      bubbleHeight: 100,
      displays: [PRIMARY],
      cursor: { x: 0, y: 0 }, // 鼠标兜底不应生效
    });
    // 合成输入条锚 y = 100 + 500*0.72 = 460，height = 500*0.2 = 100；下方：y = 460 + 100 + 8 = 568
    expect(b.y).toBe(460 + 100 + BUBBLE_GAP);
    // 左缘对齐窗口左缘（-6）
    expect(b.x).toBe(100 - 6);
  });
});

describe("bubbleWindowBounds - 两 frame 皆缺兜底鼠标", () => {
  it("无 frame 且无窗口 frame 时置于鼠标所在屏中下方居中", () => {
    const b = bubbleWindowBounds({
      frame: null,
      bubbleHeight: 100,
      displays: [PRIMARY, SECONDARY],
      cursor: { x: 1600, y: 400 }, // 鼠标在副屏
    });
    // 归属副屏且水平居中附近
    const expectedX = Math.round(SECONDARY.x + (SECONDARY.width - BUBBLE_WIDTH) / 2);
    expect(b.x).toBe(expectedX);
    // 中下方：y 大于副屏中线
    expect(b.y).toBeGreaterThan(SECONDARY.y + SECONDARY.height / 2);
    // 不越出底部
    expect(b.y + b.height).toBeLessThanOrEqual(SECONDARY.y + SECONDARY.height - BUBBLE_EDGE_MARGIN);
  });
});
