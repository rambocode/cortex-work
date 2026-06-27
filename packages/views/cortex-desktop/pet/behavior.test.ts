import { afterEach, describe, expect, it } from "vitest";
import {
  PET_ENABLED_KEY,
  PET_MODE_KEY,
  PET_WALK_KEY,
  loadPetEnabled,
  loadPetMode,
  loadPetWalk,
  savePetEnabled,
  savePetMode,
  savePetWalk,
  stepWalk,
} from "./behavior";

describe("stepWalk 走动逐帧位移", () => {
  it("向右匀速前进:速度 × dt", () => {
    const next = stepWalk({ x: 100, dir: 1 }, 1000, 0, 500, 32);
    expect(next).toEqual({ x: 132, dir: 1 });
  });

  it("向左前进", () => {
    const next = stepWalk({ x: 100, dir: -1 }, 500, 0, 500, 32);
    expect(next).toEqual({ x: 84, dir: -1 });
  });

  it("到达右边界:反弹掉头向左", () => {
    const next = stepWalk({ x: 495, dir: 1 }, 1000, 0, 500, 32);
    // 495 + 32 = 527,超出 27 → 反弹到 500 - 27 = 473
    expect(next).toEqual({ x: 473, dir: -1 });
  });

  it("到达左边界:反弹掉头向右", () => {
    const next = stepWalk({ x: 5, dir: -1 }, 1000, 0, 500, 32);
    expect(next).toEqual({ x: 27, dir: 1 });
  });

  it("超大 dt 反弹后仍越界:夹回区间内", () => {
    const next = stepWalk({ x: 0, dir: 1 }, 60_000, 0, 100, 32);
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.x).toBeLessThanOrEqual(100);
  });

  it("窗口过窄(max <= min):原地停在 min", () => {
    expect(stepWalk({ x: 50, dir: 1 }, 1000, 0, -10, 32)).toEqual({ x: 0, dir: 1 });
  });
});

describe("mode / walk / enabled 持久化", () => {
  afterEach(() => {
    localStorage.removeItem(PET_MODE_KEY);
    localStorage.removeItem(PET_WALK_KEY);
    localStorage.removeItem(PET_ENABLED_KEY);
  });

  it("默认 mode = free,非法值回退默认", () => {
    expect(loadPetMode()).toBe("free");
    localStorage.setItem(PET_MODE_KEY, "bogus");
    expect(loadPetMode()).toBe("free");
  });

  it("旧版「底部走动」模式值迁移为 free", () => {
    localStorage.setItem(PET_MODE_KEY, "walk");
    expect(loadPetMode()).toBe("free");
  });

  it("save / load 往返:mode / walk / enabled", () => {
    savePetMode("perch");
    expect(loadPetMode()).toBe("perch");
    savePetMode("free");
    expect(loadPetMode()).toBe("free");

    expect(loadPetWalk()).toBe(false); // 默认关(自由放置,不自动巡逻)
    savePetWalk(true);
    expect(loadPetWalk()).toBe(true);
    savePetWalk(false);
    expect(loadPetWalk()).toBe(false);

    expect(loadPetEnabled()).toBe(true); // 默认显示
    savePetEnabled(false);
    expect(loadPetEnabled()).toBe(false);
    savePetEnabled(true);
    expect(loadPetEnabled()).toBe(true);
  });
});
