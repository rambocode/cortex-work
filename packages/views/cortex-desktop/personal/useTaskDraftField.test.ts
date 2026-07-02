// U1 草稿守卫 hook 单测：覆盖状态机每条边（外部跟随 / 聚焦保护 / 换任务重置 / 不回弹 / flush 注册表）。
import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { useTaskDraftField, flushPendingDrafts, pendingDraftCount } from "./useTaskDraftField";

afterEach(cleanup);

describe("useTaskDraftField", () => {
  it("挂载初值 = 外部值", () => {
    const { result } = renderHook(() =>
      useTaskDraftField({ taskId: "t1", external: "A", onCommit: () => {} }),
    );
    expect(result.current.value).toBe("A");
  });

  it("未聚焦时外部值变化 → 草稿跟随（跨列/跨窗口热更）", () => {
    const { result, rerender } = renderHook(
      ({ ext }) => useTaskDraftField({ taskId: "t1", external: ext, onCommit: () => {} }),
      { initialProps: { ext: "A" } },
    );
    rerender({ ext: "B" });
    expect(result.current.value).toBe("B");
  });

  it("聚焦输入中 → 外部更新一律忽略（不冲掉正在输入的草稿）", () => {
    const { result, rerender } = renderHook(
      ({ ext }) => useTaskDraftField({ taskId: "t1", external: ext, onCommit: () => {} }),
      { initialProps: { ext: "A" } },
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("用户输入中"));
    // 外部（如 tasks:changed 委派回写）到达，但聚焦中 → 草稿不变。
    rerender({ ext: "外部新值" });
    expect(result.current.value).toBe("用户输入中");
  });

  it("blur 提交草稿：归一化后 ≠ 外部值才 onCommit", () => {
    const commits: string[] = [];
    const { result } = renderHook(() =>
      useTaskDraftField({ taskId: "t1", external: "A", onCommit: (v) => commits.push(v), normalize: (v) => v.trim() }),
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("  B  "));
    act(() => result.current.onBlur());
    expect(commits).toEqual(["B"]); // trim 归一
  });

  it("blur 后草稿 == 外部值时不 onCommit（无空写）", () => {
    const commits: string[] = [];
    const { result } = renderHook(() =>
      useTaskDraftField({ taskId: "t1", external: "A", onCommit: (v) => commits.push(v) }),
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("A"));
    act(() => result.current.onBlur());
    expect(commits).toEqual([]);
  });

  it("blur 保存后、外部确认前（非乐观窗口期）草稿不回弹旧值", () => {
    // 模拟非乐观 mutation：onCommit 不立即改 external。聚焦编辑「X」，其间 external 变到中间值「mid」
    // （如别列热更/委派回写）——聚焦保护应挡住，草稿不被覆盖为「mid」。blur 提交「X」后 external 仍是
    // 中间值「mid」，一次无关 re-render 不得把草稿回弹到 external；直到缓存回灌到已提交值「X」仍稳定。
    const commits: string[] = [];
    const { result, rerender } = renderHook(
      ({ ext }) => useTaskDraftField({ taskId: "t1", external: ext, onCommit: (v) => commits.push(v) }),
      { initialProps: { ext: "A" } },
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("X"));
    // external 变到中间值，但聚焦中 → 草稿不被覆盖（非空转断言：external 确实变了）。
    rerender({ ext: "mid" });
    expect(result.current.value).toBe("X");
    act(() => result.current.onBlur());
    expect(commits).toEqual(["X"]); // 基线正确推到「X」：blur 恰好提交一次
    rerender({ ext: "mid" }); // external 尚未回灌（仍中间值），不得把草稿回弹
    expect(result.current.value).toBe("X");
    // 稍后缓存回灌到已提交值 → 仍是「X」，无跳变，也不再重复提交。
    rerender({ ext: "X" });
    expect(result.current.value).toBe("X");
    expect(commits).toEqual(["X"]);
  });

  it("Enter 保存（commit 后同步 blur → 再 commit）只触发一次 onCommit（防双提交 P2）", () => {
    // Enter 处理：先 commit() 立即落库，再 blur() 退出编辑，onBlur 内又 commit() 一次——两次同值。
    // 双守卫应把第二次（next === baseline）挡掉，避免同一 mutation 触发两次。
    const commits: string[] = [];
    const { result } = renderHook(() =>
      useTaskDraftField({ taskId: "t1", external: "A", onCommit: (v) => commits.push(v) }),
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("新标题"));
    act(() => {
      result.current.commit();
      result.current.onBlur();
    });
    expect(commits).toEqual(["新标题"]); // 恰好一次
  });

  it("外部值跟随后再编辑回同一旧值仍可提交（baseline 守卫不误伤合法重复提交）", () => {
    // external 从「A」变到「B」（未聚焦跟随，baseline 同步为「B」），随后用户聚焦把草稿改回旧值「A」。
    // 此时 next=「A」≠ external「B」且 ≠ baseline「B」→ 应正常落库，不被 baseline 守卫误挡。
    const commits: string[] = [];
    const { result, rerender } = renderHook(
      ({ ext }) => useTaskDraftField({ taskId: "t1", external: ext, onCommit: (v) => commits.push(v) }),
      { initialProps: { ext: "A" } },
    );
    rerender({ ext: "B" }); // 未聚焦跟随：baseline → 「B」
    expect(result.current.value).toBe("B");
    act(() => result.current.onFocus());
    act(() => result.current.setValue("A")); // 编辑回旧值
    act(() => result.current.onBlur());
    expect(commits).toEqual(["A"]);
  });

  it("taskId 变化 → 无条件重置为新任务外部值（即便聚焦中，也不保留旧草稿）", () => {
    const { result, rerender } = renderHook(
      ({ id, ext }) => useTaskDraftField({ taskId: id, external: ext, onCommit: () => {} }),
      { initialProps: { id: "t1", ext: "A" } },
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("t1 的草稿"));
    rerender({ id: "t2", ext: "B" });
    expect(result.current.value).toBe("B");
  });

  it("commit（Enter/关窗）提交最新草稿值 — 即使仍聚焦", () => {
    const commits: string[] = [];
    const { result } = renderHook(() =>
      useTaskDraftField({ taskId: "t1", external: "A", onCommit: (v) => commits.push(v) }),
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("聚焦草稿"));
    act(() => result.current.commit());
    expect(commits).toEqual(["聚焦草稿"]);
  });

  it("flush 注册表：挂载即注册、卸载即注销；flushPendingDrafts 提交 pending 草稿", () => {
    const commits: string[] = [];
    const before = pendingDraftCount();
    const { result, unmount } = renderHook(() =>
      useTaskDraftField({ taskId: "t1", external: "A", onCommit: (v) => commits.push(v) }),
    );
    expect(pendingDraftCount()).toBe(before + 1);
    // 聚焦编辑但未 blur（模拟关窗时正在输入）。
    act(() => result.current.onFocus());
    act(() => result.current.setValue("未 blur 的草稿"));
    act(() => flushPendingDrafts());
    expect(commits).toEqual(["未 blur 的草稿"]);
    unmount();
    expect(pendingDraftCount()).toBe(before);
  });

  it("flushPendingDrafts：单实例抛错不阻断其它实例", () => {
    const ok: string[] = [];
    const h1 = renderHook(() =>
      useTaskDraftField({
        taskId: "a",
        external: "",
        onCommit: () => {
          throw new Error("boom");
        },
      }),
    );
    const h2 = renderHook(() =>
      useTaskDraftField({ taskId: "b", external: "", onCommit: (v) => ok.push(v) }),
    );
    act(() => h1.result.current.setValue("会抛错"));
    act(() => h2.result.current.setValue("应落库"));
    expect(() => act(() => flushPendingDrafts())).not.toThrow();
    expect(ok).toContain("应落库");
    h1.unmount();
    h2.unmount();
  });
});
