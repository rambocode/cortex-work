// useCloseRightPanelOnHome:进入落地页(homeOpen 转真,含首屏挂载)即收起右栏。
// 验收点对应计划 U2 的 R3/R4/R5/R6 回归:无项目默认隐藏、选项目不自动弹出、
// 显式打开不被复关、离开落地页不强制开关右栏。

import { renderHook, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useCortexUIStore } from "@cortex-work/core";
import { useCloseRightPanelOnHome } from "./PersonalWorkspace";

describe("useCloseRightPanelOnHome 进入落地页收起右栏", () => {
  beforeEach(() => {
    // 每例从「右栏打开」起步,验证 hook 是否按预期关闭。
    useCortexUIStore.setState({ rightOpen: true });
  });
  afterEach(() => cleanup());

  it("挂载时 homeOpen 为真 → 关闭右栏(R3 无项目默认隐藏)", () => {
    renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: true },
    });
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
  });

  it("homeOpen 假→真 → 关闭右栏;假态挂载不关闭", () => {
    const { rerender } = renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: false },
    });
    // 非落地页挂载不应动右栏。
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
    rerender({ homeOpen: true });
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
  });

  it("homeOpen 持真期间显式重开不被复关(R4/R5)", () => {
    const { rerender } = renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: true },
    });
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
    // 用户显式打开(点 Task / 顶栏开关):rightOpen=true 且 homeOpen 不变。
    useCortexUIStore.setState({ rightOpen: true });
    rerender({ homeOpen: true }); // 无关重渲染,effect 依赖未变不应复跑。
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });

  it("离开落地页(homeOpen 真→假)不改动右栏(R6)", () => {
    const { rerender } = renderHook(({ homeOpen }) => useCloseRightPanelOnHome(homeOpen), {
      initialProps: { homeOpen: true },
    });
    // 关闭后用户在别处把右栏打开。
    useCortexUIStore.setState({ rightOpen: true });
    rerender({ homeOpen: false });
    // 离开落地页不强制开/关,交还原有门控。
    expect(useCortexUIStore.getState().rightOpen).toBe(true);
  });
});
