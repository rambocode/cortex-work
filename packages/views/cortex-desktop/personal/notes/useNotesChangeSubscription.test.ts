// 闪记变更订阅 hook 的契约回归（U1)：sync:invalidate(scope=notes) → invalidate（不 setState）+ 卸载清理。
// 该 hook 须在工作区根挂载（PersonalWorkspace），否则浮层/后台落盘的闪记不刷新主窗口——
// 即「闪记有时候没显示」的根因。core 层惯例只测纯函数，Provider 包裹的 hook 放本包测（有 testing-library）。
// 信封归一 P1:订阅通道由 onNotesChanged 收敛为统一的 onSyncInvalidate(scope 过滤在 hook 内)。

import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { CoreProvider, useNotesChangeSubscription } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";

// 注入自建 QueryClient 以 spy invalidateQueries；desktopBridge 注入带 spy 的 onSyncInvalidate。
function setup(bridge: Partial<DesktopBridge>) {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(CoreProvider, {
      wsId: "test-ws",
      identity: { userId: "me", name: "我" },
      queryClient: qc,
      desktopBridge: bridge as DesktopBridge,
      children,
    });
  const view = renderHook(() => useNotesChangeSubscription(), { wrapper });
  return { qc, invalidate, view };
}

afterEach(() => vi.restoreAllMocks());

describe("useNotesChangeSubscription（闪记刷新订阅）", () => {
  it("挂载即订阅 onSyncInvalidate", () => {
    const onSyncInvalidate = vi.fn(() => () => {});
    setup({ onSyncInvalidate });
    expect(onSyncInvalidate).toHaveBeenCalledTimes(1);
  });

  it("收到 scope=notes → invalidate notesKeys.all（前缀覆盖 byProject，收件箱与时间线同刷）", () => {
    let fire: ((scope: string) => void) | undefined;
    const onSyncInvalidate = vi.fn((cb: (scope: string) => void) => {
      fire = cb;
      return () => {};
    });
    const { invalidate } = setup({ onSyncInvalidate });
    expect(invalidate).not.toHaveBeenCalled();
    // 非本域信号被 scope 过滤,不触发失效。
    fire!("tasks");
    expect(invalidate).not.toHaveBeenCalled();
    fire!("notes");
    // all = ["personal","notes"] 是 byProject = ["personal","notes",projectId] 的前缀，
    // RQ 默认前缀匹配 → 一次 invalidate 同时刷新收件箱与时间线。
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["personal", "notes"] });
  });

  it("卸载时调用 removeListener，无悬挂监听", () => {
    const removeListener = vi.fn();
    const onSyncInvalidate = vi.fn(() => removeListener);
    const { view } = setup({ onSyncInvalidate });
    expect(removeListener).not.toHaveBeenCalled();
    view.unmount();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("旧壳缺 onSyncInvalidate → 安全降级，不抛", () => {
    expect(() => setup({})).not.toThrow();
  });
});
