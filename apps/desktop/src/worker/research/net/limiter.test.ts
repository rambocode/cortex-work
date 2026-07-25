// limiter 单测：全局并发 6 / 每域并发 2 的信号量。
import { describe, expect, it } from "vitest";
import { FetchLimiter } from "./limiter";

/// 手动可控的 deferred：用来把任务卡在半途，观察并发窗口。
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("FetchLimiter", () => {
  it("同一域名最多同时跑 perHost 个任务", async () => {
    const limiter = new FetchLimiter({ global: 10, perHost: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      limiter.run("example.com", async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("全局上限跨域名生效", async () => {
    const limiter = new FetchLimiter({ global: 2, perHost: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate, index) =>
      limiter.run(`h${index}.example.com`, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
  });

  it("任务抛错也会释放名额，不会把信号量泄漏死", async () => {
    const limiter = new FetchLimiter({ global: 1, perHost: 1 });
    await expect(
      limiter.run("example.com", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(limiter.run("example.com", async () => "ok")).resolves.toBe("ok");
  });

  it("默认上限是全局 6 / 每域 2（spec §12.3）", () => {
    const limiter = new FetchLimiter();
    expect(limiter.limits).toEqual({ global: 6, perHost: 2 });
  });
});
