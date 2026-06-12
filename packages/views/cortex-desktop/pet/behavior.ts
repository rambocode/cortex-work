// 宠物行为模式的纯逻辑与持久化（沿用 designs.tsx 的 views 层 localStorage 模式）。
// 走动的逐帧位移是纯函数,方便单测边界折返。

import type { PetMode } from "@cortex-work/core";

export const PET_MODE_KEY = "cortex_pet_mode";
export const PET_WALK_KEY = "cortex_pet_walk";
export const PET_ENABLED_KEY = "cortex_pet_enabled";

/** 闲时走动的触发阈值:10 分钟没有任何事件才开始散步。 */
export const WALK_IDLE_DELAY_MS = 600_000;

const MODES: PetMode[] = ["free", "perch"];

export function loadPetMode(): PetMode {
  try {
    const m = localStorage.getItem(PET_MODE_KEY);
    if (m && (MODES as string[]).includes(m)) return m as PetMode;
    if (m === "walk") return "free"; // 旧版「底部走动」模式 → 自由放置 + 走动开关
  } catch {
    /* 忽略 */
  }
  return "free";
}

export function loadPetWalk(): boolean {
  try {
    return localStorage.getItem(PET_WALK_KEY) !== "0";
  } catch {
    return true;
  }
}

export function savePetWalk(walk: boolean): void {
  try {
    localStorage.setItem(PET_WALK_KEY, walk ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

export function savePetMode(mode: PetMode): void {
  try {
    localStorage.setItem(PET_MODE_KEY, mode);
  } catch {
    /* 忽略 */
  }
}

export function loadPetEnabled(): boolean {
  try {
    return localStorage.getItem(PET_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function savePetEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PET_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

/** 走动速度(px/s)。 */
export const WALK_SPEED = 32;

export interface WalkPos {
  x: number;
  /** 1 = 向右,-1 = 向左。 */
  dir: 1 | -1;
}

/**
 * 走动一帧:在 [min, max] 区间内匀速来回,越界时折返并把超出量反弹回来。
 * dt 单位毫秒;max <= min（窗口过窄）时原地停在 min。
 */
export function stepWalk(pos: WalkPos, dt: number, min: number, max: number, speed = WALK_SPEED): WalkPos {
  if (max <= min) return { x: min, dir: pos.dir };
  let x = pos.x + (pos.dir * speed * dt) / 1000;
  let dir = pos.dir;
  if (x > max) {
    x = max - (x - max);
    dir = -1;
  } else if (x < min) {
    x = min + (min - x);
    dir = 1;
  }
  // 反弹量仍可能越界(超大 dt):夹回区间内。
  x = Math.min(max, Math.max(min, x));
  return { x, dir };
}
