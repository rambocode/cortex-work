// WritingRichEditor 冒烟测试:保真门控 + 回落。tiptap 走动态 import,jsdom 下只做接线级断言
// (host 挂载 / 回落渲染),真实 ProseMirror 视觉行为由人工验证。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WritingRichEditor } from "./WritingRichEditor";
import { WRITE_RICH_MAX_CHARS } from "./markdown-manager";

afterEach(cleanup);

describe("WritingRichEditor", () => {
  it("审计通过:渲染富文本 host,不显示回落", async () => {
    const { container } = render(
      <WritingRichEditor
        value={"# 标题\n\n正文\n"}
        filePath="/space/a.md"
        onChange={vi.fn()}
        fallback={<div data-testid="fallback">CM</div>}
      />,
    );
    // host 立即在;回落黄条不应出现。
    expect(container.querySelector(".pw-writing-rich-host")).not.toBeNull();
    // 等审计(动态 import)落定后仍是 host、无回落。
    await waitFor(() => {
      expect(container.querySelector(".pw-writing-rich-fallback-note")).toBeNull();
    });
    expect(screen.queryByTestId("fallback")).toBeNull();
  });

  it("审计不通过(超大文档)→ 回落到 fallback + 顶部提示", async () => {
    const big = "a".repeat(WRITE_RICH_MAX_CHARS + 1);
    render(
      <WritingRichEditor
        value={big}
        filePath="/space/big.md"
        onChange={vi.fn()}
        fallback={<div data-testid="fallback">CM</div>}
      />,
    );
    // 审计异步落定 → 渲染回落编辑器 + 黄条提示。
    expect(await screen.findByTestId("fallback")).toBeTruthy();
    expect(screen.getByText(/无法无损表示/)).toBeTruthy();
  });

  it("审计不通过 → onFidelityChange 上报 too-large", async () => {
    const onFidelityChange = vi.fn();
    render(
      <WritingRichEditor
        value={"a".repeat(WRITE_RICH_MAX_CHARS + 1)}
        filePath="/space/big.md"
        onChange={vi.fn()}
        onFidelityChange={onFidelityChange}
        fallback={<div>CM</div>}
      />,
    );
    await waitFor(() =>
      expect(onFidelityChange).toHaveBeenCalledWith(
        expect.objectContaining({ eligible: false, reason: "too-large" }),
      ),
    );
  });
});
