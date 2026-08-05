import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { petActivity } from "./activity";
import { FLASH_MS } from "./types";

describe("petActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    petActivity.__reset();
  });
  afterEach(() => {
    petActivity.__reset();
    vi.useRealTimers();
  });

  describe("run 生命周期", () => {
    it("startRun 置 busy,endRun 归零", () => {
      petActivity.startRun("r1");
      expect(petActivity.snapshot().busy).toBe(true);
      petActivity.endRun("r1", true);
      expect(petActivity.snapshot().busy).toBe(false);
    });

    // 回归:run 崩溃/超时时若漏调 endRun,busy 会永久悬挂、宠物卡在 thinking。
    // 失败路径同样必须归零。
    it("失败收尾同样把 busy 归零", () => {
      petActivity.startRun("r1");
      petActivity.endRun("r1", false);
      expect(petActivity.snapshot().busy).toBe(false);
      expect(petActivity.snapshot().error).toBe(true);
    });

    it("并发 run:其中之一结束后 busy 仍为 true", () => {
      petActivity.startRun("r1");
      petActivity.startRun("r2");
      petActivity.endRun("r1", true);
      expect(petActivity.snapshot().busy).toBe(true);
      petActivity.endRun("r2", true);
      expect(petActivity.snapshot().busy).toBe(false);
    });

    it("startRun 幂等,不会重复计数", () => {
      petActivity.startRun("r1");
      petActivity.startRun("r1");
      petActivity.endRun("r1", true);
      expect(petActivity.snapshot().busy).toBe(false);
    });

    // 收尾之后姗姗来迟的事件不能把 run 复活,否则 busy 永久悬挂。
    it("收尾后迟到的 markRun 被忽略", () => {
      petActivity.startRun("r1");
      petActivity.endRun("r1", true);
      petActivity.markRun("r1", { phase: "text" });
      const s = petActivity.snapshot();
      expect(s.busy).toBe(false);
      expect(s.phase).toBeNull();
    });

    it("重试同一 run id 时可以重新开始", () => {
      petActivity.startRun("r1");
      petActivity.endRun("r1", false);
      petActivity.startRun("r1");
      expect(petActivity.snapshot().busy).toBe(true);
    });

    it("事件先于 startRun 到达时自动建档", () => {
      petActivity.markRun("r9", { toolRunning: true });
      const s = petActivity.snapshot();
      expect(s.busy).toBe(true);
      expect(s.toolRunning).toBe(true);
    });
  });

  describe("电平位与相位", () => {
    it("toolRunning 跨 run 取或", () => {
      petActivity.startRun("r1");
      petActivity.startRun("r2");
      petActivity.markRun("r1", { toolRunning: true });
      expect(petActivity.snapshot().toolRunning).toBe(true);
      petActivity.markRun("r1", { toolRunning: false });
      expect(petActivity.snapshot().toolRunning).toBe(false);
    });

    it("相位取最近一次更新(用单调序号定序,同毫秒也确定)", () => {
      petActivity.startRun("r1");
      petActivity.startRun("r2");
      petActivity.markRun("r1", { phase: "reasoning" });
      petActivity.markRun("r2", { phase: "text" });
      expect(petActivity.snapshot().phase).toBe("text");
      petActivity.markRun("r1", { phase: "reasoning" });
      expect(petActivity.snapshot().phase).toBe("reasoning");
    });

    it("只更新工具位时不改变相位归属", () => {
      petActivity.startRun("r1");
      petActivity.startRun("r2");
      petActivity.markRun("r1", { phase: "text" });
      petActivity.markRun("r2", { toolRunning: true });
      expect(petActivity.snapshot().phase).toBe("text");
    });
  });

  describe("审批挂起", () => {
    it("置位/解除,与 run 解耦", () => {
      petActivity.setAwaiting("s1", true);
      expect(petActivity.snapshot().awaitingInput).toBe(true);
      petActivity.setAwaiting("s1", false);
      expect(petActivity.snapshot().awaitingInput).toBe(false);
    });
  });

  describe("一次性位", () => {
    it("到期自动清零", () => {
      petActivity.flash("typing");
      expect(petActivity.snapshot().typing).toBe(true);
      vi.advanceTimersByTime(FLASH_MS.typing - 1);
      expect(petActivity.snapshot().typing).toBe(true);
      vi.advanceTimersByTime(1);
      expect(petActivity.snapshot().typing).toBe(false);
    });

    it("重复置位会重新计时(持续打字不会中途熄灭)", () => {
      petActivity.flash("typing");
      vi.advanceTimersByTime(FLASH_MS.typing - 100);
      petActivity.flash("typing");
      vi.advanceTimersByTime(FLASH_MS.typing - 100);
      expect(petActivity.snapshot().typing).toBe(true);
      vi.advanceTimersByTime(100);
      expect(petActivity.snapshot().typing).toBe(false);
    });

    it("endRun 按结果放 celebrate / error", () => {
      petActivity.startRun("r1");
      petActivity.endRun("r1", true);
      expect(petActivity.snapshot().celebrate).toBe(true);
      vi.advanceTimersByTime(FLASH_MS.celebrate);
      expect(petActivity.snapshot().celebrate).toBe(false);
    });
  });

  describe("subscribe", () => {
    it("位变化时通知,取消后不再通知", () => {
      const seen = vi.fn();
      const off = petActivity.subscribe(seen);
      petActivity.startRun("r1");
      expect(seen).toHaveBeenCalled();
      off();
      seen.mockClear();
      petActivity.markRun("r1", { phase: "text" });
      expect(seen).not.toHaveBeenCalled();
    });
  });
});
