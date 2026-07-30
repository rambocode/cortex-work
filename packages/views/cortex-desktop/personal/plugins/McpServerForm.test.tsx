// McpServerForm(连接至自定义 MCP 表单)单测:名称 slug、stdio/http 保存、参数/工作目录。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@cortex-work/core";
import { McpServerForm } from "./McpServerForm";

afterEach(cleanup);

function renderForm(initial?: McpServerConfig) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(<McpServerForm initial={initial} existingIds={[]} onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel };
}

describe("McpServerForm", () => {
  it("新增 stdio:名称+命令+参数+工作目录 → onSave;名称 slug 为 TOML 安全 id", () => {
    const { onSave } = renderForm();
    fireEvent.change(screen.getByPlaceholderText("MCP server name"), { target: { value: "My FS" } });
    fireEvent.change(screen.getByPlaceholderText("openai-dev-mcp serve-sqlite"), { target: { value: "/bin/fs" } });
    fireEvent.change(screen.getByPlaceholderText("~/code"), { target: { value: "~/code" } });
    fireEvent.click(screen.getByText("添加参数"));
    const empty = screen.getAllByRole("textbox").find((el) => (el as HTMLInputElement).value === "");
    fireEvent.change(empty!, { target: { value: "--root" } });
    fireEvent.click(screen.getByText("保存"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "my-fs", label: "My FS", transport: "stdio", command: "/bin/fs", cwd: "~/code", args: ["--root"] }));
  });

  it("切流式 HTTP → 保存 url", () => {
    const { onSave } = renderForm();
    fireEvent.change(screen.getByPlaceholderText("MCP server name"), { target: { value: "Remote" } });
    fireEvent.click(screen.getByRole("tab", { name: "流式 HTTP" }));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/mcp"), { target: { value: "https://mcp.example/sse" } });
    fireEvent.click(screen.getByText("保存"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ transport: "http", url: "https://mcp.example/sse" }));
  });

  it("名称为空 → 保存禁用", () => {
    renderForm();
    expect((screen.getByText("保存").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("编辑既有 server:回填名称/命令,保存保留原 id", () => {
    const { onSave } = renderForm({ id: "fs", label: "FS", transport: "stdio", command: "/bin/fs" });
    expect((screen.getByPlaceholderText("MCP server name") as HTMLInputElement).value).toBe("FS");
    fireEvent.click(screen.getByText("保存"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "fs", label: "FS" }));
  });

  it("取消 → onCancel", () => {
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByText("取消"));
    expect(onCancel).toHaveBeenCalled();
  });
});
