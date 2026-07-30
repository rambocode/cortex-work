// ModeBlockBanner:plan 模式拦截提示条。按 category 渲染文案,单按钮「切自动执行并重试」,
// dismiss 清提示,运行中不渲染。switch 的自动重发依赖 send(集成路径),此处只覆盖渲染 + store 交互。

import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, ModeBlockHint, SessionMeta } from "@cortex-work/core";
import { ModeBlockBanner } from "./ModeBlockBanner";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

const session: SessionMeta = {
  id: "s1",
  title: "t",
  agent: "codex",
  createdAt: 0,
  updatedAt: 0,
};

function seedHint(hint: ModeBlockHint | undefined, running = false) {
  usePersonalStore.setState({
    sessions: [session],
    modeBlockHints: { s1: hint },
    runningBySession: { s1: running ? "run-1" : undefined },
  });
}

function renderBanner() {
  return render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <ModeBlockBanner session={session} projectPath="/proj" />
    </CoreProvider>,
  );
}

afterEach(() => {
  cleanup();
  usePersonalStore.setState({ modeBlockHints: {}, runningBySession: {} });
});

describe("ModeBlockBanner", () => {
  it("写类被拦(edit):渲染单个「切自动执行」按钮 + 改文件文案", () => {
    seedHint({ category: "edit", promptText: "改文件", toolName: "Edit" });
    const { container } = renderBanner();
    expect(container.querySelectorAll(".pw-mode-block-btn.primary").length).toBe(1);
    expect(screen.getByText(/修改文件/)).toBeTruthy();
  });

  it("执行类被拦(exec):单按钮 + 执行命令文案", () => {
    seedHint({ category: "exec", promptText: "跑命令", toolName: "Shell" });
    const { container } = renderBanner();
    expect(container.querySelectorAll(".pw-mode-block-btn.primary").length).toBe(1);
    expect(screen.getByText(/执行命令/)).toBeTruthy();
  });

  it("白名单外工具/扩展工具被拦(tool):专属文案 + 点按钮写 execPermission=auto", () => {
    seedHint({ category: "tool", promptText: "/memory-index-sessions", toolName: "memory_index" });
    const { container } = renderBanner();
    expect(container.querySelectorAll(".pw-mode-block-btn.primary").length).toBe(1);
    // 用 tool 专属文案(提到「受限工具/扩展」),而非「执行命令」。
    expect(screen.getByText(/受限工具|扩展/)).toBeTruthy();
    fireEvent.click(screen.getByText("切到自动执行并重试"));
    const updated = usePersonalStore.getState().sessions.find((s) => s.id === "s1");
    expect(updated?.execPermission).toBe("auto");
  });

  it("运行中:不渲染(本轮未结束不打扰)", () => {
    seedHint({ category: "edit", promptText: "x", toolName: "Edit" }, true);
    const { container } = renderBanner();
    expect(container.querySelector(".pw-mode-block")).toBeNull();
  });

  it("无提示:不渲染", () => {
    seedHint(undefined);
    const { container } = renderBanner();
    expect(container.querySelector(".pw-mode-block")).toBeNull();
  });

  it("点忽略 → 清空该会话提示", () => {
    seedHint({ category: "exec", promptText: "x", toolName: "Shell" });
    renderBanner();
    fireEvent.click(screen.getByText("忽略"));
    expect(usePersonalStore.getState().modeBlockHints.s1).toBeUndefined();
  });

  it("点切档 → 写 execPermission=auto 并清提示", () => {
    seedHint({ category: "exec", promptText: "跑命令", toolName: "Shell" });
    renderBanner();
    fireEvent.click(screen.getByText("切到自动执行并重试"));
    const updated = usePersonalStore.getState().sessions.find((s) => s.id === "s1");
    expect(updated?.execPermission).toBe("auto");
    expect(usePersonalStore.getState().modeBlockHints.s1).toBeUndefined();
  });
});
