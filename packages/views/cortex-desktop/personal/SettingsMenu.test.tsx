// 设置入口 + 整页设置视图（PersonalSettingsView）的最小渲染测试。
// 仅依赖 store（openSettings/closeSettings）与默认 profile/通用分区,不需真实 bridge。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import { SettingsMenu, PersonalSettingsView } from "./SettingsMenu";

function renderUI(ui: ReactElement) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
      {ui}
    </CoreProvider>,
  );
}

describe("设置入口与整页设置视图", () => {
  beforeEach(() => {
    usePersonalStore.setState({ settingsOpen: false, profile: {} });
  });
  afterEach(() => cleanup());

  it("点击侧栏「设置」入口打开整页(settingsOpen=true)", () => {
    renderUI(<SettingsMenu />);
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(true);
  });

  it("点击「返回应用」关闭整页(settingsOpen=false)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "返回应用" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
  });

  it("挂载时焦点移入覆盖层(返回按钮)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "返回应用" }));
  });

  it("非输入态按 ESC 返回", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    // 挂载后焦点在返回按钮(非输入态),ESC 触发 closeSettings。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(false);
  });

  it("输入态按 ESC 不返回(避免误关/丢输入)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    const nickname = screen.getByPlaceholderText("我"); // ProfileSection 昵称输入
    nickname.focus();
    expect(document.activeElement).toBe(nickname);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(true);
  });

  it("默认「个人资料」分区,切到「通用」右栏与菜单态同步(Covers R4)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    renderUI(<PersonalSettingsView />);
    // 默认 profile 分区（以其唯一描述文案断言）。
    expect(screen.getByText("设置你的昵称和头像,会话中你发出的消息会用它们显示。")).toBeTruthy();
    // 切到通用 → 右栏换为 GeneralSection（唯一描述文案）。
    fireEvent.click(screen.getByRole("button", { name: "通用" }));
    expect(screen.getByText("管理界面偏好、默认工作目录与桌面行为。")).toBeTruthy();
    // 菜单态：通用项 is-active + aria-current=page。
    const active = screen.getByRole("button", { name: "通用" });
    expect(active.className).toContain("is-active");
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("卸载后 window keydown 监听解绑(ESC 不再返回)", () => {
    usePersonalStore.setState({ settingsOpen: true });
    const { unmount } = renderUI(<PersonalSettingsView />);
    unmount();
    usePersonalStore.setState({ settingsOpen: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(usePersonalStore.getState().settingsOpen).toBe(true);
  });
});
