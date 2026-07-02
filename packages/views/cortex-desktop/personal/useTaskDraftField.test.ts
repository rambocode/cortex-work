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
    // 模拟非乐观 mutation：onCommit 不立即改 external。blur 提交「X」后 external 仍是旧「A」，
    // 期间发生一次无关 re-render（external 未变）→ 草稿应保持「X」，不被旧 external 回灌。
    const { result, rerender } = renderHook(
      ({ ext }) => useTaskDraftField({ taskId: "t1", external: ext, onCommit: () => {} }),
      { initialProps: { ext: "A" } },
    );
    act(() => result.current.onFocus());
    act(() => result.current.setValue("X"));
    act(() => result.current.onBlur());
    rerender({ ext: "A" }); // external 尚未回灌（仍旧值）
    expect(result.current.value).toBe("X");
    // 稍后缓存回灌到已提交值 → 仍是「X」，无跳变。
    rerender({ ext: "X" });
    expect(result.current.value).toBe("X");
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
