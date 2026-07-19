// 「已自动保存」指示器：设置类切片变化 → 浮现;无关切片变化 → 不触发;计时隐藏/重置。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import { SettingsSavedIndicator } from "./SettingsSavedIndicator";

function renderUI() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }}>
      <SettingsSavedIndicator />
    </CoreProvider>,
  );
}

describe("SettingsSavedIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("初始不显示;修改设置切片后显示「已自动保存」", () => {
    renderUI();
    expect(screen.queryByText("已自动保存")).toBeNull();
    act(() => {
      usePersonalStore.getState().setGeneralSettings({ workspaceRoot: "/tmp/x" });
    });
    expect(screen.getByText("已自动保存")).toBeTruthy();
  });

  it("非设置切片变化不触发指示", () => {
    renderUI();
    act(() => {
      usePersonalStore.setState({ settingsOpen: true });
    });
    expect(screen.queryByText("已自动保存")).toBeNull();
  });

  it("显示 2 秒后自动隐藏;连续修改重置计时", () => {
    renderUI();
    act(() => {
      usePersonalStore.getState().setProfile({ nickname: "a" });
    });
    expect(screen.getByText("已自动保存")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1500);
      usePersonalStore.getState().setProfile({ nickname: "ab" });
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // 距上次修改仅 1.5s（计时被重置）,仍可见。
    expect(screen.getByText("已自动保存")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText("已自动保存")).toBeNull();
  });
});
