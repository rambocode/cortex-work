// 桌面宠物状态机的对外入口(子路径 `@cortex-work/core/pet`)。
// 分工:types 定义活动位模型、derive 是唯一的「活动 → 姿态」翻译、
// activity 按 run 记账并聚合、engine 订阅并去抖后写入 store。

export { derivePetState } from "./derive";
export { petActivity, type RunBits } from "./activity";
export {
  startPetEngine,
  stopPetEngine,
  MIN_STATE_VISIBLE_MS,
  SLEEP_AFTER_MS,
  STATE_SETTLE_MS,
  __isPetEngineRunning,
} from "./engine";
export { FLASH_MS, IDLE_ACTIVITY, type PetActivity, type PetFlashKind, type PetPhase } from "./types";
