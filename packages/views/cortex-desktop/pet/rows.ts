// petdex sprite 的「宠物姿态 → sheet 行号」映射。纯数据 + 两个纯函数。
//
// 行的语义是实测比对 sprite 反推的(petdex 的 petjson 不含帧布局,上游没有任何文档):
//   0 idle / 1 running-right / 2 running-left / 3 waving / 4 jumping
//   5 failed / 6 waiting / 7 running / 8 review
// 以 sadaharu(白狗)为例逐行可辨:行 0 坐姿眨眼、行 1/2 朝右/朝左奔跑、行 3 抬爪挥手、
// 行 4 腾空跳跃、行 5 垂耳落泪、行 6 平静站立、行 7 皱眉忙动、行 8 蹙眉思考。
// 11 行的 sprite 前 9 行语义一致,多出的第 9、10 行含义未知,忽略。

import type { PetState } from "@cortex-work/core";

/**
 * 每个姿态一条**降级链**,运行时取第一个落在实际行数内的行号。
 *
 * 为什么必须是链而不是单个行号:petdex 的网格行数并不统一(实测 8/9/11 三种)。
 * 参考实现 hermes-studio 硬编码 9 行,对只有 8 行的 sprite,review(行 8)会算出
 * sy = 8×208 = 1664 —— 正好等于图高,drawImage 的源矩形整个落在图外,画出来是空白。
 */
export const ROW_FALLBACK: Record<PetState, readonly number[]> = {
  idle: [0],
  // typing 与 waiting 共用「等人」的注视姿态:两个应用态,一种视觉语义。
  // 若日后觉得不够区分,改这一行数据即可,不涉及任何逻辑。
  typing: [6, 0],
  waiting: [6, 0],
  thinking: [8, 7, 0], // review → 缺则退 running → 再退 idle
  working: [7, 1, 0], // running(行 1 是奔跑姿态,作回落合理)
  replying: [3, 0], // waving:有「在表达」的意味
  happy: [4, 3, 0], // jumping
  failed: [5, 0],
  // petdex 没有睡眠行:复用 idle 行 + 放慢帧率 + DOM 的 Zzz 配件补足语义,
  // 不画假帧(见 PetCanvas 的 SLEEP_SLOWDOWN)。
  sleeping: [0],
};

/** 播到末帧就停住、不循环的姿态。它们是一次性反馈,循环播会显得抽搐。 */
export const ONE_SHOT: ReadonlySet<PetState> = new Set<PetState>(["happy", "failed"]);

/** sleeping 复用 idle 行时的帧间隔倍率——视觉上就是「呼吸变慢了」。 */
export const SLEEP_SLOWDOWN = 3;

/**
 * 按降级链解析行号;链上全部越界时钳到 0。
 * idle 行(0)在任何合法 sprite 里都存在,是最后的安全网。
 */
export function resolveRow(chain: readonly number[], rows: number): number {
  for (const row of chain) if (row < rows) return row;
  return 0;
}
