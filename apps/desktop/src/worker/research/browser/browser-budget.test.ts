// Browser 次数 / 并发预算单测（spec §19.4：Browser 并发默认 1、最多 2）。
import { describe, expect, it } from "vitest";
import {
  BrowserBudget,
  clampBrowserConcurrency,
  DEFAULT_BROWSER_CONCURRENCY,
  MAX_BROWSER_CONCURRENCY,
} from "./browser-budget";

/// 手动可控的 deferred：把任务卡住以观察并发窗口。
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("clampBrowserConcurrency", () => {
  it.each([
    [undefined, DEFAULT_BROWSER_CONCURRENCY],
    [0, 1],
    [-5, 1],
    [1, 1],
    [2, 2],
    [7, MAX_BROWSER_CONCURRENCY],
    [Number.NaN, DEFAULT_BROWSER_CONCURRENCY],
    [1.9, 1],
  ])("clamp(%s) = %s", (input, expected) => {
    expect(clampBrowserConcurrency(input)).toBe(expected);
  });

  it("默认 1、上限 2", () => {
    expect(DEFAULT_BROWSER_CONCURRENCY).toBe(1);
    expect(MAX_BROWSER_CONCURRENCY).toBe(2);
  });
});

describe("BrowserBudget 次数上限", () => {
  it("超出 maxFetches 的调用返回 exhausted 且不执行任务", async () => {
    const budget = new BrowserBudget({ maxFetches: 2 });
    let invoked = 0;
    const task = async (): Promise<string> => {
      invoked += 1;
      return "done";
    };

    expect(await budget.run(task)).toEqual({ ok: true, value: "done" });
    expect(await budget.run(task)).toEqual({ ok: true, value: "done" });
    expect(await budget.run(task)).toEqual({ ok: false, reason: "exhausted" });
    expect(invoked).toBe(2);
    expect(budget.used).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  it("maxFetches 为 0 时一次都不放行", async () => {
    const budget = new BrowserBudget({ maxFetches: 0 });
    let invoked = 0;
    const result = await budget.run(async () => {
      invoked += 1;
    });
    expect(result).toEqual({ ok: false, reason: "exhausted" });
    expect(invoked).toBe(0);
  });

  it("任务抛错也计入已用次数（进程已经起过）", async () => {
    const budget = new BrowserBudget({ maxFetches: 1 });
    await expect(
      budget.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(budget.used).toBe(1);
    expect(await budget.run(async () => "x")).toEqual({ ok: false, reason: "exhausted" });
  });

  it("并发发起时次数上限也不会被突破", async () => {
    const budget = new BrowserBudget({ maxFetches: 1, concurrency: 2 });
    const gate = deferred();
    let invoked = 0;
    const task = async (): Promise<void> => {
      invoked += 1;
      await gate.promise;
    };

    const runs = [budget.run(task), budget.run(task)];
    gate.resolve();
    const results = await Promise.all(runs);

    expect(invoked).toBe(1);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
  });
});

describe("BrowserBudget 并发上限", () => {
  it("默认串行执行", async () => {
    const budget = new BrowserBudget({ maxFetches: 5 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      budget.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(1);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(peak).toBe(1);
  });

  it("请求超过上限的并发时被夹到 2", async () => {
    const budget = new BrowserBudget({ maxFetches: 10, concurrency: 9 });
    expect(budget.concurrency).toBe(MAX_BROWSER_CONCURRENCY);

    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      budget.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(MAX_BROWSER_CONCURRENCY);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(peak).toBe(MAX_BROWSER_CONCURRENCY);
  });

  it("任务抛错也释放并发名额", async () => {
    const budget = new BrowserBudget({ maxFetches: 5 });
    await expect(
      budget.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await budget.run(async () => "ok")).toEqual({ ok: true, value: "ok" });
  });
});
