import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCortexUIStore } from "@cortex-work/core";
import type { Toast } from "@cortex-work/core/types";
import { ToastStack } from "./ToastStack";

afterEach(cleanup);

function toast(partial: Partial<Toast> & Pick<Toast, "id">): Toast {
  return { text: "", kind: "info", ...partial };
}

describe("ToastStack", () => {
  it("富内容:渲染标题、副标题、图标与关闭按钮", () => {
    const { container } = render(
      <ToastStack
        items={[toast({ id: "1", kind: "success", title: "5h 配额已重置", description: "Codex 可以继续使用", iconName: "CheckCircle", dismissible: true })]}
      />,
    );
    expect(screen.getByText("5h 配额已重置")).toBeInTheDocument();
    expect(screen.getByText("Codex 可以继续使用")).toBeInTheDocument();
    expect(container.querySelector(".toast-icon svg")).toBeTruthy();
    expect(screen.getByLabelText("关闭提醒")).toBeInTheDocument();
  });

  it("向后兼容:无 title 时渲染 text 主行,不出现标题/副标题节点", () => {
    const { container } = render(<ToastStack items={[toast({ id: "1", text: "已切换" })]} />);
    expect(screen.getByText("已切换")).toBeInTheDocument();
    expect(container.querySelector(".toast-title")).toBeNull();
    expect(container.querySelector(".toast-desc")).toBeNull();
  });

  it("items 为空时渲染 null(无 .toast-stack 容器)", () => {
    const { container } = render(<ToastStack items={[]} />);
    expect(container.querySelector(".toast-stack")).toBeNull();
  });

  it("点击关闭按钮调用 dismissToast 移除该条", () => {
    useCortexUIStore.setState({ toasts: [] });
    useCortexUIStore.getState().pushToast("第一条", { duration: 0 });
    const items = useCortexUIStore.getState().toasts;
    render(<ToastStack items={items} />);
    fireEvent.click(screen.getByLabelText("关闭提醒"));
    expect(useCortexUIStore.getState().toasts).toHaveLength(0);
  });

  it("未知 iconName 回退默认图标,不抛错", () => {
    const { container } = render(
      <ToastStack items={[toast({ id: "1", text: "x", iconName: "DoesNotExist" })]} />,
    );
    expect(container.querySelector(".toast-icon svg")).toBeTruthy();
  });

  it("dismissible 为 false 时不渲染关闭按钮", () => {
    render(<ToastStack items={[toast({ id: "1", text: "常驻", dismissible: false })]} />);
    expect(screen.queryByLabelText("关闭提醒")).toBeNull();
  });
});
