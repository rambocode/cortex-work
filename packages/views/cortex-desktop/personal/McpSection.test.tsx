// McpCard(MCP 设置卡片,U3)最小渲染 + 交互测试:总开关、增删 server 经 store 持久化。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  // 每例从「未配置」起步。
  usePersonalStore.getState().setGeneralSettings({ mcp: { enabled: false, servers: [] } });
});
afterEach(cleanup);

describe("McpCard", () => {
  it("未配置时显示空态,开关默认关", () => {
    renderUI(<McpCard />);
    expect(screen.getByText("尚未配置 MCP server。")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("切换总开关 → 写入 store", () => {
    renderUI(<McpCard />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(mcp()?.enabled).toBe(true);
  });

  it("添加 server → store 多一条 stdio 条目;编辑命令回写;删除移除", () => {
    renderUI(<McpCard />);
    fireEvent.click(screen.getByText("+ 添加 MCP server"));
    expect(mcp()?.servers).toHaveLength(1);
    expect(mcp()?.servers[0]?.transport).toBe("stdio");

    // 编辑命令输入(第二个输入框是 command)
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[1]!, { target: { value: "/usr/local/bin/mcp-fs" } });
    expect(mcp()?.servers[0]?.command).toBe("/usr/local/bin/mcp-fs");

    fireEvent.click(screen.getByText("删除"));
    expect(mcp()?.servers).toHaveLength(0);
  });
});
