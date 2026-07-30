import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationDetailHeader } from "./AutomationDetailHeader";

afterEach(() => cleanup());

const noop = () => {};
const baseProps = () => ({
  name: "历史上的今天",
  enabled: true,
  onBack: noop,
  onToggleEnabled: noop,
  onRun: noop,
  onEdit: noop,
  onCopyPrompt: noop,
  onExport: noop,
  onDuplicate: noop,
  onDelete: noop,
});

describe("AutomationDetailHeader", () => {
  it("启用态:徽章「已启用」、开关 data-on=1", () => {
    const { getByText, container } = render(<AutomationDetailHeader {...baseProps()} />);
    expect(getByText("已启用")).toBeTruthy();
    expect(container.querySelector(".twk-toggle")?.getAttribute("data-on")).toBe("1");
  });

  it("停用态:徽章「已停用」、开关 data-on=0", () => {
    const { getByText, container } = render(<AutomationDetailHeader {...baseProps()} enabled={false} />);
    expect(getByText("已停用")).toBeTruthy();
    expect(container.querySelector(".twk-toggle")?.getAttribute("data-on")).toBe("0");
  });

  it("开关/立即运行/编辑分别触发对应回调", () => {
    const onToggleEnabled = vi.fn();
    const onRun = vi.fn();
    const onEdit = vi.fn();
    const { getByText, container } = render(
      <AutomationDetailHeader {...baseProps()} onToggleEnabled={onToggleEnabled} onRun={onRun} onEdit={onEdit} />,
    );
    fireEvent.click(container.querySelector(".twk-toggle")!);
    fireEvent.click(getByText("立即运行"));
    fireEvent.click(getByText("编辑"));
    expect(onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("运行中态:按钮显示「运行中…」且禁用", () => {
    const { getByText } = render(<AutomationDetailHeader {...baseProps()} running />);
    const btn = getByText("运行中…").closest("button")!;
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("更多菜单含四项且不含复制链接", () => {
    const { getByTitle, getByText, queryByText } = render(<AutomationDetailHeader {...baseProps()} />);
    fireEvent.click(getByTitle("更多"));
    expect(getByText("复制提示词")).toBeTruthy();
    expect(getByText("导出运行历史")).toBeTruthy();
    expect(getByText("创建副本")).toBeTruthy();
    expect(getByText("删除自动化")).toBeTruthy();
    expect(queryByText("复制链接")).toBeNull();
  });

  it("复制提示词/导出/创建副本点击即触发回调", () => {
    const onCopyPrompt = vi.fn();
    const onExport = vi.fn();
    const onDuplicate = vi.fn();
    const { getByTitle, getByText } = render(
      <AutomationDetailHeader {...baseProps()} onCopyPrompt={onCopyPrompt} onExport={onExport} onDuplicate={onDuplicate} />,
    );
    fireEvent.click(getByTitle("更多"));
    fireEvent.click(getByText("复制提示词"));
    fireEvent.click(getByTitle("更多"));
    fireEvent.click(getByText("导出运行历史"));
    fireEvent.click(getByTitle("更多"));
    fireEvent.click(getByText("创建副本"));
    expect(onCopyPrompt).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("删除走二次确认:首点切文案,再点才触发 onDelete", () => {
    const onDelete = vi.fn();
    const { getByTitle, getByText } = render(<AutomationDetailHeader {...baseProps()} onDelete={onDelete} />);
    fireEvent.click(getByTitle("更多"));
    fireEvent.click(getByText("删除自动化"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(getByText("确认删除？")).toBeTruthy();
    fireEvent.click(getByText("确认删除？"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
