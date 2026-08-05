import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePetStore } from "../store/pet";
import { petActivity } from "./activity";
import {
  MIN_STATE_VISIBLE_MS,
  SLEEP_AFTER_MS,
  STATE_SETTLE_MS,
  __isPetEngineRunning,
  startPetEngine,
  stopPetEngine,
} from "./engine";

const state = () => usePetStore.getState().state;

describe("startPetEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    petActivity.__reset();
    usePetStore.setState({ state: "idle" });
    startPetEngine();
  });
  afterEach(() => {
    stopPetEngine();
    petActivity.__reset();
    vi.useRealTimers();
  });

  describe("去抖:目标态需稳定 STATE_SETTLE_MS 才提交", () => {
    it("不到时限不提交,到点才提交", () => {
      petActivity.startRun("r1");
      vi.advanceTimersByTime(STATE_SETTLE_MS - 1);
      expect(state()).toBe("idle");
      vi.advanceTimersByTime(1);
      expect(state()).toBe("thinking");
    });

    // 核心价值:工具几十毫秒内一起一停时,状态必须被完全吞掉,而不是「先闪一下 working
    // 再改回来」。这正是 STATE_SETTLE_MS 存在的理由。
    it("工具快速起停:working 一次都不提交", () => {
      petActivity.startRun("r1");
      petActivity.markRun("r1", { phase: "reasoning" });
      vi.advanceTimersByTime(MIN_STATE_VISIBLE_MS);
      expect(state()).toBe("thinking");

      petActivity.markRun("r1", { toolRunning: true });
      vi.advanceTimersByTime(STATE_SETTLE_MS - 50); // 还没到提交时限
      petActivity.markRun("r1", { toolRunning: false }); // 工具已收尾,目标回到 thinking
      vi.advanceTimersByTime(5000);

      expect(state()).toBe("thinking"); // 全程没有出现过 working
    });

    it("同一目标重复触发不重置计时", () => {
      petActivity.startRun("r1");
      vi.advanceTimersByTime(100);
      petActivity.markRun("r1", { phase: "reasoning" }); // 目标仍是 thinking
      vi.advanceTimersByTime(STATE_SETTLE_MS - 100);
      expect(state()).toBe("thinking");
    });
  });

  describe("快通道:关键反馈 0 延迟", () => {
    it("failed 立即提交", () => {
      petActivity.flash("error");
      vi.advanceTimersByTime(0);
      expect(state()).toBe("failed");
    });

    it("waiting 立即提交", () => {
      petActivity.setAwaiting("s1", true);
      vi.advanceTimersByTime(0);
      expect(state()).toBe("waiting");
    });
  });

  describe("最小可见时长", () => {
    it("刚提交后的下一次普通切换要等满 MIN_STATE_VISIBLE_MS", () => {
      petActivity.setAwaiting("s1", true);
      vi.advanceTimersByTime(0);
      expect(state()).toBe("waiting");

      // 解除审批 → 目标变 idle(普通态,非快通道)
      petActivity.setAwaiting("s1", false);
      vi.advanceTimersByTime(MIN_STATE_VISIBLE_MS - 10);
      expect(state()).toBe("waiting"); // 还没到最小可见时长
      vi.advanceTimersByTime(10);
      expect(state()).toBe("idle");
    });
  });

  describe("过期二次确认", () => {
    it("延迟期间目标变了则不提交旧值", () => {
      petActivity.startRun("r1"); // 目标 thinking,排队中
      vi.advanceTimersByTime(STATE_SETTLE_MS - 20);
      petActivity.markRun("r1", { toolRunning: true }); // 目标改成 working
      vi.advanceTimersByTime(20);
      expect(state()).toBe("idle"); // 旧目标 thinking 没有被提交
      vi.advanceTimersByTime(STATE_SETTLE_MS);
      expect(state()).toBe("working");
    });
  });

  describe("入睡衰减", () => {
    it("安静满 SLEEP_AFTER_MS 后打盹", () => {
      vi.advanceTimersByTime(SLEEP_AFTER_MS + 2000);
      expect(state()).toBe("sleeping");
    });

    it("期间有活动就不入睡", () => {
      vi.advanceTimersByTime(SLEEP_AFTER_MS - 5000);
      petActivity.startRun("r1");
      vi.advanceTimersByTime(SLEEP_AFTER_MS - 5000);
      expect(state()).toBe("thinking");
    });

    it("睡着后来了活动会醒", () => {
      vi.advanceTimersByTime(SLEEP_AFTER_MS + 2000);
      expect(state()).toBe("sleeping");
      petActivity.startRun("r1");
      vi.advanceTimersByTime(STATE_SETTLE_MS);
      expect(state()).toBe("thinking");
    });
  });

  describe("启动守卫", () => {
    it("重复启动不会注册第二个 interval", () => {
      const spy = vi.spyOn(globalThis, "setInterval");
      startPetEngine(); // beforeEach 已经启动过一次
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("stop 之后可以重新启动", () => {
      stopPetEngine();
      expect(__isPetEngineRunning()).toBe(false);
      startPetEngine();
      expect(__isPetEngineRunning()).toBe(true);
    });

    it("stop 之后不再响应活动位", () => {
      stopPetEngine();
      petActivity.startRun("r1");
      vi.advanceTimersByTime(5000);
      expect(state()).toBe("idle");
    });
  });

  describe("端到端:一轮 agent 的姿态序列", () => {
    it("thinking → working →(工具结束)→ thinking → replying → happy", () => {
      petActivity.startRun("r1");
      vi.advanceTimersByTime(STATE_SETTLE_MS);
      expect(state()).toBe("thinking");

      petActivity.markRun("r1", { phase: "reasoning" });
      petActivity.markRun("r1", { toolRunning: true });
      vi.advanceTimersByTime(MIN_STATE_VISIBLE_MS);
      expect(state()).toBe("working");

      // 工具收尾:只清电平位,不设任何姿态——回落靠派生
      petActivity.markRun("r1", { toolRunning: false });
      vi.advanceTimersByTime(MIN_STATE_VISIBLE_MS);
      expect(state()).toBe("thinking");

      petActivity.markRun("r1", { phase: "text" });
      vi.advanceTimersByTime(MIN_STATE_VISIBLE_MS);
      expect(state()).toBe("replying");

      petActivity.endRun("r1", true);
      vi.advanceTimersByTime(0);
      expect(state()).toBe("happy");
    });
  });
});
