import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContextMenu, type FileCtxTarget } from "./FileContextMenu";

const TARGET: FileCtxTarget = { x: 100, y: 100, path: "/Users/me/proj/a.ts", name: "a.ts" };

function renderMenu(overrides: Partial<Parameters<typeof FileContextMenu>[0]> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onInsertChat: vi.fn(),
    onInsertTerminal: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };
  render(<FileContextMenu target={TARGET} canOpen {...handlers} {...overrides} />);
  return handlers;
}

describe("FileContextMenu 文件右键菜单", () => {
  afterEach(() => cleanup());

  it("渲染四个菜单项：打开 / 插入到聊天框 / 插入到终端 / 删除", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: "打开" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "插入到聊天框" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "插入到终端" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument();
  });

  it("无 openPath 能力（canOpen=false）时不显示「打开」", () => {
    renderMenu({ canOpen: false });
    expect(screen.queryByRole("menuitem", { name: "打开" })).toBeNull();
  });

  it("点击「打开」触发 onOpen 并关闭菜单", () => {
    const h = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "打开" }));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("点击「插入到聊天框」/「插入到终端」各自触发并关闭", () => {
    const h = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "插入到聊天框" }));
    expect(h.onInsertChat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "插入到终端" }));
    expect(h.onInsertTerminal).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  it("删除需二次确认：首点只变文案,再点才执行", () => {
    const h = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "确认删除？" }));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape 关闭菜单", () => {
    const h = renderMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("点击菜单外部关闭", () => {
    const h = renderMenu();
    fireEvent.mouseDown(document.body);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("菜单内 mousedown 不触发关闭", () => {
    const h = renderMenu();
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "删除" }));
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("位置贴近触发点且不超出视口", () => {
    renderMenu();
    const menu = screen.getByRole("menu");
    const left = parseFloat((menu as HTMLElement).style.left);
    const top = parseFloat((menu as HTMLElement).style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(top).toBeLessThanOrEqual(window.innerHeight - 8);
  });
});
