// 宠物偏好的唯一读写端口。core 不能碰 localStorage(包边界约束),故落在 views 层。
//
// **这是全仓唯一允许写宠物偏好的地方**。历史上 enabled 有 4 个写入点(设置页、侧栏菜单、
// 宠物自己的 ✕、overlay 回写),每处都要手动配对「改 store」+「写盘」,漏一次就是
// 「切了生效、重启回滚」(见 SidebarUserBar 的注释)。收敛成 patchPetPrefs 之后,
// 调用方不需要记得配对任何东西,这类 bug 在结构上不再可能。
//
// 存储位置:两端都用 localStorage。桌面端**只有主窗口**读写它——pet-overlay 是 file://
// 页面,与主窗口不同源、storage 互不可见,它的设置全部来自主进程广播的快照。

import { usePetStore } from "@cortex-work/core";
import { BUILTIN_KIND } from "./sheets";

export const PET_SIZE_KEY = "cortex_pet_size";
export const PET_ENABLED_KEY = "cortex_pet_enabled";
/** 选中的 petdex 宠物 slug;缺省表示用内置角色。 */
export const PET_SLUG_KEY = "cortex_pet_slug";

/** 已退役特性遗留的 key。没有任何读取方,留着只会让用户的 storage 越积越脏。 */
const LEGACY_KEYS = ["cortex_pet_kind", "cortex_pet_mode", "cortex_pet_walk", "cortex_pet_color"] as const;

export const PET_SIZE_MIN = 0.8;
export const PET_SIZE_MAX = 2;

export interface PetPrefs {
  enabled: boolean;
  size: number;
  /** null = 用内置角色。 */
  slug: string | null;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 隐私模式 / storage 被禁用:一律当没设过
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

export function loadPetPrefs(): PetPrefs {
  const size = Number(read(PET_SIZE_KEY));
  const slug = read(PET_SLUG_KEY);
  return {
    // 只有显式的 "0" 代表隐藏:任何脏值都回落到「显示」,避免一个坏值让用户彻底
    // 看不到宠物、又不知道去哪儿打开。
    enabled: read(PET_ENABLED_KEY) !== "0",
    size: Number.isFinite(size) && size >= PET_SIZE_MIN && size <= PET_SIZE_MAX ? size : 1,
    slug: slug && slug.trim() ? slug.trim() : null,
  };
}

/**
 * 部分更新偏好:内部同时更新运行时 store 与持久层,调用方不需要配对任何东西。
 * slug 只落盘不进 store —— store 里存的是解析后的 sprite(见 source 解析流程),
 * 由 PetBridge 负责把 slug 变成可渲染的 PetSpriteSource。
 */
export function patchPetPrefs(next: Partial<PetPrefs>): void {
  if (next.enabled !== undefined) {
    write(PET_ENABLED_KEY, next.enabled ? "1" : "0");
    usePetStore.getState().setEnabled(next.enabled);
  }
  if (next.size !== undefined) {
    write(PET_SIZE_KEY, String(next.size));
    usePetStore.getState().setSize(next.size);
  }
  if (next.slug !== undefined) write(PET_SLUG_KEY, next.slug);
}

/**
 * 清理已退役特性遗留的 localStorage key(perch 模式、巡逻走动、自定义配色、旧角色选择)。
 * 幂等,只在主窗口跑一次即可。
 */
export function cleanupLegacyPetKeys(): void {
  for (const key of LEGACY_KEYS) if (read(key) !== null) write(key, null);
}

/** 内置角色 id。保留具名导出,避免调用方到处 import BUILTIN_KIND。 */
export { BUILTIN_KIND };
