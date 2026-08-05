// 宠物状态机的驱动:订阅活动位 → 派生目标姿态 → 去抖后写入 store。
//
// ⚠️ 跨窗口契约(桌面端最容易踩错的地方):
// **必须且只能在「事件产生方」窗口调用一次** —— 桌面端是主窗口(PetBridge),
// Web 端是同一个窗口。pet-overlay 窗口是纯镜像,绝不能调用。
// 原因:活动位(runs、审批挂起、输入框 onChange)只存在于主窗口的渲染进程内存里;
// 而且两个窗口各跑一个时钟去写同一份镜像会互相回滚——重构前 overlay 自己把 happy
// 衰减成 idle、主窗口下一次广播又把它顶回 happy,就是这个毛病。
//
// 为什么需要去抖:AI 事件流是密集的(工具几十毫秒内一起一停、相位来回切),直接把
// 派生结果写进 store 会让宠物疯狂抽搐。两个常量就够了,不需要引入状态机库。

import { usePetStore, type PetState } from "../store/pet";
import { petActivity } from "./activity";
import { derivePetState } from "./derive";

/** 目标态需连续稳定这么久才提交(压掉工具快速起停造成的抖动)。 */
export const STATE_SETTLE_MS = 180;
/** 已提交的姿态至少可见这么久(压掉「闪一下就没了」)。 */
export const MIN_STATE_VISIBLE_MS = 520;
/** 安静这么久后打盹。 */
export const SLEEP_AFTER_MS = 120_000;
/** 入睡判定的轮询间隔——唯一保留的周期性定时器,其余全部事件驱动。 */
const SLEEP_TICK_MS = 1000;

/**
 * 走 0 延迟快通道的姿态:这些反馈迟到就失去意义。
 * failed / waiting 是「需要用户立刻知道」,happy 是点击的即时手感。
 */
const FAST_PATH: ReadonlySet<PetState> = new Set<PetState>(["failed", "waiting", "happy"]);

let running = false;
let unsubscribe: (() => void) | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let sleepTimer: ReturnType<typeof setInterval> | null = null;
/** 最近一次提交的时刻,用于计算最小可见时长。 */
let committedAt = 0;
/** 最近一次「不是闲着」的时刻,用于入睡判定。engine 自己记时,不依赖 store。 */
let lastNonIdleAt = 0;
/** 已排队等待提交的目标态。同一目标重复触发时不重置计时,否则永远等不到稳定。 */
let pendingTarget: PetState | null = null;

function clearSettle(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
}

/** 派生目标姿态,并在派生结果为闲置时按静默时长覆写成 sleeping。 */
function targetState(): PetState {
  const base = derivePetState(petActivity.snapshot());
  if (base !== "idle") return base;
  return Date.now() - lastNonIdleAt >= SLEEP_AFTER_MS ? "sleeping" : "idle";
}

function commit(next: PetState): void {
  clearSettle();
  pendingTarget = null;
  committedAt = Date.now();
  if (usePetStore.getState().state !== next) usePetStore.setState({ state: next });
}

function schedule(): void {
  const next = targetState();
  // 「有动静」的判定用派生结果而非活动位本身:sleeping 也是一种闲置,不能刷新计时,
  // 否则宠物睡着后 sleeping 自己不断刷新 lastNonIdleAt,再也醒不过来也睡不踏实。
  if (next !== "idle" && next !== "sleeping") lastNonIdleAt = Date.now();

  const current = usePetStore.getState().state;
  if (next === current) {
    // 目标回到了当前显示值:取消在途的排队(这正是「抖动被压掉、一次都不提交」的路径)。
    clearSettle();
    pendingTarget = null;
    return;
  }
  if (pendingTarget === next) return; // 已在排队,保持原计时

  clearSettle();
  pendingTarget = next;
  const elapsed = Date.now() - committedAt;
  const delay = FAST_PATH.has(next) ? 0 : Math.max(STATE_SETTLE_MS, MIN_STATE_VISIBLE_MS - elapsed);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    // 二次确认:延迟期间目标可能已经变了,提交一个早已不成立的姿态就是「过期提交」。
    if (targetState() !== next) {
      pendingTarget = null;
      schedule();
      return;
    }
    commit(next);
  }, delay);
}

/**
 * 启动状态机。返回停止函数。
 * 幂等:重复启动会被守卫挡掉(React StrictMode 的双挂载是「装-卸-装」的顺序,安全)。
 */
export function startPetEngine(): () => void {
  if (running) return () => {};
  running = true;
  // committedAt 归零而非取当前时刻:启动时还没提交过任何姿态,没有「需要保护显示时长」
  // 的东西。取当前时刻会让第一次切换白等一个 MIN_STATE_VISIBLE_MS。
  committedAt = 0;
  lastNonIdleAt = Date.now();
  unsubscribe = petActivity.subscribe(schedule);
  sleepTimer = setInterval(schedule, SLEEP_TICK_MS);
  schedule();
  return stopPetEngine;
}

export function stopPetEngine(): void {
  running = false;
  unsubscribe?.();
  unsubscribe = null;
  clearSettle();
  if (sleepTimer) clearInterval(sleepTimer);
  sleepTimer = null;
  pendingTarget = null;
}

/** 仅测试:探查是否已在运行。 */
export function __isPetEngineRunning(): boolean {
  return running;
}
