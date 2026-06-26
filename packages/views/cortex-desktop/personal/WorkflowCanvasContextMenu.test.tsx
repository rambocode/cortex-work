// WorkflowCanvasContextMenu.test.tsx — 画布右键菜单（纯展示组件）交互测试。

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Icon } from "@cortex-work/ui/icons";
import { WorkflowCanvasContextMenu } from "./WorkflowCanvasContextMenu";

describe("WorkflowCanvasContextMenu", () => {
  it("渲染 item，点击触发 onSelect 与 onClose", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkflowCanvasContextMenu
        x={10}
        y={10}
        items={[{ label: "添加便签", icon: Icon.StickyNote, onSelect }]}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText("添加便签"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("colorPicker 渲染色块，点击触发 onPick 与 onClose", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkflowCanvasContextMenu
        x={10}
        y={10}
        colorPicker={{ current: "#fde7ea", onPick }}
        items={[{ label: "删除便签", danger: true, onSelect: vi.fn() }]}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText("颜色 蓝"));
    expect(onPick).toHaveBeenCalledWith("#dbeafe");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点 backdrop 关闭", () => {
    const onClose = vi.fn();
    const { container } = render(
      <WorkflowCanvasContextMenu
        x={10}
        y={10}
        items={[{ label: "添加便签", onSelect: vi.fn() }]}
        onClose={onClose}
      />,
    );
    // 第一个子节点是 backdrop（fixed inset-0）。
    fireEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape 关闭", () => {
    const onClose = vi.fn();
    render(
      <WorkflowCanvasContextMenu
        x={10}
        y={10}
        items={[{ label: "添加便签", onSelect: vi.fn() }]}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
