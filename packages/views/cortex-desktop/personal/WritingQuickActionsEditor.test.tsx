// 快捷指令编辑器单测:内置禁用/覆盖、自定义增删改、达 12 上限禁用「添加」。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoreProvider } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import {
  countCustomQuickActions,
  defaultWritingQuickActions,
} from "@cortex-work/core/writing/quick-actions";
import type { WritingQuickAction } from "@cortex-work/core/writing/quick-actions";

import { WritingQuickActionsEditor } from "./WritingQuickActionsEditor";

function renderUI() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
      <WritingQuickActionsEditor />
    </CoreProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  useWritingSpacesStore.setState({ quickActions: defaultWritingQuickActions() });
});

describe("WritingQuickActionsEditor", () => {
  it("渲染内置项(占位=默认文案)+ 添加/恢复默认按钮", () => {
    renderUI();
    // 内置 polish 的 label 输入 placeholder = 默认「润色」。
    expect(screen.getByPlaceholderText("润色")).toBeTruthy();
    expect(screen.getByText("添加自定义指令")).toBeTruthy();
    expect(screen.getByText("恢复默认")).toBeTruthy();
  });

  it("禁用内置项 → 写 store enabled=false", () => {
    renderUI();
    // 内置开关 aria-label = 默认 label「润色」。
    const sw = screen.getByRole("switch", { name: "润色" });
    fireEvent.click(sw);
    const polish = useWritingSpacesStore.getState().quickActions.find((a) => a.id === "polish")!;
    expect(polish.enabled).toBe(false);
  });

  it("添加自定义指令 → store 自定义 +1", () => {
    renderUI();
    expect(countCustomQuickActions(useWritingSpacesStore.getState().quickActions)).toBe(0);
    fireEvent.click(screen.getByText("添加自定义指令"));
    expect(countCustomQuickActions(useWritingSpacesStore.getState().quickActions)).toBe(1);
  });

  it("达 12 条自定义上限 → 「添加」禁用", () => {
    const custom: WritingQuickAction[] = Array.from({ length: 12 }, (_, i) => ({
      id: `custom-${i}`,
      label: `c${i}`,
      prompt: `p${i}`,
      mode: "chat",
      enabled: true,
    }));
    useWritingSpacesStore.setState({
      quickActions: [...defaultWritingQuickActions(), ...custom],
    });
    renderUI();
    expect(screen.getByText("添加自定义指令").closest("button")!).toBeDisabled();
  });

  it("删除自定义指令 → store 移除", () => {
    useWritingSpacesStore.setState({
      quickActions: [
        ...defaultWritingQuickActions(),
        { id: "custom-x", label: "待删", prompt: "p", mode: "chat", enabled: true },
      ],
    });
    renderUI();
    expect(countCustomQuickActions(useWritingSpacesStore.getState().quickActions)).toBe(1);
    fireEvent.click(screen.getByLabelText("删除该指令"));
    expect(countCustomQuickActions(useWritingSpacesStore.getState().quickActions)).toBe(0);
  });
});
