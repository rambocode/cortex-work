// WritingDiffReview 单测(U6):@codemirror/merge 动态装载失败时降级为「全部接受/全部拒绝」两按钮,
// 且整体裁决产出正确(全部接受=新版、全部拒绝=基线)。逐块混合合成的正确性由 review-manager 的
// 纯行级引擎测试覆盖(CM 在 jsdom 下不可靠,不在此断言)。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WritingDiffReview } from "./WritingDiffReview";

// 强制 @codemirror/merge 装载失败:Promise.all 拒绝 → 组件进入 failed 降级态。
vi.mock("@codemirror/merge", () => {
  throw new Error("merge load failed (test)");
});

describe("WritingDiffReview 降级两按钮", () => {
  afterEach(cleanup);

  it("merge 装载失败:渲染降级提示,全部接受产出新版", async () => {
    const onResolve = vi.fn();
    render(
      <WritingDiffReview path="/space/a.md" baseline="旧版内容" next="新版内容" onResolve={onResolve} />,
    );
    // 降级提示出现(装载失败)。
    await waitFor(() => expect(screen.getByText(/无法加载逐块审阅视图/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "全部接受" }));
    expect(onResolve).toHaveBeenCalledWith("新版内容");
  });

  it("全部拒绝产出基线", async () => {
    const onResolve = vi.fn();
    render(
      <WritingDiffReview path="/space/a.md" baseline="旧版内容" next="新版内容" onResolve={onResolve} />,
    );
    await waitFor(() => expect(screen.getByText(/无法加载逐块审阅视图/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "全部拒绝" }));
    expect(onResolve).toHaveBeenCalledWith("旧版内容");
  });
});
