import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { WorkbenchToolbar, type WorkbenchToolbarProps } from "./WorkbenchToolbar";
import { DEFAULT_DISPLAY_FIELDS, DEFAULT_EDIT_FIELDS } from "./workbenchFieldPrefs";

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
    onQuickOpen: vi.fn(),
    focusActive: false,
    canFocus: false,
    onToggleFocus: vi.fn(),
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

  it("快速入口：点击回调 onQuickOpen（⌘O 由容器 window 级监听，不在本组件断言）", () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByTitle("快速入口（⌘O）"));
    expect(props.onQuickOpen).toHaveBeenCalledTimes(1);
  });

  it("聚焦：canFocus=false 时 disabled；可聚焦时点击回调；聚焦态高亮且 title 变「取消聚焦」", () => {
    // 未选中 project/folder：按钮禁用。
    renderToolbar({ canFocus: false });
    expect((screen.getByTitle("聚焦") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    // 可聚焦：点击回调 onToggleFocus。
    const { props } = renderToolbar({ canFocus: true });
    const btn = screen.getByTitle("聚焦") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(props.onToggleFocus).toHaveBeenCalledTimes(1);
    cleanup();
    // 聚焦态：title 翻转 + is-on 高亮 + aria-pressed。
    renderToolbar({ canFocus: true, focusActive: true });
    const on = screen.getByTitle("取消聚焦");
    expect(on.className).toContain("is-on");
    expect(on.getAttribute("aria-pressed")).toBe("true");
  });

  it("字段设置：未注入受控值时降级为 disabled 占位（独立渲染 seam）", () => {
    renderToolbar();
    expect((screen.getByTitle("设置显示字段") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle("设置编辑字段") as HTMLButtonElement).disabled).toBe(true);
  });

  it("字段设置：注入受控值时为可展开的勾选弹层，切换某字段回调完整 next 对象", () => {
    const onDisplayFieldsChange = vi.fn();
    renderToolbar({
      displayFields: DEFAULT_DISPLAY_FIELDS,
      onDisplayFieldsChange,
      editFields: DEFAULT_EDIT_FIELDS,
      onEditFieldsChange: vi.fn(),
    });
    const trigger = screen.getByTitle("设置显示字段") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    // 展开后勾掉「截止日期」→ 回调 next 中 due=false、其余保持。
    fireEvent.click(screen.getByText("截止日期"));
    expect(onDisplayFieldsChange).toHaveBeenCalledWith({ ...DEFAULT_DISPLAY_FIELDS, due: false });
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

  it("新建为单一按钮：点击直接回调 onNewAction，无下拉（U11）", () => {
    const { props } = renderToolbar();
    const btn = screen.getByTitle("新建动作") as HTMLButtonElement;
    // 单一按钮而非菜单触发器：无 aria-haspopup，点击即建动作。
    expect(btn.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(btn);
    expect(props.onNewAction).toHaveBeenCalledTimes(1);
    // 「新建项目」入口已从工具栏移除（改由左树承担）。
    expect(screen.queryByText("新建项目")).toBeNull();
  });

  it("拖拽契约：工具栏为 drag 区，交互元素挂 ds-no-drag", () => {
    const { container } = renderToolbar();
    expect(container.querySelector(".pw-wb-toolbar")!.className).toContain("ds-drag");
    // 边栏按钮等交互元素恢复点击（no-drag）。
    expect(screen.getByTitle("隐藏边栏").className).toContain("ds-no-drag");
  });
});
