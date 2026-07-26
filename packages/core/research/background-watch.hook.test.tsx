// @vitest-environment jsdom
// useResearchBackgroundWatch 的挂载/退订测试。
//
// 单独成文件只因它需要 DOM：core 的 vitest 默认跑在 node 环境，
// 其余纯状态逻辑留在 background-watch.test.ts 里（那些不需要 DOM，跑得更快）。
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useResearchBackgroundWatch } from "./background-watch";

describe("useResearchBackgroundWatch", () => {
  it("未启用时不订阅也不 list（大多数用户没开这个功能，不该为此多打一次 IPC）", () => {
    const list = vi.fn(async () => []);
    const onEvent = vi.fn(() => () => {});

    renderHook(() => useResearchBackgroundWatch({ list, onEvent }, false));
    expect(list).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("无桥（Web 端 / 旧壳）时同样不订阅", () => {
    const onEvent = vi.fn(() => () => {});
    renderHook(() => useResearchBackgroundWatch(null, true));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("启用时播种并订阅，卸载时退订", () => {
    const off = vi.fn();
    const list = vi.fn(async () => []);
    const onEvent = vi.fn(() => off);

    const { unmount } = renderHook(() => useResearchBackgroundWatch({ list, onEvent }, true));
    expect(list).toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalled();
    unmount();
    expect(off).toHaveBeenCalled();
  });

  it("list 失败不影响订阅（角标起始值不准，但后续事件能补上）", () => {
    const off = vi.fn();
    const list = vi.fn(async () => {
      throw new Error("boom");
    });
    const onEvent = vi.fn(() => off);

    expect(() =>
      renderHook(() => useResearchBackgroundWatch({ list, onEvent }, true)),
    ).not.toThrow();
    expect(onEvent).toHaveBeenCalled();
  });
});
