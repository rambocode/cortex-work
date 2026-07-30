// 排版设置卡单测:字体预设切换(custom 展开输入)、字号/行距滑杆写 store、重置。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoreProvider } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";

import { WritingTypographySection } from "./WritingTypographySection";

function renderUI() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
      <WritingTypographySection />
    </CoreProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  useWritingSpacesStore.setState({
    fontPreset: "system",
    customFontFamily: "",
    fontSizePx: 16,
    lineHeight: 1.75,
  });
});

describe("WritingTypographySection", () => {
  it("切字体预设写 store;选 custom 展开自定义输入", () => {
    renderUI();
    const select = screen.getByLabelText("编辑器字体") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "kaiti" } });
    expect(useWritingSpacesStore.getState().fontPreset).toBe("kaiti");
    // 无 custom 输入
    expect(screen.queryByLabelText("自定义…")).toBeNull();
    // 切 custom → 输入出现
    fireEvent.change(select, { target: { value: "custom" } });
    const input = screen.getByLabelText("自定义…");
    fireEvent.change(input, { target: { value: "'LXGW WenKai', serif" } });
    expect(useWritingSpacesStore.getState().customFontFamily).toBe("'LXGW WenKai', serif");
  });

  it("字号滑杆写 store(与工具栏同源 fontSizePx)", () => {
    renderUI();
    const slider = screen.getByLabelText("字号") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "22" } });
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(22);
  });

  it("行距滑杆写 store(夹取+snap)", () => {
    renderUI();
    const slider = screen.getByLabelText("行距") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "2.0" } });
    expect(useWritingSpacesStore.getState().lineHeight).toBe(2.0);
  });

  it("重置排版 → 回默认", () => {
    useWritingSpacesStore.setState({ fontPreset: "kaiti", fontSizePx: 30, lineHeight: 2.1 });
    renderUI();
    fireEvent.click(screen.getByRole("button", { name: "重置排版" }));
    const s = useWritingSpacesStore.getState();
    expect(s.fontPreset).toBe("system");
    expect(s.fontSizePx).toBe(16);
    expect(s.lineHeight).toBe(1.75);
  });
});
