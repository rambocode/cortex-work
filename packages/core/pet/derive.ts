// 活动位 → 宠物姿态的唯一翻译函数。
//
// 刻意做成「优先级链」而非状态转移表:没有非法转移的概念(任意态可到任意态),
// 加一个状态 = 加一个活动位 + 加一行判断,不会状态爆炸。
// 纯函数、零 import 副作用:同一份 activity 永远派生出同一个 PetState,便于表驱动测试。

import type { PetState } from "../store/pet";
import type { PetActivity } from "./types";

/**
 * 优先级自上而下 = 「打断力」由强到弱。
 *
 * 两处顺序是刻意的,改动前请先想清楚:
 * - `toolRunning` 必须高于 `phase === "text"`:工具跑起来时即使上一次输出是正文,
 *   也应显示 working,否则会出现「边跑工具边显示在回话」。反过来,工具一结束电平位
 *   清零,phase 仍停在 reasoning → 自动落回 thinking——**回落是派生的副产品,
 *   不需要任何调用方记得去设置它**。
 * - `typing` 垫底:用户边打字边等 agent 回复时,应该显示 agent 在忙而不是「在看你打字」。
 *
 * sleeping 不在这里:它是「安静了多久」的时间函数,不是活动位的函数,放进来会让本函数
 * 依赖 Date.now() 而失去纯度。由 engine.ts 在派生结果为 idle 时按静默时长覆写。
 */
export function derivePetState(a: PetActivity): PetState {
  if (a.error) return "failed";
  if (a.celebrate) return "happy";
  if (a.awaitingInput) return "waiting";
  if (a.toolRunning) return "working";
  if (a.phase === "text") return "replying";
  if (a.phase === "reasoning" || a.busy) return "thinking";
  if (a.typing) return "typing";
  return "idle";
}
