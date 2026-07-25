// kill-all 单测：退出钩子用的全局注册表。
import { afterEach, describe, expect, it } from "vitest";
import {
  killAllResearchWorkers,
  registerResearchWorker,
  unregisterResearchWorker,
} from "./kill-all";

/// 最小可杀对象替身。
function fakeKillable() {
  let killed = 0;
  return { kill: () => (killed += 1), get killed() { return killed; } };
}

afterEach(() => {
  killAllResearchWorkers();
});

describe("killAllResearchWorkers", () => {
  it("杀掉全部已注册的 Worker 并清空注册表", () => {
    const a = fakeKillable();
    const b = fakeKillable();
    registerResearchWorker(a);
    registerResearchWorker(b);

    expect(killAllResearchWorkers()).toBe(2);
    expect(a.killed).toBe(1);
    expect(b.killed).toBe(1);
    // 第二次调用没有目标可杀。
    expect(killAllResearchWorkers()).toBe(0);
  });

  it("已注销的 Worker 不会再被杀", () => {
    const a = fakeKillable();
    registerResearchWorker(a);
    unregisterResearchWorker(a);
    expect(killAllResearchWorkers()).toBe(0);
    expect(a.killed).toBe(0);
  });

  it("单个 kill 抛错不影响其余（退出钩子必须尽力杀完）", () => {
    const boom = {
      kill: () => {
        throw new Error("已经死了");
      },
    };
    const good = fakeKillable();
    registerResearchWorker(boom);
    registerResearchWorker(good);

    expect(() => killAllResearchWorkers()).not.toThrow();
    expect(good.killed).toBe(1);
  });
});
