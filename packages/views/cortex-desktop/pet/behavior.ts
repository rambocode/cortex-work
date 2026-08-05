// 宠物显隐的持久化（沿用 designs.tsx 的 views 层 localStorage 模式）。
//
// 曾经这里还有「行为模式(free/perch)」与「闲时底部走动(walk)」两套设置,均已随
// 对应特性一并退役:perch 是仅 SVG 的旧趴姿造型,walk 是默认关闭的隐藏巡逻能力。
// 遗留的 cortex_pet_mode / cortex_pet_walk 两个 key 不再有任何读取方,留在用户
// localStorage 里无害;偏好收敛到统一 prefs 模块时会一并清理。

export const PET_ENABLED_KEY = "cortex_pet_enabled";

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
