// review-manager 单测(U6):纯行级 diff/合成的逐块与全量正确性、模块级 pending 生命周期
// (入队/幂等再写只换新版/清除)、跨「组件卸载」常驻、裁决落盘(写盘 + 推进基线 + 记自写 hash + 解冻)。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWritingBaselines, getBaseline, isSelfEcho } from "./baseline";
import {
  __resetWritingReviews,
  computeLineDiff,
  getPendingReview,
  listPendingReviewPaths,
  resolveWritingReview,
  synthesizeLineDiff,
  useWritingReviewStore,
  type ChunkDecision,
} from "./review-manager";

const P = "/space/doc.md";
const Q = "/space/other.md";

beforeEach(() => {
  __resetWritingReviews();
  __resetWritingBaselines();
});

describe("纯行级 diff 引擎", () => {
  it("全部接受合成=新版、全部拒绝合成=基线", () => {
    const baseline = "line1\nline2\nline3";
    const next = "line1\nCHANGED\nline3\nline4";
    const diff = computeLineDiff(baseline, next);
    const acceptAll: ChunkDecision[] = new Array(diff.chunkCount).fill("accept");
    const rejectAll: ChunkDecision[] = new Array(diff.chunkCount).fill("reject");
    expect(synthesizeLineDiff(diff, acceptAll)).toBe(next);
    expect(synthesizeLineDiff(diff, rejectAll)).toBe(baseline);
  });

  it("逐块接受/拒绝各自产出正确合成文本(多块混合)", () => {
    // 两处独立改动:第一处改 A→A2,第二处删 C 加 D。
    const baseline = "A\nkeep\nC";
    const next = "A2\nkeep\nD";
    const diff = computeLineDiff(baseline, next);
    expect(diff.chunkCount).toBe(2);
    // 接受块0、拒绝块1 → A2 保留 + C 保留。
    expect(synthesizeLineDiff(diff, ["accept", "reject"])).toBe("A2\nkeep\nC");
    // 拒绝块0、接受块1 → A 保留 + D 采用。
    expect(synthesizeLineDiff(diff, ["reject", "accept"])).toBe("A\nkeep\nD");
  });

  it("纯新增/纯删除也能正确合成", () => {
    const diff = computeLineDiff("x\ny", "x\ny\nz");
    expect(diff.chunkCount).toBe(1);
    expect(synthesizeLineDiff(diff, ["accept"])).toBe("x\ny\nz");
    expect(synthesizeLineDiff(diff, ["reject"])).toBe("x\ny");
  });

  it("基线与新版一致时无差异块", () => {
    const diff = computeLineDiff("same\ntext", "same\ntext");
    expect(diff.chunkCount).toBe(0);
    expect(synthesizeLineDiff(diff, [])).toBe("same\ntext");
  });
});

describe("模块级审阅表 pending 生命周期", () => {
  it("beginReview 入队;next===baseline 不入队并返回 false", () => {
    const store = useWritingReviewStore.getState();
    expect(store.beginReview({ path: P, baseline: "old", next: "new", origin: "agent" })).toBe(true);
    expect(getPendingReview(P)).toMatchObject({ baseline: "old", next: "new", origin: "agent" });
    expect(store.beginReview({ path: Q, baseline: "same", next: "same", origin: "agent" })).toBe(false);
    expect(getPendingReview(Q)).toBeUndefined();
  });

  it("审阅中再次收到同文件新内容:只刷新新版、基线不变", () => {
    const store = useWritingReviewStore.getState();
    store.beginReview({ path: P, baseline: "base-v0", next: "agent-v1", origin: "agent" });
    // agent 再写:即便传入不同 baseline,也保留首次基线,只换新版。
    store.beginReview({ path: P, baseline: "agent-v1", next: "agent-v2", origin: "agent" });
    expect(getPendingReview(P)).toMatchObject({ baseline: "base-v0", next: "agent-v2" });
    // refreshNext 同样只动新版。
    store.refreshNext(P, "agent-v3");
    expect(getPendingReview(P)).toMatchObject({ baseline: "base-v0", next: "agent-v3" });
    // 新版回到基线 → 审阅收口。
    store.refreshNext(P, "base-v0");
    expect(getPendingReview(P)).toBeUndefined();
  });

  it("pending 跨「组件卸载」常驻(模块级 store),切文件保留、可枚举供徽标", () => {
    const store = useWritingReviewStore.getState();
    store.beginReview({ path: P, baseline: "b", next: "n", origin: "agent" });
    store.beginReview({ path: Q, baseline: "b2", next: "n2", origin: "conflict" });
    // 模拟切文件/关覆盖层:仅组件卸载,store 不受影响。
    expect(listPendingReviewPaths().sort()).toEqual([Q, P].sort());
    // 切回 P 仍能恢复审阅记录。
    expect(getPendingReview(P)).toMatchObject({ next: "n" });
  });

  it("clearReview 只清目标文件,clearAll 全清", () => {
    const store = useWritingReviewStore.getState();
    store.beginReview({ path: P, baseline: "b", next: "n", origin: "agent" });
    store.beginReview({ path: Q, baseline: "b2", next: "n2", origin: "agent" });
    store.clearReview(P);
    expect(getPendingReview(P)).toBeUndefined();
    expect(getPendingReview(Q)).toBeDefined();
    store.clearAll();
    expect(listPendingReviewPaths()).toEqual([]);
  });
});

describe("裁决落盘 resolveWritingReview", () => {
  it("写盘 → 推进磁盘基线 → 记自写 hash → 清 pending", async () => {
    const store = useWritingReviewStore.getState();
    store.beginReview({ path: P, baseline: "old", next: "new", origin: "agent" });
    const persist = vi.fn(async () => {});
    await resolveWritingReview(P, "accepted-final", persist);
    expect(persist).toHaveBeenCalledWith(P, "accepted-final");
    // 基线推进到裁决结果,后续 watch 回声被抑制。
    expect(getBaseline(P)?.content).toBe("accepted-final");
    expect(isSelfEcho(P, "accepted-final")).toBe(true);
    // 审阅解冻(pending 清除)。
    expect(getPendingReview(P)).toBeUndefined();
  });

  it("落盘失败保留 pending 供重试并抛出", async () => {
    const store = useWritingReviewStore.getState();
    store.beginReview({ path: P, baseline: "old", next: "new", origin: "agent" });
    const persist = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(resolveWritingReview(P, "new", persist)).rejects.toThrow("disk full");
    // 未清 pending:审阅仍在,基线未推进。
    expect(getPendingReview(P)).toBeDefined();
    expect(getBaseline(P)).toBeUndefined();
  });
});
