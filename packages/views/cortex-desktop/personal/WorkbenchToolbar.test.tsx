import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { WorkbenchToolbar, type WorkbenchToolbarProps } from "./WorkbenchToolbar";

afterEach(() => cleanup());

function renderToolbar(overrides: Partial<WorkbenchToolbarProps> = {}) {
  const props: WorkbenchToolbarProps = {
    sidebarVisible: true,
    onToggleSidebar: vi.fn(),
    canGoBack: false,
    canGoForward: false,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onNewAction: vi.fn(),
    onNewProject: vi.fn(),
    ...overrides,
  };
  const utils = render(<WorkbenchToolbar {...props} />);
  return { props, ...utils };
}

describe("WorkbenchToolbar（U4）", () => {
  it("端点禁用：canGoBack/canGoForward=false 时后退/前进按钮 disabled", () => {
    renderToolbar({ canGoBack: false, canGoForward: false });
    expect((screen.getByTitle("后退") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle("前进") as HTMLButtonElement).disabled).toBe(true);
  });

  it("端点可用：canGo*=true 时按钮可点并回调", () => {
    const { props } = renderToolbar({ canGoBack: true, canGoForward: true });
    const back = screen.getByTitle("后退") as HTMLButtonElement;
    const fwd = screen.getByTitle("前进") as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(fwd.disabled).toBe(false);
    fireEvent.click(back);
    fireEvent.click(fwd);
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onForward).toHaveBeenCalledTimes(1);
  });

  it("占位项（快速入口/聚焦/设置显示字段/设置编辑字段）渲染为 disabled", () => {
    renderToolbar();
    for (const title of ["快速入口（即将推出）", "聚焦（即将推出）", "设置显示字段（即将推出）", "设置编辑字段（即将推出）"]) {
      expect((screen.getByTitle(title) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("边栏切换按钮反映显隐态并回调", () => {
    const { props, rerender } = renderToolbar({ sidebarVisible: true });
    const btn = screen.getByTitle("隐藏边栏");
    expect(btn.className).toContain("is-on");
    fireEvent.click(btn);
    expect(props.onToggleSidebar).toHaveBeenCalledTimes(1);
    // 隐藏态：title 与高亮态翻转。
    rerender(<WorkbenchToolbar {...props} sidebarVisible={false} />);
    const off = screen.getByTitle("显示边栏");
    expect(off.className).not.toContain("is-on");
  });

  it("新建菜单：动作 / 项目两项分别回调 onNewAction / onNewProject", () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByTitle("新建"));
    fireEvent.click(screen.getByText("新建动作"));
    expect(props.onNewAction).toHaveBeenCalledTimes(1);
    // 菜单选后自动关闭，需重新打开。
    fireEvent.click(screen.getByTitle("新建"));
    fireEvent.click(screen.getByText("新建项目"));
    expect(props.onNewProject).toHaveBeenCalledTimes(1);
  });

  it("拖拽契约：工具栏为 drag 区，交互元素挂 ds-no-drag", () => {
    const { container } = renderToolbar();
    expect(container.querySelector(".pw-wb-toolbar")!.className).toContain("ds-drag");
    // 边栏按钮等交互元素恢复点击（no-drag）。
    expect(screen.getByTitle("隐藏边栏").className).toContain("ds-no-drag");
  });
});
