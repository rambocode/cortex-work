// 宠物活动位注册表:把「哪个 run 正在做什么」聚合成一份 PetActivity 快照。
//
// 为什么要按 run 记账而不是几个全局布尔:多个会话可以并发跑 agent,全局布尔会被
// 后结束的 run 提前清零(A、B 同时在跑,A 先结束 → busy=false,但 B 还在跑)。
// 按 run 记账 + 聚合是唯一能正确处理并发的做法。
//
// 时序契约:endRun 必须在所有失败/超时/崩溃兜底路径上都被调用,否则该 run 的记录
// 永远留在表里、busy 永久悬挂(宠物卡在 thinking)。这是接线时最容易漏的地方。

import { FLASH_MS, IDLE_ACTIVITY, type PetActivity, type PetFlashKind, type PetPhase } from "./types";

interface RunRecord {
  /** 该 run 是否有未收尾的工具调用(电平位)。 */
  toolOpen: boolean;
  /** 该 run 最近一次输出的相位。 */
  phase: PetPhase;
  /** 最近一次 markRun 的单调序号——用它给相位定序,而非 Date.now():
   * 同一毫秒内的多次事件用时间戳无法区分先后,序号可以。 */
  seq: number;
}

/** 一次 markRun 能更新的位。传 undefined 的字段保持不变。 */
export interface RunBits {
  phase?: PetPhase;
  toolRunning?: boolean;
}

const runs = new Map<string, RunRecord>();
/** 挂起中的审批 / 澄清。key 由调用方决定(会话 id 或 run id),与 runs 解耦:
 * 审批未必属于某个正在跑的 run。 */
const awaiting = new Set<string>();
/** 已收尾的 run。用于挡住收尾之后才姗姗来迟的事件——否则 markRun 会把 run
 * 重新创建出来,busy 永久悬挂。 */
const ended = new Set<string>();
const ENDED_KEEP = 32;

const flashOn: Record<PetFlashKind, boolean> = { error: false, celebrate: false, typing: false };
const flashTimers: Record<PetFlashKind, ReturnType<typeof setTimeout> | null> = {
  error: null,
  celebrate: null,
  typing: null,
};

const listeners = new Set<() => void>();
let seqCounter = 0;

function notify(): void {
  for (const fn of listeners) fn();
}

function rememberEnded(runId: string): void {
  ended.add(runId);
  // Set 保持插入顺序,超量时从最旧的开始丢。
  if (ended.size > ENDED_KEEP) {
    const oldest = ended.values().next();
    if (!oldest.done) ended.delete(oldest.value);
  }
}

function ensureRun(runId: string): RunRecord | null {
  const existing = runs.get(runId);
  if (existing) return existing;
  // 已收尾的 run 不再复活(见 `ended` 的注释)。
  if (ended.has(runId)) return null;
  const created: RunRecord = { toolOpen: false, phase: null, seq: ++seqCounter };
  runs.set(runId, created);
  return created;
}

function clearFlashTimer(kind: PetFlashKind): void {
  const timer = flashTimers[kind];
  if (timer) clearTimeout(timer);
  flashTimers[kind] = null;
}

export const petActivity = {
  /** run 开始。重复调用同一 id 是幂等的(重试场景会把它从 ended 里放回来)。 */
  startRun(runId: string): void {
    ended.delete(runId);
    if (!runs.has(runId)) runs.set(runId, { toolOpen: false, phase: null, seq: ++seqCounter });
    notify();
  },

  /** 更新该 run 的相位 / 工具电平位。run 未知时按「事件先于 startRun 到达」自动建档。 */
  markRun(runId: string, bits: RunBits): void {
    const rec = ensureRun(runId);
    if (!rec) return;
    if (bits.toolRunning !== undefined) rec.toolOpen = bits.toolRunning;
    if (bits.phase !== undefined) {
      rec.phase = bits.phase;
      rec.seq = ++seqCounter; // 只有相位更新才重新定序:工具位不参与「谁最近」的比较
    }
    notify();
  },

  /**
   * run 收尾。
   * ok=true 庆祝一下 / ok=false 给失败反馈 / 省略则静默收尾(只清账,不打扰用户)。
   * 静默档是给「说不清成败」的兜底路径用的——例如收到退出事件时 run 注册表已被
   * 看门狗清掉,此时报 failed 就是假警报。
   */
  endRun(runId: string, ok?: boolean): void {
    runs.delete(runId);
    rememberEnded(runId);
    awaiting.delete(runId);
    if (ok === undefined) {
      notify();
      return;
    }
    petActivity.flash(ok ? "celebrate" : "error"); // flash 内部已 notify
  },

  /** 审批 / 澄清的挂起与解除。 */
  setAwaiting(key: string, on: boolean): void {
    if (on) awaiting.add(key);
    else awaiting.delete(key);
    notify();
  },

  /** 置一个一次性位;重复调用会重新计时(例如持续打字)。 */
  flash(kind: PetFlashKind): void {
    clearFlashTimer(kind);
    flashOn[kind] = true;
    flashTimers[kind] = setTimeout(() => {
      flashTimers[kind] = null;
      flashOn[kind] = false;
      notify();
    }, FLASH_MS[kind]);
    notify();
  },

  /** 聚合出当前活动快照。 */
  snapshot(): PetActivity {
    let toolRunning = false;
    let phase: PetPhase = null;
    let phaseSeq = -1;
    for (const rec of runs.values()) {
      if (rec.toolOpen) toolRunning = true;
      // 相位取「最近一次更新过相位的 run」,并发时以最新的为准。
      if (rec.phase !== null && rec.seq > phaseSeq) {
        phase = rec.phase;
        phaseSeq = rec.seq;
      }
    }
    return {
      busy: runs.size > 0,
      toolRunning,
      awaitingInput: awaiting.size > 0,
      phase,
      error: flashOn.error,
      celebrate: flashOn.celebrate,
      typing: flashOn.typing,
    };
  },

  /** 订阅位变化。返回取消订阅函数。 */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** 仅测试:清空注册表与所有一次性位的定时器。 */
  __reset(): void {
    runs.clear();
    awaiting.clear();
    ended.clear();
    seqCounter = 0;
    for (const kind of ["error", "celebrate", "typing"] as const) {
      clearFlashTimer(kind);
      flashOn[kind] = false;
    }
    listeners.clear();
  },
};

export { IDLE_ACTIVITY };
