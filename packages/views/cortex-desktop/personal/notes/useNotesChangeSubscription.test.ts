// 闪记变更订阅 hook 的契约回归（U1)：notes:changed → invalidate（不 setState）+ 卸载清理。
// 该 hook 须在工作区根挂载（PersonalWorkspace），否则浮层/后台落盘的闪记不刷新主窗口——
// 即「闪记有时候没显示」的根因。core 层惯例只测纯函数，Provider 包裹的 hook 放本包测（有 testing-library）。

import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { CoreProvider, useNotesChangeSubscription } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";

// 注入自建 QueryClient 以 spy invalidateQueries；desktopBridge 注入带 spy 的 onNotesChanged。
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
  it("挂载即订阅 onNotesChanged", () => {
    const onNotesChanged = vi.fn(() => () => {});
    setup({ onNotesChanged });
    expect(onNotesChanged).toHaveBeenCalledTimes(1);
  });

  it("收到 notes:changed → invalidate notesKeys.all（前缀覆盖 byProject，收件箱与时间线同刷）", () => {
    let fire: (() => void) | undefined;
    const onNotesChanged = vi.fn((cb: () => void) => {
      fire = cb;
      return () => {};
    });
    const { invalidate } = setup({ onNotesChanged });
    expect(invalidate).not.toHaveBeenCalled();
    fire!();
    // all = ["personal","notes"] 是 byProject = ["personal","notes",projectId] 的前缀，
    // RQ 默认前缀匹配 → 一次 invalidate 同时刷新收件箱与时间线。
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["personal", "notes"] });
  });

  it("卸载时调用 removeListener，无悬挂监听", () => {
    const removeListener = vi.fn();
    const onNotesChanged = vi.fn(() => removeListener);
    const { view } = setup({ onNotesChanged });
    expect(removeListener).not.toHaveBeenCalled();
    view.unmount();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("旧壳缺 onNotesChanged → 安全降级，不抛", () => {
    expect(() => setup({})).not.toThrow();
  });
});
