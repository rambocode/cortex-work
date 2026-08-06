// session-pool.ts 单测：in-process 并发会话的「租约 + 释放」语义。
//
// 这一层守的是迁移计划里最高的那条风险（进程隔离消失）——旧路径漏释放只是留个会自己退出的
// 子进程，in-process 漏释放就是一个永久驻留主进程的 agent loop。故三类用例都必须真断言：
//   · 构造期竞态：adopt 时已作废 → 就地释放且不登记（否则会话无主）
//   · 释放顺序：in-process abort→stop；binary 只 stop（开关关闭时行为不变）
//   · 故障隔离：任一步抛错都不阻断后续步骤 / 其余会话

import { describe, it, expect, vi } from "vitest";

import { createPiSessionPool, type PiReleasableSession } from "./session-pool";

/** 会话替身：把 abort/stop 的调用顺序记录进共享数组，便于断言先后。 */
function makeSession(name: string, trace: string[], opts: { stopThrows?: boolean; abortRejects?: boolean } = {}) {
  const session = {
    name,
    abort: vi.fn(async () => {
      trace.push(`${name}:abort`);
      if (opts.abortRejects) throw new Error(`${name} abort failed`);
      return { success: true };
    }),
    stop: vi.fn(() => {
      trace.push(`${name}:stop`);
      if (opts.stopThrows) throw new Error(`${name} stop failed`);
    }),
  };
  return session as typeof session & PiReleasableSession;
}

describe("adopt：构造期竞态", () => {
  it("未作废时登记成功，不立即释放", () => {
    const trace: string[] = [];
    const pool = createPiSessionPool();
    const s = makeSession("s1", trace);

    expect(pool.adopt(s, { isStale: () => false })).toBe(true);
    expect(pool.has(s)).toBe(true);
    expect(pool.size()).toBe(1);
    expect(trace).toEqual([]);
  });

  it("adopt 瞬间已作废 → 返回 false、就地释放、且不入表（无主会话是最致命的泄漏形态）", () => {
    const trace: string[] = [];
    const before = vi.fn();
    const pool = createPiSessionPool({ onBeforeRelease: before });
    const s = makeSession("stale", trace);

    expect(pool.adopt(s, { abortOnRelease: true, isStale: () => true })).toBe(false);
    expect(pool.has(s)).toBe(false);
    expect(pool.size()).toBe(0);
    // 已就地释放：clear 回调 + abort + stop 都跑过
    expect(before).toHaveBeenCalledWith(s);
    expect(trace).toEqual(["stale:abort", "stale:stop"]);
  });

  it("不传 isStale 时默认登记（调用方无竞态需求时不必写守卫）", () => {
    const pool = createPiSessionPool();
    const s = makeSession("s", []);
    expect(pool.adopt(s)).toBe(true);
    expect(pool.size()).toBe(1);
  });
});

describe("release：释放顺序与开关两侧差异", () => {
  it("in-process 会话按 onBeforeRelease → abort → stop 顺序释放", () => {
    const trace: string[] = [];
    const pool = createPiSessionPool({ onBeforeRelease: (s) => trace.push(`${(s as unknown as { name: string }).name}:before`) });
    const s = makeSession("inproc", trace);
    pool.adopt(s, { abortOnRelease: true });

    pool.release(s);
    expect(trace).toEqual(["inproc:before", "inproc:abort", "inproc:stop"]);
    expect(pool.size()).toBe(0);
  });

  it("二进制会话只 stop，绝不额外发 abort（开关关闭时行为逐字不变）", () => {
    const trace: string[] = [];
    const pool = createPiSessionPool({ onBeforeRelease: (s) => trace.push(`${(s as unknown as { name: string }).name}:before`) });
    const s = makeSession("binary", trace);
    pool.adopt(s, { abortOnRelease: false });

    pool.release(s);
    expect(trace).toEqual(["binary:before", "binary:stop"]);
    expect(s.abort).not.toHaveBeenCalled();
  });

  it("release 幂等：重复调用只释放一次（settle 去重 + releaseAll 会重复触达同一会话）", () => {
    const trace: string[] = [];
    const pool = createPiSessionPool();
    const s = makeSession("s", trace);
    pool.adopt(s, { abortOnRelease: true });

    pool.release(s);
    pool.release(s);
    pool.release(s);
    expect(s.stop).toHaveBeenCalledTimes(1);
    expect(s.abort).toHaveBeenCalledTimes(1);
  });

  it("释放从未登记的会话是 no-op，不抛", () => {
    const pool = createPiSessionPool();
    const s = makeSession("ghost", []);
    expect(() => pool.release(s)).not.toThrow();
    expect(s.stop).not.toHaveBeenCalled();
  });
});

