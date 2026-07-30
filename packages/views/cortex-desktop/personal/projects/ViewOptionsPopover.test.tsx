import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { ViewOptionsPopover, type ViewOptions } from "./ViewOptionsPopover";

afterEach(() => cleanup());

const BASE: ViewOptions = { filter: "remaining", showInbox: true, showFolders: false };

function renderPopover(value: Partial<ViewOptions> = {}) {
  const onChange = vi.fn();
  const utils = render(<ViewOptionsPopover value={{ ...BASE, ...value }} onChange={onChange} />);
  // 默认收起，先展开弹层。
  fireEvent.click(screen.getByTitle("显示"));
  return { onChange, ...utils };
}

describe("ViewOptionsPopover（U5）", () => {
  it("四档单选：渲染四项，当前档打勾", () => {
    renderPopover({ filter: "available" });
    for (const label of ["首先可用", "可用", "剩余", "全部"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    const on = document.querySelector(".pw-view-option.is-on")!;
    expect(on.textContent).toContain("可用");
  });

  it("点击某档：以新 filter 回调（单选语义，仅改 filter）", () => {
    const { onChange } = renderPopover({ filter: "remaining" });
    fireEvent.click(screen.getByText("全部"));
    expect(onChange).toHaveBeenCalledWith({ filter: "all", showInbox: true, showFolders: false });
  });

  it("显示收件箱开关：翻转回调", () => {
    const { onChange } = renderPopover({ showInbox: true, showFolders: false });
    fireEvent.click(screen.getByText("显示收件箱"));
    expect(onChange).toHaveBeenCalledWith({ filter: "remaining", showInbox: false, showFolders: false });
  });

  it("在大纲中显示文件夹：未实装占位（disabled + 即将推出 tooltip，点击不回调）", () => {
    const { onChange } = renderPopover({ showFolders: false });
    const btn = screen.getByTitle("在大纲中显示文件夹（即将推出）") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("outside mousedown 关闭弹层", () => {
    renderPopover();
    expect(document.querySelector(".pw-view-options")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(document.querySelector(".pw-view-options")).toBeNull();
  });
});
