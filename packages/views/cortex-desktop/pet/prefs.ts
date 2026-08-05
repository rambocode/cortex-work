// 宠物偏好的持久化。core 不能碰 localStorage(包边界约束),故读写都在 views 层。
//
// 这里是**全仓唯一允许写宠物偏好的地方**:历史上 enabled 有 4 个写入点,每处都要手动
// 配对 setEnabled + savePetEnabled,漏一次就是「切了生效、重启回滚」(见 SidebarUserBar
// 的注释)。集中之后这类 bug 在结构上不再可能。

import type { PetKind } from "@cortex-work/core";
import { BUILTIN_KIND } from "./sheets";

export const PET_KIND_KEY = "cortex_pet_kind";
export const PET_SIZE_KEY = "cortex_pet_size";
export const PET_ENABLED_KEY = "cortex_pet_enabled";
/** 选中的 petdex 宠物 slug;缺省表示用内置角色。 */
export const PET_SLUG_KEY = "cortex_pet_slug";

export const PET_SIZE_MIN = 0.8;
export const PET_SIZE_MAX = 2;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 隐私模式 / 被禁用的 storage:一律当没设过
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 忽略 */
  }
}

/**
 * 内置角色。petdex 接入后内置只保留一只作兜底,造型选择交给图鉴的 4374 只;
 * 历史上持久化的 dog/mint 已无对应资产,统一迁回内置角色并清掉遗留 key
 * (不清的话老用户的 localStorage 里会一直留着一个没人读的死值)。
 */
export function loadPetKind(): PetKind {
  if (read(PET_KIND_KEY) !== null) write(PET_KIND_KEY, null);
  return BUILTIN_KIND;
}

export function loadPetSize(): number {
  const v = Number(read(PET_SIZE_KEY));
  return Number.isFinite(v) && v >= PET_SIZE_MIN && v <= PET_SIZE_MAX ? v : 1;
}

export function savePetSize(size: number): void {
  write(PET_SIZE_KEY, String(size));
}

// 只有显式的 "0" 代表隐藏:任何脏值都回落到「显示」,避免一个坏值让用户彻底看不到
// 宠物且无从恢复。
export function loadPetEnabled(): boolean {
  return read(PET_ENABLED_KEY) !== "0";
}

export function savePetEnabled(enabled: boolean): void {
  write(PET_ENABLED_KEY, enabled ? "1" : "0");
}

/** null = 用内置角色。 */
export function loadPetSlug(): string | null {
  const slug = read(PET_SLUG_KEY);
  return slug && slug.trim() ? slug.trim() : null;
}

export function savePetSlug(slug: string | null): void {
  write(PET_SLUG_KEY, slug);
}
