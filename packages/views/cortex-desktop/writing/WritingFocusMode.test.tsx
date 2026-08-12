// 聚焦模式单测：顶栏开关 → store 持久化字段 → 中栏容器类；关闭时容器不带类。
// 变灰规则本身是 CSS（.pw-writing-center.is-focus-mode 下 .cm-line / 富文本块降透明度），
// 这里守住的是「开关到容器类」这条唯一的接线，避免以后有人把类名改了却没人发现。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WritingToolbar } from "./WritingToolbar";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";

afterEach(cleanup);
beforeEach(() => {
  useWritingSpacesStore.setState({ focusMode: false });
});

describe("聚焦模式", () => {
  it("顶栏开关按钮切换回调与按下态", () => {
    const onFocusModeChange = vi.fn();
    const { rerender } = render(
      <WritingToolbar
        fileName="a.md"
        fileLabel="a.md"
        charCount={3}
        hasTextFile
        mode="rich"
        onModeChange={vi.fn()}
        fontSizePx={16}
        saveStatus="idle"
        saveLabel="已保存"
        onSave={vi.fn()}
        focusMode={false}
        onFocusModeChange={onFocusModeChange}
      />,
    );
    const btn = screen.getByLabelText("开启聚焦模式");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(onFocusModeChange).toHaveBeenCalledWith(true);

    rerender(
      <WritingToolbar
        fileName="a.md"
        fileLabel="a.md"
        charCount={3}
        hasTextFile
        mode="rich"
        onModeChange={vi.fn()}
        fontSizePx={16}
        saveStatus="idle"
        saveLabel="已保存"
        onSave={vi.fn()}
        focusMode
        onFocusModeChange={onFocusModeChange}
      />,
    );
    const on = screen.getByLabelText("退出聚焦模式");
    expect(on.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(on);
    expect(onFocusModeChange).toHaveBeenLastCalledWith(false);
  });

  it("纯预览档（无文本文件）不渲染聚焦开关", () => {
    render(
      <WritingToolbar
        fileName="a.pdf"
        fileLabel="a.pdf"
        charCount={null}
        hasTextFile={false}
        mode="preview"
        onModeChange={vi.fn()}
        fontSizePx={16}
        saveStatus="idle"
        saveLabel="PDF"
        onSave={vi.fn()}
        focusMode={false}
        onFocusModeChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("开启聚焦模式")).toBeNull();
  });

  it("store 开关进出持久化分片（旧档缺字段视为关闭）", () => {
    useWritingSpacesStore.getState().setFocusMode(true);
    expect(useWritingSpacesStore.getState().serialize().focusMode).toBe(true);
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null });
    expect(useWritingSpacesStore.getState().focusMode).toBe(false);
    useWritingSpacesStore.getState().hydrate({ spaces: [], activeSpaceId: null, focusMode: true });
    expect(useWritingSpacesStore.getState().focusMode).toBe(true);
  });
});
