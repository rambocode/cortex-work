// StickyNoteNode.test.tsx — 便签画布组件交互测试。
// @xyflow/react 的 NodeToolbar/NodeResizer 依赖 ReactFlow store，本测试桩掉它们，
// 专注组件自身逻辑：Markdown 渲染、双击编辑提交、改色、删除。

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { NodeProps } from "@xyflow/react";
import type { WorkflowNode } from "@cortex-work/core";
import {
  WorkflowNodeActionsContext,
  type WorkflowNodeActions,
} from "./WorkflowNodes";

// 桩：NodeToolbar 始终渲染 children（便于测工具栏按钮），NodeResizer 渲染占位。
vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: ReactNode }) => (
    <div data-testid="toolbar">{children}</div>
  ),
  NodeResizer: () => <div data-testid="resizer" />,
  Position: { Top: "top" },
}));

import { StickyNoteNode } from "./StickyNoteNode";

function makeSticky(content: string, color = "#fde7ea"): WorkflowNode {
  return {
    id: "n1",
    type: "sticky-note",
    name: "",
    position: { x: 0, y: 0 },
    disabled: false,
    config: { content, color, width: 240, height: 160 },
  } as WorkflowNode;
}

function renderNode(
  node: WorkflowNode,
  actions: Partial<WorkflowNodeActions> = {},
  selected = true,
) {
  const value: WorkflowNodeActions = {
    runNode: vi.fn(),
    toggleDisabled: vi.fn(),
    deleteNode: vi.fn(),
    updateNode: vi.fn(),
    ...actions,
  };
  // NodeProps 字段众多，测试只用 id/data/selected，转 NodeProps 收窄。
  const props = {
    id: node.id,
    data: { node },
    selected,
  } as unknown as NodeProps;
  const utils = render(
    <WorkflowNodeActionsContext.Provider value={value}>
      <StickyNoteNode {...props} />
    </WorkflowNodeActionsContext.Provider>,
  );
  return { value, container: utils.container };
}

describe("StickyNoteNode", () => {
  it("渲染 Markdown：加粗与链接", () => {
    renderNode(makeSticky("**粗体** 和 [指南](http://x)"));
    const strong = screen.getByText("粗体");
    expect(strong.tagName).toBe("STRONG");
    const link = screen.getByText("指南") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("http://x");
  });

  it("双击进入编辑，改文本失焦后提交 content", () => {
    const updateNode = vi.fn();
    const { container } = renderNode(makeSticky("原始"), { updateNode });
    fireEvent.doubleClick(container.firstChild as Element);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toBe("原始");
    fireEvent.change(ta, { target: { value: "新内容" } });
    fireEvent.blur(ta);
    expect(updateNode).toHaveBeenCalledTimes(1);
    expect(updateNode.mock.calls[0]![0].config.content).toBe("新内容");
  });

  it("内容未变则失焦不回写", () => {
    const updateNode = vi.fn();
    const { container } = renderNode(makeSticky("不变"), { updateNode });
    fireEvent.doubleClick(container.firstChild as Element);
    fireEvent.blur(screen.getByRole("textbox"));
    expect(updateNode).not.toHaveBeenCalled();
  });

  it("改色：选调色板颜色调用 updateNode(config.color)", () => {
    const updateNode = vi.fn();
    renderNode(makeSticky("x", "#fde7ea"), { updateNode });
    fireEvent.click(screen.getByLabelText("更改颜色"));
    // 选一个非当前色（蓝 #dbeafe）
    fireEvent.click(screen.getByLabelText("颜色 蓝"));
    expect(updateNode).toHaveBeenCalledTimes(1);
    expect(updateNode.mock.calls[0]![0].config.color).toBe("#dbeafe");
  });

  it("删除：调用 deleteNode(id)", () => {
    const deleteNode = vi.fn();
    renderNode(makeSticky("x"), { deleteNode });
    fireEvent.click(screen.getByLabelText("删除便签"));
    expect(deleteNode).toHaveBeenCalledWith("n1");
  });

  it("不渲染连接 handle", () => {
    const { container } = renderNode(makeSticky("x"));
    expect(container.querySelector(".react-flow__handle")).toBeNull();
  });
});
