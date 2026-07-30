import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatFileRef } from "@cortex-work/core";
import { ChatFiles } from "./ChatFiles";

const FILE: ChatFileRef = {
  path: "/docs/report.docx",
  name: "季度报告.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 1024,
};

afterEach(cleanup);

describe("ChatFiles", () => {
  it("个人工作区传入打开回调时渲染可访问按钮并传递绝对路径", () => {
    const onOpenFile = vi.fn();
    render(<ChatFiles files={[FILE]} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByRole("button", { name: "预览附件：季度报告.docx" }));
    expect(onOpenFile).toHaveBeenCalledWith("/docs/report.docx");
  });

  it("未传打开回调时保持团队侧只读展示", () => {
    render(<ChatFiles files={[FILE]} />);

    expect(screen.getByText("季度报告.docx")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
