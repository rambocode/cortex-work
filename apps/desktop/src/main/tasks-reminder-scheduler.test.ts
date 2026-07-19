// tasks-reminder-scheduler.ts 单测（纯依赖注入，零 electron/croner mock）。
// 覆盖：opt-in 门控（关→无 Cron、无 blocker）、错过补跑「只补一次」+ 写 firedAt + 再 sync 不重触发、
// 非法/越界 at 跳过不影响同批、未来提醒到点触发、opt-in 开→关拆全部释放 blocker。
// 用 vi.useFakeTimers() 冻结系统时钟，deps.now 走 Date.now() 反映冻结时间。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TasksReminderScheduler,
  reminderAtInRange,
  REMINDER_MAX_FUTURE_MS,
  REMINDER_MAX_PAST_MS,
  type ReminderCronHandle,
  type TasksReminderSchedulerDeps,
} from "./tasks-reminder-scheduler";
import type { TaskMeta } from "./ipc/tasks-types";

const NOW = new Date("2026-07-01T12:00:00Z").getTime();

// 捕获建出的 Cron（记 at/cb，供手动触发）+ stop 追踪。
interface CapturedCron {
  at: number;
  cb: () => void;
  handle: ReminderCronHandle;
  stopped: boolean;
}

function makeDeps(over: Partial<TasksReminderSchedulerDeps> = {}) {
  const crons: CapturedCron[] = [];
  const createCron = vi.fn((at: Date, cb: () => void): ReminderCronHandle => {
    const entry: CapturedCron = { at: at.getTime(), cb, stopped: false, handle: { stop: () => {} } };
    entry.handle = { stop: vi.fn(() => { entry.stopped = true; }) };
    crons.push(entry);
    return entry.handle;
  });
  const notify = vi.fn();
  const markFired = vi.fn();
  // powerSaveBlocker 假实现：内部 id 状态 + spy。
  let nextId = 1;
  const started = new Set<number>();
  const powerSaveBlocker = {
    start: vi.fn(() => {
      const id = nextId++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      started.delete(id);
    }),
    isStarted: vi.fn((id: number) => started.has(id)),
  };
  const deps: TasksReminderSchedulerDeps = {
    now: () => Date.now(),
    createCron,
    notify,
    markFired,
    powerSaveBlocker,
    log: { warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, crons, createCron, notify, markFired, powerSaveBlocker };
}

function makeTask(over: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: over.id ?? `task-${Math.random().toString(36).slice(2)}`,
    title: "测试任务",
    status: "active",
    tags: [],
    source: "manual",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reminderAtInRange", () => {
  it("挡住非有限值与越界值，放行合理区间", () => {
    expect(reminderAtInRange(NaN, NOW)).toBe(false);
    expect(reminderAtInRange(Infinity, NOW)).toBe(false);
    expect(reminderAtInRange(NOW - REMINDER_MAX_PAST_MS - 1, NOW)).toBe(false); // 太老
    expect(reminderAtInRange(NOW + REMINDER_MAX_FUTURE_MS + 1, NOW)).toBe(false); // 太远
    expect(reminderAtInRange(NOW + 60_000, NOW)).toBe(true);
    expect(reminderAtInRange(NOW - 60_000, NOW)).toBe(true); // 宽限内的过去
  });
});

