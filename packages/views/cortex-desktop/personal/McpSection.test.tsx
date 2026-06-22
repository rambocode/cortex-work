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

  it("连接自定义 MCP:打开表单 → 填名称+命令+参数+工作目录 → 保存写 store", () => {
    renderUI(<McpCard />);
    fireEvent.click(screen.getByText("+ 连接自定义 MCP"));
    // 表单标题
    expect(screen.getByText("连接至自定义 MCP")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("MCP server name"), { target: { value: "My FS" } });
    fireEvent.change(screen.getByPlaceholderText("openai-dev-mcp serve-sqlite"), { target: { value: "/usr/local/bin/mcp-fs" } });
    fireEvent.change(screen.getByPlaceholderText("~/code"), { target: { value: "~/code" } });
    // 添加一个参数
    fireEvent.click(screen.getByText("添加参数"));
    const args = screen.getAllByRole("textbox").find((el) => (el as HTMLInputElement).value === "");
    fireEvent.change(args!, { target: { value: "--root" } });
    fireEvent.click(screen.getByText("保存"));
    const s = mcp()?.servers ?? [];
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ label: "My FS", transport: "stdio", command: "/usr/local/bin/mcp-fs", cwd: "~/code", args: ["--root"] });
    expect(s[0]?.id).toBe("my-fs"); // 名称 slug 化为 TOML 安全 id
  });

  it("流式 HTTP:切换 transport → 保存 http server(url)", () => {
    renderUI(<McpCard />);
    fireEvent.click(screen.getByText("+ 连接自定义 MCP"));
    fireEvent.change(screen.getByPlaceholderText("MCP server name"), { target: { value: "Remote" } });
    fireEvent.click(screen.getByRole("tab", { name: "流式 HTTP" }));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/mcp"), { target: { value: "https://mcp.example/sse" } });
    fireEvent.click(screen.getByText("保存"));
    expect(mcp()?.servers[0]).toMatchObject({ transport: "http", url: "https://mcp.example/sse" });
  });

  it("列表:点条目进编辑、删除移除", () => {
    usePersonalStore.getState().setGeneralSettings({ mcp: { enabled: true, servers: [{ id: "fs", label: "FS", transport: "stdio", command: "/bin/fs" }] } });
    renderUI(<McpCard />);
    expect(screen.getByText("FS")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("删除 FS"));
    expect(mcp()?.servers).toHaveLength(0);
  });

  it("od 预设:添加 stdio od server,args 含 loopback url;重复点击不重复(U6)", () => {
    renderUI(<McpCard />);
    fireEvent.click(screen.getByText("+ od（open-design）"));
    const s = mcp()?.servers ?? [];
    expect(s).toHaveLength(1);
    expect(s[0]?.command).toBe("od");
    expect(s[0]?.args).toEqual(["mcp", "--daemon-url", "http://127.0.0.1:7456"]);
    fireEvent.click(screen.getByText("+ od（open-design）"));
    expect(mcp()?.servers).toHaveLength(1);
  });
});
