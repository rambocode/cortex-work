import { describe, it, expect } from "vitest";
import {
  defaultProjectsBounds,
  clampProjectsBounds,
  boundsToPersist,
  PROJECTS_WINDOW_DEFAULT_WIDTH,
  PROJECTS_WINDOW_DEFAULT_HEIGHT,
  PROJECTS_WINDOW_MIN_WIDTH,
  PROJECTS_WINDOW_MIN_HEIGHT,
} from "./projects-window-geometry";

describe("defaultProjectsBounds", () => {
  it("在工作区内居中、取默认尺寸", () => {
    const wa = { x: 0, y: 0, width: 1440, height: 900 };
    const b = defaultProjectsBounds(wa);
    expect(b.width).toBe(PROJECTS_WINDOW_DEFAULT_WIDTH);
    expect(b.height).toBe(PROJECTS_WINDOW_DEFAULT_HEIGHT);
    expect(b.x).toBe(Math.round((1440 - PROJECTS_WINDOW_DEFAULT_WIDTH) / 2));
    expect(b.y).toBe(Math.round((900 - PROJECTS_WINDOW_DEFAULT_HEIGHT) / 2));
  });

  it("尊重工作区偏移（多显示器 / 菜单栏）", () => {
    const wa = { x: 100, y: 25, width: 1440, height: 900 };
    const b = defaultProjectsBounds(wa);
    expect(b.x).toBe(Math.round(100 + (1440 - PROJECTS_WINDOW_DEFAULT_WIDTH) / 2));
    expect(b.y).toBe(Math.round(25 + (900 - PROJECTS_WINDOW_DEFAULT_HEIGHT) / 2));
  });

  it("小屏时尺寸夹到工作区上限（不溢出）", () => {
    const wa = { x: 0, y: 0, width: 800, height: 600 };
    const b = defaultProjectsBounds(wa);
    expect(b.width).toBe(800);
    expect(b.height).toBe(600);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });
});

describe("clampProjectsBounds", () => {
  const primary = { x: 0, y: 0, width: 1440, height: 900 };

  it("存档 bounds 落在已断开显示器区域 → clamp 回现存工作区", () => {
    // 外接屏在 x=2000 处，已断开；仅剩主屏。存档整块离屏。
    const saved = { x: 2200, y: 300, width: 1000, height: 700 };
    const b = clampProjectsBounds(saved, [primary]);
    // 与主屏无交叠 → 落到主屏并夹回其内。
    expect(b.width).toBe(1000);
    expect(b.height).toBe(700);
    expect(b.x).toBe(1440 - 1000); // 夹回右缘内
    expect(b.y).toBe(900 - 700); // 夹回下缘内（300 > 200 上限）
    expect(b.x + b.width).toBeLessThanOrEqual(primary.x + primary.width);
    expect(b.y + b.height).toBeLessThanOrEqual(primary.y + primary.height);
  });

  it("存档 bounds 在现存显示器内 → 原样透传", () => {
    const saved = { x: 100, y: 80, width: 1000, height: 700 };
    const b = clampProjectsBounds(saved, [primary]);
    expect(b).toEqual(saved);
  });

  it("选与之交叠最多的工作区作为夹取目标", () => {
    const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };
    // 大部分落在副屏。
    const saved = { x: 1600, y: 100, width: 1000, height: 700 };
    const b = clampProjectsBounds(saved, [primary, secondary]);
    expect(b).toEqual(saved); // 完整落在副屏内 → 不变
  });

  it("尺寸小于最小值时夹到最小尺寸", () => {
    const saved = { x: 10, y: 10, width: 300, height: 200 };
    const b = clampProjectsBounds(saved, [primary]);
    expect(b.width).toBe(PROJECTS_WINDOW_MIN_WIDTH);
    expect(b.height).toBe(PROJECTS_WINDOW_MIN_HEIGHT);
  });

  it("工作区为空时原样返回（防御）", () => {
    const saved = { x: 10, y: 10, width: 900, height: 700 };
    expect(clampProjectsBounds(saved, [])).toEqual(saved);
  });
});

describe("boundsToPersist", () => {
  const normal = { x: 100, y: 100, width: 1000, height: 700 };

  it("正常态返回正常 bounds", () => {
    expect(boundsToPersist(normal, { minimized: false, fullscreen: false })).toEqual(normal);
  });

  it("最小化态返回 null（不覆盖正常值）", () => {
    expect(boundsToPersist(normal, { minimized: true, fullscreen: false })).toBeNull();
  });

  it("全屏态返回 null（不覆盖正常值）", () => {
    expect(boundsToPersist(normal, { minimized: false, fullscreen: true })).toBeNull();
  });
});
