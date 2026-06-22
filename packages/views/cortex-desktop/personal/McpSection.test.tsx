// McpCard(MCP 设置卡片,U3)最小渲染 + 交互测试:总开关、列表、od 预设、删除经 store;
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
  usePersonalStore.getState().setGeneralSettings({ mcp: { enabled: false, servers: [] } });
});
afterEach(cleanup);

describe("McpCard", () => {
  it("未配置时显示空态,开关默认关", () => {
    renderUI(<McpCard onEdit={vi.fn()} />);
    expect(screen.getByText("尚未配置 MCP server。")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("切换总开关 → 写入 store", () => {
    renderUI(<McpCard onEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(mcp()?.enabled).toBe(true);
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

  it("od 预设:添加 stdio od server,args 含 loopback url;重复点击不重复(U6)", () => {
    renderUI(<McpCard onEdit={vi.fn()} />);
    fireEvent.click(screen.getByText("+ od（open-design）"));
    const s = mcp()?.servers ?? [];
    expect(s).toHaveLength(1);
    expect(s[0]?.command).toBe("od");
    expect(s[0]?.args).toEqual(["mcp", "--daemon-url", "http://127.0.0.1:7456"]);
    fireEvent.click(screen.getByText("+ od（open-design）"));
    expect(mcp()?.servers).toHaveLength(1);
  });
});
