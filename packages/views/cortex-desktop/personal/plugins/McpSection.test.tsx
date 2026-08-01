// McpCard(MCP 设置卡片,U3)最小渲染 + 交互测试:总开关、列表、删除经 store;
// 新增/编辑表单已上提为独立页(经 onEdit 回调),本卡只验证 onEdit 被调用(表单本身见 McpServerForm.test)。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import { McpCard } from "./McpSection";

function renderUI(ui: ReactElement) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
      {ui}
    </CoreProvider>,
  );
}

const mcp = () => usePersonalStore.getState().generalSettings.mcp;

beforeEach(() => {
  usePersonalStore.getState().setGeneralSettings({
    agentBrowser: { enabled: true },
    mcp: { enabled: false, servers: [] },
  });
});
afterEach(cleanup);

describe("McpCard", () => {
  it("单独显示默认开启的内置 Agent Browser", () => {
    renderUI(<McpCard onEdit={vi.fn()} />);
    expect(screen.getByText("Agent Browser（内置）")).toBeTruthy();
    expect(screen.getAllByText(/Claude Code、Codex 与 Cortex/)).toHaveLength(2);
    expect((screen.getByLabelText("启用内置 Agent Browser") as HTMLInputElement).checked).toBe(true);
  });

  it("未配置时显示空态,自定义 MCP 开关默认关", () => {
    renderUI(<McpCard onEdit={vi.fn()} />);
    expect(screen.getByText("尚未配置 MCP server。")).toBeTruthy();
    expect((screen.getByLabelText("启用自定义 MCP 注入") as HTMLInputElement).checked).toBe(false);
  });

  it("切换自定义 MCP 总开关 → 写入 store", () => {
    renderUI(<McpCard onEdit={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("启用自定义 MCP 注入"));
    expect(mcp()?.enabled).toBe(true);
  });

  it("切换内置 Agent Browser → 写入独立设置", () => {
    renderUI(<McpCard onEdit={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("启用内置 Agent Browser"));
    expect(usePersonalStore.getState().generalSettings.agentBrowser).toEqual({ enabled: false });
  });

  it("「连接自定义 MCP」→ onEdit(null)(打开独立新增页)", () => {
    const onEdit = vi.fn();
    renderUI(<McpCard onEdit={onEdit} />);
    fireEvent.click(screen.getByText("+ 连接自定义 MCP"));
    expect(onEdit).toHaveBeenCalledWith(null);
  });

  it("点列表条目 → onEdit(index)(打开独立编辑页);删除移除", () => {
    usePersonalStore.getState().setGeneralSettings({ mcp: { enabled: true, servers: [{ id: "fs", label: "FS", transport: "stdio", command: "/bin/fs" }] } });
    const onEdit = vi.fn();
    renderUI(<McpCard onEdit={onEdit} />);
    fireEvent.click(screen.getByText("FS"));
    expect(onEdit).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByLabelText("删除 FS"));
    expect(mcp()?.servers).toHaveLength(0);
  });
});