describe("故障隔离", () => {
  it("onBeforeRelease 抛错不阻断 abort/stop —— 清理失败远没有漏释放严重", () => {
    const trace: string[] = [];
    const onError = vi.fn();
    const pool = createPiSessionPool({
      onBeforeRelease: () => {
        throw new Error("clear failed");
      },
      onError,
    });
    const s = makeSession("s", trace);
    pool.adopt(s, { abortOnRelease: true });

    pool.release(s);
    expect(trace).toEqual(["s:abort", "s:stop"]);
    expect(onError).toHaveBeenCalledWith("before-release", expect.any(Error));
  });

  it("abort 同步抛错不阻断 stop", () => {
    const trace: string[] = [];
    const onError = vi.fn();
    const pool = createPiSessionPool({ onError });
    const s = {
      abort: () => {
        trace.push("abort");
        throw new Error("abort exploded");
      },
      stop: () => trace.push("stop"),
    } as unknown as PiReleasableSession;
    pool.adopt(s, { abortOnRelease: true });

    pool.release(s);
    expect(trace).toEqual(["abort", "stop"]);
    expect(onError).toHaveBeenCalledWith("abort", expect.any(Error));
  });

  it("abort 返回的 Promise reject 不产生 unhandledRejection，且不影响 stop", async () => {
    const trace: string[] = [];
    const onError = vi.fn();
    const pool = createPiSessionPool({ onError });
    const s = makeSession("s", trace, { abortRejects: true });
    pool.adopt(s, { abortOnRelease: true });

    pool.release(s);
    expect(trace).toEqual(["s:abort", "s:stop"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("abort", expect.any(Error));
  });

  it("onError 自身抛错也不冒泡（本模块跑在 app 退出等不可失败路径上）", () => {
    const pool = createPiSessionPool({
      onBeforeRelease: () => {
        throw new Error("boom");
      },
      onError: () => {
        throw new Error("logger exploded");
      },
    });
    const s = makeSession("s", []);
    pool.adopt(s);
    expect(() => pool.release(s)).not.toThrow();
    expect(s.stop).toHaveBeenCalledTimes(1);
  });
});

describe("releaseAll：批量释放", () => {
  it("释放全部并清空，单个 stop 抛错不影响其余会话（核心并发隔离断言）", () => {
    const trace: string[] = [];
    const onError = vi.fn();
    const pool = createPiSessionPool({ onError });
    const a = makeSession("a", trace);
    const bad = makeSession("bad", trace, { stopThrows: true });
    const c = makeSession("c", trace);
    pool.adopt(a, { abortOnRelease: true });
    pool.adopt(bad, { abortOnRelease: true });
    pool.adopt(c, { abortOnRelease: true });

    pool.releaseAll();

    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(bad.stop).toHaveBeenCalledTimes(1);
    expect(c.stop).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(0);
    expect(onError).toHaveBeenCalledWith("stop", expect.any(Error));
  });

  it("释放回调里反过来调 release() 不会漏项（先清空再逐个释放）", () => {
    const trace: string[] = [];
    const a = makeSession("a", trace);
    const b = makeSession("b", trace);
    const pool: ReturnType<typeof createPiSessionPool<PiReleasableSession>> = createPiSessionPool<PiReleasableSession>({
      // 模拟「某个会话释放时连带触发另一个会话的 settle → release」的真实交叉路径
      onBeforeRelease: (s) => {
        if (s === a) pool.release(b);
      },
    });
    pool.adopt(a);
    pool.adopt(b);

    pool.releaseAll();

    expect(a.stop).toHaveBeenCalledTimes(1);
    // b 在 a 的回调里已被 release（此时已不在表内 → no-op），随后 releaseAll 的快照仍会释放它一次
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(0);
  });

  it("空表 releaseAll 是 no-op", () => {
    const pool = createPiSessionPool();
    expect(() => pool.releaseAll()).not.toThrow();
    expect(pool.size()).toBe(0);
  });
});
