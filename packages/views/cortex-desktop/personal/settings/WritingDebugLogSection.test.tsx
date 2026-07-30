// 写作日志卡单测:无能力不渲染;查看→拉取渲染列表;清空→调 bridge 并清列表。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { WritingDebugLogEntry } from "@cortex-work/core/desktop/types";

import { WritingDebugLogSection } from "./WritingDebugLogSection";

const ENTRIES: WritingDebugLogEntry[] = [
  { id: "a", kind: "complete", ts: Date.now(), model: "deepseek-chat", ok: true, ms: 320, chars: 12 },
  { id: "b", kind: "edit", ts: Date.now(), model: "gpt-4o-mini", ok: false, ms: 900, chars: 0, error: "超时" },
];

function renderUI(bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingDebugLogSection />
    </CoreProvider>,
  );
}

afterEach(cleanup);

describe("WritingDebugLogSection", () => {
  it("无桌面能力(bridge=null)→ 不渲染", () => {
    const { container } = renderUI(null);
    expect(container.textContent).toBe("");
  });

  it("查看最近调用 → 开弹窗、拉取并渲染列表(成功/失败条目);关闭收起", async () => {
    const bridge = {
      writingDebugLog: vi.fn().mockResolvedValue(ENTRIES),
      writingDebugLogClear: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopBridge;
    renderUI(bridge);
    fireEvent.click(screen.getByText("查看最近调用"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy()); // 弹窗打开
    await waitFor(() => expect(screen.getByText("deepseek-chat")).toBeTruthy());
    expect(bridge.writingDebugLog).toHaveBeenCalled();
    // 成功条目显示字符数;失败条目显示错误。
    expect(screen.getByText(/成功 · 12字/)).toBeTruthy();
    expect(screen.getByText("超时")).toBeTruthy();
    // 关闭 → 弹窗收起。
    fireEvent.click(screen.getByLabelText("关闭"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("清空 → 调 bridge 并清列表", async () => {
    const bridge = {
      writingDebugLog: vi.fn().mockResolvedValue(ENTRIES),
      writingDebugLogClear: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopBridge;
    renderUI(bridge);
    fireEvent.click(screen.getByText("查看最近调用"));
    await waitFor(() => expect(screen.getByText("deepseek-chat")).toBeTruthy());
    fireEvent.click(screen.getByText("清空"));
    await waitFor(() => expect(bridge.writingDebugLogClear).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("deepseek-chat")).toBeNull());
  });
});
