// 中栏顶部工具栏单测：保存状态并入图标且「已保存」不常驻、字号下拉、导出仅图标。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WritingToolbar, type WritingToolbarProps } from "./WritingToolbar";

function renderToolbar(over: Partial<WritingToolbarProps> = {}): ReturnType<typeof render> {
  return render(
    <WritingToolbar
      fileName="a.md"
      fileLabel="a.md"
      charCount={3}
      hasTextFile
      mode="rich"
      onModeChange={vi.fn()}
      fontSizePx={16}
      onFontSizeChange={vi.fn()}
      saveStatus="idle"
      saveLabel="已保存"
      onSave={vi.fn()}
      {...over}
    />,
  );
}

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

describe("WritingToolbar", () => {
  it("不再渲染常驻的保存状态文字；状态只进 title / aria-label", () => {
    renderToolbar({ saveStatus: "idle", saveLabel: "已保存" });
    // 标题栏里没有「已保存」这块常驻 pill（文字只出现在按钮的可访问名里）。
    expect(document.querySelector(".pw-wt-save")).toBeNull();
    expect(screen.getByRole("button", { name: "保存，当前状态：已保存" })).toBeTruthy();
  });

  it("落盘成功后短暂显示已保存态，随后回落普通图标（不长期占位）", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <WritingToolbar
        fileName="a.md"
        fileLabel="a.md"
        charCount={3}
        hasTextFile
        mode="rich"
        onModeChange={vi.fn()}
        fontSizePx={16}
        saveStatus="dirty"
        saveLabel="未保存"
        onSave={vi.fn()}
      />,
    );
    const btn = () => document.querySelector(".pw-wt-save-btn")!;
    expect(btn().getAttribute("data-status")).toBe("dirty");

    rerender(
      <WritingToolbar
        fileName="a.md"
        fileLabel="a.md"
        charCount={3}
        hasTextFile
        mode="rich"
        onModeChange={vi.fn()}
        fontSizePx={16}
        saveStatus="saved"
        saveLabel="已保存"
        onSave={vi.fn()}
      />,
    );
    expect(btn().getAttribute("data-status")).toBe("saved-hint");
    act(() => void vi.advanceTimersByTime(2000));
    // 提示回落：状态不再是 saved-hint，图标回到普通保存态。
    expect(btn().getAttribute("data-status")).toBe("saved");
    vi.useRealTimers();
  });

  it("字号下拉：触发器显示当前值，选档回调", () => {
    const onFontSizeChange = vi.fn();
    renderToolbar({ fontSizePx: 16, onFontSizeChange });
    const trigger = screen.getByLabelText("编辑器字号");
    expect(trigger.textContent).toContain("16");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "24 px" }));
    expect(onFontSizeChange).toHaveBeenCalledWith(24);
  });

  it("导出按钮只剩图标，文字不再占位", () => {
    renderToolbar({ onCopyMarkdown: vi.fn() });
    const exportBtn = screen.getByRole("button", { name: "导出" });
    expect(exportBtn.textContent).toBe("");
    fireEvent.click(exportBtn);
    expect(screen.getByRole("menuitem", { name: /复制全文/ })).toBeTruthy();
  });
});