describe("TasksReminderScheduler — opt-in 门控", () => {
  it("opt-in 关：不建任何 Cron、不持 blocker、不投递", () => {
    const { deps, createCron, notify, powerSaveBlocker } = makeDeps();
    const s = new TasksReminderScheduler(deps); // 默认 enabled=false
    s.sync([makeTask({ reminder: { at: NOW + 60_000 } })]);
    expect(createCron).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("opt-in 开→关：拆掉全部 Cron 并释放 blocker", () => {
    const { deps, crons, powerSaveBlocker } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    s.sync([makeTask({ reminder: { at: NOW + 60_000 } })]);
    expect(crons).toHaveLength(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);

    s.setEnabled(false);
    expect(crons[0]!.stopped).toBe(true);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });
});

describe("TasksReminderScheduler — 错过补跑「只补一次」", () => {
  it("at<now 且未 firedAt：立即补触发一次 + 写 firedAt；带 firedAt 的列表再 sync 不重触发", () => {
    const { deps, notify, markFired, createCron } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);

    const task = makeTask({ id: "t1", reminder: { at: NOW - 1000 } });
    s.sync([task]);
    // 过去时刻 → 补触发（非建 Cron）。
    expect(notify).toHaveBeenCalledTimes(1);
    expect(createCron).not.toHaveBeenCalled();
    expect(markFired).toHaveBeenCalledTimes(1);
    expect(markFired.mock.calls[0]![1]).toBe(NOW); // firedAt = now

    // 模拟持久化后：store 回灌的列表已带 firedAt → 再 sync 不重触发（firedAt 幂等闸门）。
    const fired = makeTask({ id: "t1", reminder: { at: NOW - 1000, firedAt: NOW } });
    s.sync([fired]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("补触发后 opt-in 关再开：用自更新快照，不重复补触发", () => {
    const { deps, notify } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    s.sync([makeTask({ id: "t1", reminder: { at: NOW - 1000 } })]);
    expect(notify).toHaveBeenCalledTimes(1);

    // setEnabled 用 lastTasks 重排；若快照未自更新 firedAt 会重复补触发。
    s.setEnabled(false);
    s.setEnabled(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("TasksReminderScheduler — 非法 at 跳过不影响同批", () => {
  it("NaN / 越界 at 跳过，同批合法未来提醒仍建 Cron", () => {
    const { deps, crons, notify } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    s.sync([
      makeTask({ id: "bad-nan", reminder: { at: Number.NaN } }),
      makeTask({ id: "bad-far", reminder: { at: NOW + REMINDER_MAX_FUTURE_MS + 1_000 } }),
      makeTask({ id: "good", reminder: { at: NOW + 60_000 } }),
    ]);
    expect(notify).not.toHaveBeenCalled();
    // 仅合法的 good 建了 Cron。
    expect(crons).toHaveLength(1);
    expect(crons[0]!.at).toBe(NOW + 60_000);
  });

  // 产品决策：提醒一经设置一律触发，不看任务状态（用户会在已完结任务上显式设提醒并预期它响）。
  it("已完结任务（done/dropped）照常调度，到点照常投递", () => {
    const { deps, crons, notify, markFired } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    s.sync([
      makeTask({ id: "done", status: "done", reminder: { at: NOW + 60_000 } }),
      makeTask({ id: "dropped", status: "dropped", reminder: { at: NOW + 60_000 } }),
    ]);
    expect(crons).toHaveLength(2);
    // 到点触发：fire 复核不拦已完结状态，正常投递 + 写 firedAt。
    crons[0]!.cb();
    crons[1]!.cb();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(markFired).toHaveBeenCalledTimes(2);
  });
});

describe("TasksReminderScheduler — 未来提醒到点触发", () => {
  it("建 Cron；手动触发 cb → 投递 + 写 firedAt + 停 job", () => {
    const { deps, crons, notify, markFired } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    const task = makeTask({ id: "future", reminder: { at: NOW + 60_000 } });
    s.sync([task]);
    expect(crons).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();

    // 到点：croner 会调 cb。这里手动触发。
    crons[0]!.cb();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(markFired).toHaveBeenCalledTimes(1);
    expect(crons[0]!.stopped).toBe(true);
  });
});

describe("TasksReminderScheduler — 并发/竞态闸门（correctness 复核 P2）", () => {
  it("并发第二个 sync 仍持 firedAt=null 陈旧 list → firedThisSession 闸门拦住，不重复补触发", () => {
    const { deps, notify } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    s.sync([makeTask({ id: "t1", reminder: { at: NOW - 1000 } })]);
    expect(notify).toHaveBeenCalledTimes(1);
    // 模拟并发第二个 emitChanged：markFired 落盘前，仍是 firedAt=null 的**新**陈旧对象
    //（会覆盖 fire 就地标记的本地快照 → 只剩 firedThisSession 这道跨 sync 闸门拦它）。
    s.sync([makeTask({ id: "t1", reminder: { at: NOW - 1000 } })]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("删提醒瞬间旧 Cron 触发：fire 复核发现提醒已删 → no-op（不弹、不写 firedAt、不复活）", () => {
    const { deps, crons, notify, markFired } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    s.sync([makeTask({ id: "t1", reminder: { at: NOW + 60_000 } })]);
    const oldCron = crons[0]!;
    // 用户删除提醒 → sync 拆旧 Cron；保留 oldCron 引用模拟「拆除窗口内旧 Cron 仍触发」。
    s.sync([makeTask({ id: "t1", reminder: undefined })]);
    oldCron.cb();
    expect(notify).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
  });

  it("用户改提醒时间：重设的新 at 能再次触发（prune 清掉旧闸门）", () => {
    const { deps, notify } = makeDeps();
    const s = new TasksReminderScheduler(deps);
    s.setEnabled(true);
    s.sync([makeTask({ id: "t1", reminder: { at: NOW - 1000 } })]); // 补触发 #1
    expect(notify).toHaveBeenCalledTimes(1);
    // 用户把提醒改到另一个过去时刻（新 at，firedAt 清空）→ 应能再补触发。
    s.sync([makeTask({ id: "t1", reminder: { at: NOW - 500 } })]);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
