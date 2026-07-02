// FieldsPopover 单测：展开、勾选切换回调、aria-checked 勾选态、外点 / Esc 关闭。
// 包装范式照 ViewOptionsPopover.test.tsx。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { FieldsPopover } from "./FieldsPopover";

afterEach(() => cleanup());

type K = "a" | "b" | "c";
const OPTIONS: readonly { key: K; label: string }[] = [
  { key: "a", label: "字段甲" },
  { key: "b", label: "字段乙" },
  { key: "c", label: "字段丙" },
];
const BASE: Record<K, boolean> = { a: true, b: false, c: true };

function renderPopover(value: Partial<Record<K, boolean>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <FieldsPopover
      icon={<span data-testid="ico" />}
      title="设置显示字段"
      options={OPTIONS}
      value={{ ...BASE, ...value }}
      onChange={onChange}
    />,
  );
  return { onChange, ...utils };
}

describe("FieldsPopover", () => {
  it("默认收起，点击触发按钮展开菜单", () => {
    renderPopover();
    expect(document.querySelector(".pw-view-options")).toBeNull();
    fireEvent.click(screen.getByTitle("设置显示字段"));
    expect(document.querySelector(".pw-view-options")).not.toBeNull();
    for (const label of ["字段甲", "字段乙", "字段丙"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("勾选态映射到 aria-checked", () => {
    renderPopover();
    fireEvent.click(screen.getByTitle("设置显示字段"));
    // a=true 打勾，b=false 未勾。
    const itemA = screen.getByText("字段甲").closest("button")!;
    const itemB = screen.getByText("字段乙").closest("button")!;
    expect(itemA.getAttribute("aria-checked")).toBe("true");
    expect(itemB.getAttribute("aria-checked")).toBe("false");
    expect(itemA.classList.contains("is-on")).toBe(true);
  });

  it("点击某项：翻转该键并回调完整 next 对象", () => {
    const { onChange } = renderPopover();
    fireEvent.click(screen.getByTitle("设置显示字段"));
    fireEvent.click(screen.getByText("字段乙")); // b: false → true
    expect(onChange).toHaveBeenCalledWith({ a: true, b: true, c: true });
  });

  it("点击后菜单保持打开（连续勾选）", () => {
    renderPopover();
    fireEvent.click(screen.getByTitle("设置显示字段"));
    fireEvent.click(screen.getByText("字段甲"));
    expect(document.querySelector(".pw-view-options")).not.toBeNull();
  });

  it("外点关闭弹层", () => {
    renderPopover();
    fireEvent.click(screen.getByTitle("设置显示字段"));
    expect(document.querySelector(".pw-view-options")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(document.querySelector(".pw-view-options")).toBeNull();
  });

  it("Esc 关闭弹层", () => {
    renderPopover();
    fireEvent.click(screen.getByTitle("设置显示字段"));
    expect(document.querySelector(".pw-view-options")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".pw-view-options")).toBeNull();
  });
});
