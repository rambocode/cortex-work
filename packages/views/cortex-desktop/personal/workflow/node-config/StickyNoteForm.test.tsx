// StickyNoteForm.test.tsx — 便签配置面板表单测试。

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { WorkflowNode } from "@cortex-work/core";
import { StickyNoteForm } from "./StickyNoteForm";

type StickyNode = Extract<WorkflowNode, { type: "sticky-note" }>;

function sticky(): StickyNode {
  return {
    id: "n1",
    type: "sticky-note",
    name: "",
    position: { x: 0, y: 0 },
    disabled: false,
    config: { content: "hi", color: "#fde7ea", width: 240, height: 160 },
  };
}

describe("StickyNoteForm", () => {
  it("回填内容与尺寸", () => {
    render(<StickyNoteForm node={sticky()} onChange={vi.fn()} />);
    expect(
      (screen.getByPlaceholderText(/标题/) as HTMLTextAreaElement).value,
    ).toBe("hi");
    expect((screen.getByDisplayValue("240") as HTMLInputElement).value).toBe(
      "240",
    );
  });

  it("改内容触发 onChange", () => {
    const onChange = vi.fn();
    render(<StickyNoteForm node={sticky()} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(/标题/), {
      target: { value: "新内容" },
    });
    expect(onChange.mock.calls[0]![0].config.content).toBe("新内容");
  });

  it("改色触发 onChange", () => {
    const onChange = vi.fn();
    render(<StickyNoteForm node={sticky()} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("颜色 蓝"));
    expect(onChange.mock.calls[0]![0].config.color).toBe("#dbeafe");
  });
});
