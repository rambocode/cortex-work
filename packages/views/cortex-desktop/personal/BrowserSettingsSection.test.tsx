import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CoreProvider, DEFAULT_BROWSER_CONTROL, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { BrowserControlSettings, DesktopBridge } from "@cortex-work/core";

import { BrowserSettingsSection } from "./BrowserSettingsSection";

function renderUI(ui: ReactElement, bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

function setBC(patch: Partial<BrowserControlSettings>) {
  usePersonalStore.setState((s) => ({
    generalSettings: { ...s.generalSettings, browserControl: { ...DEFAULT_BROWSER_CONTROL, ...patch } },
  }));
}

const fakeBridge = (clear?: () => Promise<void>) =>
  ({ browserClearData: clear ?? (() => Promise.resolve()) }) as unknown as DesktopBridge;

describe("BrowserSettingsSection（U2 骨架 + 迁移用例）", () => {
  beforeEach(() => {
    setBC({ enabled: false });
    useCortexUIStore.setState({ toasts: [] });
  });

  it("总开关写 store", () => {
    renderUI(<BrowserSettingsSection />, fakeBridge());
    fireEvent.click(screen.getByLabelText("允许 agent 控制内置浏览器"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.enabled).toBe(true);
  });

  it("总开关关时 CDP 开关禁用(fieldset disabled)", () => {
    renderUI(<BrowserSettingsSection />, fakeBridge());
    expect(screen.getByLabelText("启用完整 CDP 访问权限")).toBeDisabled();
  });

  it("CDP 开关需确认再写 cdpEnabled", () => {
    setBC({ enabled: true });
    renderUI(<BrowserSettingsSection />, fakeBridge());
    fireEvent.click(screen.getByLabelText("启用完整 CDP 访问权限"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.cdpEnabled).toBe(false); // 仅显示确认
    fireEvent.click(screen.getByText("我已了解风险,启用"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.cdpEnabled).toBe(true);
  });

  it("网站权限:添加合法 origin;非法/重复给提示不写", () => {
    setBC({ enabled: true });
    renderUI(<BrowserSettingsSection />, fakeBridge());
    const input = screen.getByLabelText("添加");
    fireEvent.change(input, { target: { value: "not a url" } });
    fireEvent.click(screen.getByText("添加"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.approvedOrigins).toEqual([]);
    expect(screen.getByText(/完整 origin/)).toBeInTheDocument();
    // 合法(带路径)→ 归一为 origin
    fireEvent.change(input, { target: { value: "https://example.com/a" } });
    fireEvent.click(screen.getByText("添加"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.approvedOrigins).toEqual(["https://example.com"]);
    // 重复 → 提示,不重复写
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByText("添加"));
    expect(screen.getByText("该网站已在列表中")).toBeInTheDocument();
    expect(usePersonalStore.getState().generalSettings.browserControl?.approvedOrigins).toEqual(["https://example.com"]);
  });

  it("网站权限:移除 origin", () => {
    setBC({ enabled: true, approvedOrigins: ["https://x.com"] });
    renderUI(<BrowserSettingsSection />, fakeBridge());
    fireEvent.click(screen.getByText("移除"));
    expect(usePersonalStore.getState().generalSettings.browserControl?.approvedOrigins).toEqual([]);
  });

  it("清除数据:二次确认后调 IPC 并出成功 toast", async () => {
    setBC({ enabled: true });
    const clear = vi.fn(() => Promise.resolve());
    renderUI(<BrowserSettingsSection />, fakeBridge(clear));
    fireEvent.click(screen.getByText("清除所有浏览数据"));
    expect(clear).not.toHaveBeenCalled(); // 仅显示确认
    fireEvent.click(screen.getByText("确认清除"));
    expect(clear).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useCortexUIStore.getState().toasts.some((x) => x.text === "已清除浏览数据")).toBe(true));
  });

  it("Web(无 bridge)隐藏清除数据按钮,其余设置照常", () => {
    setBC({ enabled: true });
    renderUI(<BrowserSettingsSection />, null);
    expect(screen.queryByText("清除所有浏览数据")).toBeNull();
    expect(screen.getByLabelText("允许 agent 控制内置浏览器")).toBeTruthy(); // 区块仍渲染
  });
});
