// tasks 二次编辑弹框（U3）:写意见 → 拼「意见 + 上下文」→ 复用 store 发到聊天框/终端。
// 验证上下文拼装（有/无选区）、submit 标志、bracketed paste、空意见禁用、ESC 关闭。

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type DesktopBridge } from "@cortex-work/core";
import { DocEditDialog } from "./DocEditDialog";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

function renderDialog(props: { path?: string; selection?: string; onClose?: () => void; onToast?: (t: string) => void } = {}) {
  return render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <DocEditDialog
        path={props.path ?? "docs/plans/x.md"}
        selection={props.selection ?? ""}
        onClose={props.onClose ?? (() => {})}
        onToast={props.onToast ?? (() => {})}
      />
    </CoreProvider>,
  );
}

const typeComment = (text: string) =>
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

afterEach(() => {
  cleanup();
  usePersonalStore.setState({ composerInsert: undefined, pendingTerminalText: undefined, terminalOpen: false });
});

describe("DocEditDialog", () => {
  it("渲染意见输入框与四个按钮", () => {
    renderDialog();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "插入到聊天框" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "插入并运行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送到终端" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("意见为空 → 三个动作按钮禁用", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "插入到聊天框" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "插入并运行" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送到终端" })).toBeDisabled();
  });

  it("有选区 + 插入到聊天框 → 发送文本含意见、路径、选中段落;submit 关;触发 toast 与关闭", () => {
    const onClose = vi.fn();
    const onToast = vi.fn();
    renderDialog({ path: "docs/x.md", selection: "选中的一段", onClose, onToast });
    typeComment("改成这样");
    fireEvent.click(screen.getByRole("button", { name: "插入到聊天框" }));
    const ins = usePersonalStore.getState().composerInsert;
    expect(ins?.text).toContain("改成这样");
    expect(ins?.text).toContain("docs/x.md");
    expect(ins?.text).toContain("选中的一段");
    expect(ins?.submit).toBeFalsy();
    expect(onToast).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("插入并运行 → submit 标志为真", () => {
    renderDialog({ selection: "x" });
    typeComment("跑一下");
    fireEvent.click(screen.getByRole("button", { name: "插入并运行" }));
    expect(usePersonalStore.getState().composerInsert?.submit).toBe(true);
  });

  it("无选区 → 发送文本只带路径、不含代码围栏", () => {
    renderDialog({ path: "docs/y.md", selection: "" });
    typeComment("仅意见");
    fireEvent.click(screen.getByRole("button", { name: "插入到聊天框" }));
    const text = usePersonalStore.getState().composerInsert?.text ?? "";
    expect(text).toContain("docs/y.md");
    expect(text).not.toContain("```");
  });

  it("发送到终端 → bracketed paste 包裹、含意见、终端打开", () => {
    renderDialog({ selection: "片段" });
    typeComment("终端跑");
    fireEvent.click(screen.getByRole("button", { name: "发送到终端" }));
    const pending = usePersonalStore.getState().pendingTerminalText ?? "";
    expect(pending.startsWith("\x1b[200~")).toBe(true);
    expect(pending.endsWith("\x1b[201~")).toBe(true);
    expect(pending).toContain("终端跑");
    expect(usePersonalStore.getState().terminalOpen).toBe(true);
  });

  it("ESC → 关闭", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
