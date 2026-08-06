// 宠物状态机的输入模型。
//
// 分层约定:本文件是「活动视角」——描述系统正在发生什么(在跑 / 在调工具 / 在等人),
// 而 PetState(store/pet.ts)是「渲染意图」——描述宠物该摆什么姿态。两层词汇不同是
// 分层的结果而非不一致:derive.ts 是二者之间唯一的翻译函数。
//
// 活动位分三类,清位责任不同——这是「工具结束后回不到 thinking」这类 bug 的根治点:
//   level  电平位:有明确成对的 起/止 信号,由 start/end 显式翻转,绝不被别的事件顺手清掉。
//   phase  相位位:互斥的「当前在干什么」,后到的事件覆盖前到的是正确语义。
//   flash  一次性位:置位后由 activity.ts 内的定时器自动清,消费端完全无状态。

/** 相位位:最近一次输出的性质。null = 尚无输出。 */
export type PetPhase = "reasoning" | "text" | null;

export interface PetActivity {
  // ── level(成对信号,跨 run 聚合)────────────────────────────────
  /** 至少一个 run 在跑。 */
  busy: boolean;
  /** 至少一个 run 有未收尾的工具调用。 */
  toolRunning: boolean;
  /** 有挂起的审批 / 澄清,等用户点一下。 */
  awaitingInput: boolean;
  // ── phase(最近一次相位,互斥)──────────────────────────────────
  phase: PetPhase;
  // ── flash(自动清位)────────────────────────────────────────────
  /** 运行失败。 */
  error: boolean;
  /** 成功收尾 / 被用户逗。 */
  celebrate: boolean;
  /** 用户正在打字。 */
  typing: boolean;
}

/** 一次性位的种类(与 PetActivity 里的三个 flash 字段一一对应)。 */
export type PetFlashKind = "error" | "celebrate" | "typing";

/**
 * 一次性位的存活时长(毫秒)。
 * 约定:必须 ≥ 对应动画播完一轮的时长,否则位先清掉、动画被打断在半途。
 */
export const FLASH_MS: Record<PetFlashKind, number> = {
  error: 1600,
  celebrate: 2200,
  typing: 1600,
};

/** 全空活动 = 什么都没发生。 */
export const IDLE_ACTIVITY: PetActivity = {
  busy: false,
  toolRunning: false,
  awaitingInput: false,
  phase: null,
  error: false,
  celebrate: false,
  typing: false,
};
