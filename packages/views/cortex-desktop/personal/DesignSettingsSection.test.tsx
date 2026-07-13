import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import { defaultDesignSettings } from "@cortex-work/core/design/compat/app-settings";
import { DesignSettingsSection } from "./DesignSettingsSection";

const TEST_WS_ID = "test-ws";
const TEST_IDENTITY = { userId: "me", name: "我" };

function renderUI(bridge: DesktopBridge | null = null) {
  return render(
    <CoreProvider wsId={TEST_WS_ID} identity={TEST_IDENTITY} desktopBridge={bridge}>
      <DesignSettingsSection />
    </CoreProvider>,
  );
}

beforeEach(() => {
  usePersonalStore.setState({ designSettings: defaultDesignSettings() });
});

afterEach(cleanup);

describe("DesignSettingsSection", () => {
  it("渲染紧凑摘要与五个语义卡片", () => {
    const { container } = renderUI();
    const root = container.querySelector(".pw-design-settings");
    expect(root).not.toBeNull();
    expect(root!.querySelectorAll(".pw-design-card")).toHaveLength(5);
    expect(root!.querySelector(".pw-design-card--workspace")).not.toBeNull();

    const summary = within(root!.querySelector(".pw-design-summary") as HTMLElement);
    expect(summary.getByText("默认视口")).toBeTruthy();
    expect(summary.getByText("桌面")).toBeTruthy();
    expect(summary.getByText("默认视图")).toBeTruthy();
    expect(summary.getByText("预览")).toBeTruthy();
    expect(summary.getByText("设计系统预设")).toBeTruthy();
    expect(summary.getByText("none")).toBeTruthy();
  });

  it("字段与开关继续更新 designSettings store", () => {
    renderUI();
    fireEvent.change(screen.getByPlaceholderText("React + Tailwind + shadcn/ui"), {
      target: { value: "React + CSS Modules" },
    });
    fireEvent.change(screen.getByDisplayValue("桌面"), { target: { value: "mobile" } });
    fireEvent.click(screen.getByRole("switch", { name: "实时刷新" }));

    expect(usePersonalStore.getState().designSettings).toMatchObject({
      implementStackHint: "React + CSS Modules",
      defaultViewport: "mobile",
      liveRefresh: false,
    });
  });

  it("选择目录与恢复默认沿用 DesktopBridge", async () => {
    const pickDirectory = vi.fn(async () => "/tmp/design-picked");
    const designWorkspaceRoot = vi.fn(async () => "/tmp/design-default");
    const bridge = { pickDirectory, designWorkspaceRoot } as unknown as DesktopBridge;
    renderUI(bridge);

    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await screen.findByDisplayValue("/tmp/design-picked");
    expect(pickDirectory).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await screen.findByDisplayValue("/tmp/design-default");
    expect(designWorkspaceRoot).toHaveBeenCalledTimes(1);
  });

  it("bridge 不可用时目录按钮保持禁用", () => {
    renderUI(null);
    expect(screen.getByRole("button", { name: "选择目录" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复默认" })).toBeDisabled();
  });

  it("设计设置样式声明双列、跨列和容器窄屏回落", () => {
    const css = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");
    expect(css).toMatch(/\.pw-design-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/\.pw-design-card--workspace\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    expect(css).toMatch(/@container\s+design-settings\s*\(max-width:\s*720px\)/);
  });
});
