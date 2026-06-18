// FollowupOverlay（U4）组件测试。mock @cortex-work/core 的 useFollowupAsk 返回受控
// turns/running/ask/cancel,专注测组件渲染与交互(R2/R3/R4/R8/R5 + 键位/焦点)。

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FollowupSeed,
  FollowupSessionCtx,
  Turn,
  UseFollowupAsk,
} from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";

// 受控 hook 返回值,测试逐项替换。
const askSpy = vi.fn();
const cancelSpy = vi.fn();
const resetSpy = vi.fn();
let hookState: { turns: Turn[]; running: boolean } = { turns: [], running: false };

vi.mock("@cortex-work/core", () => ({
  useFollowupAsk: (_seed: FollowupSeed, _ctx: FollowupSessionCtx): UseFollowupAsk => ({
    turns: hookState.turns,
    running: hookState.running,
    ask: askSpy,
    cancel: cancelSpy,
    reset: resetSpy,
  }),
}));

// 在 mock 之后再 import 被测组件。
import { FollowupOverlay } from "./FollowupOverlay";

const seed: FollowupSeed = { text: "这是被追问的那条 assistant 回复正文。" };
const ctxClaude: FollowupSessionCtx = { agent: "claude", cwd: "/p" };
const ctxCodex: FollowupSessionCtx = { agent: "codex", cwd: "/p" };

function textMsg(text: string): Message {
  return { kind: "text", who: "claude-agent", time: "10:00", text, uid: `t-${Math.random()}` };
}

function setHook(turns: Turn[], running: boolean) {
  hookState = { turns, running };
}

afterEach(() => {
  cleanup();
  askSpy.mockReset();
  cancelSpy.mockReset();
  resetSpy.mockReset();
  setHook([], false);
});

describe("FollowupOverlay（U4）", () => {
  it("打开 → 顶部种子正文 + 空态引导 + 焦点在 textarea", () => {
    setHook([], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    expect(screen.getByText(/被追问的那条 assistant 回复正文/)).toBeInTheDocument();
    expect(screen.getByText(/关闭即丢弃/)).toBeInTheDocument();
    const ta = screen.getByRole("textbox");
    expect(document.activeElement).toBe(ta);
  });

  it("发送一问(claude)→ 流式区渲染应答 + 逐字光标(无「生成中」)", () => {
    const turn: Turn = { id: "a1", question: "为什么?", status: "streaming", messages: [textMsg("因为如此")] };
    setHook([turn], true);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    expect(screen.getByText("为什么?")).toBeInTheDocument();
    expect(screen.getByText("因为如此")).toBeInTheDocument();
    expect(screen.queryByText(/生成中/)).toBeNull();
  });

  it("codex 流式空内容 → 显示「生成中…」占位而非逐字光标", () => {
    const turn: Turn = { id: "a1", question: "为什么?", status: "streaming", messages: [] };
    setHook([turn], true);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxCodex} onClose={() => {}} />);
    expect(screen.getByText(/生成中/)).toBeInTheDocument();
  });

  it("连续两问 → 两轮渲染", () => {
    const t1: Turn = { id: "a1", question: "问题一", status: "done", messages: [textMsg("回答一")] };
    const t2: Turn = { id: "a2", question: "问题二", status: "done", messages: [textMsg("回答二")] };
    setHook([t1, t2], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    expect(screen.getByText("问题一")).toBeInTheDocument();
    expect(screen.getByText("回答一")).toBeInTheDocument();
    expect(screen.getByText("问题二")).toBeInTheDocument();
    expect(screen.getByText("回答二")).toBeInTheDocument();
  });

  it("error 轮 → 错误文案 + 重试入口;点重试对同一 question 再 ask", () => {
    const turn: Turn = { id: "a1", question: "重试我", status: "error", messages: [], error: "执行出错: boom" };
    setHook([turn], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    expect(screen.getByText("执行出错: boom")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(askSpy).toHaveBeenCalledWith("重试我");
    // 输入恢复可用(非 running)。
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });

  it("cancelled 轮 → 标注「已取消」", () => {
    const turn: Turn = { id: "a1", question: "停掉", status: "cancelled", messages: [textMsg("半句")] };
    setHook([turn], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });

  it("键位:Enter 发送、Shift+Enter 换行不发送", () => {
    setHook([], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "你好" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(askSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(askSpy).toHaveBeenCalledWith("你好");
  });

  it("running 时输入与发送禁用,改显「停止」", () => {
    const turn: Turn = { id: "a1", question: "q", status: "streaming", messages: [] };
    setHook([turn], true);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    const stop = screen.getByRole("button", { name: /停止/ });
    fireEvent.click(stop);
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("背景点击 → cancel + onClose", () => {
    const onClose = vi.fn();
    setHook([], false);
    const { container } = render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={onClose} />);
    fireEvent.click(container.querySelector(".pw-dlg-overlay")!);
    expect(cancelSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("ESC → cancel + onClose", () => {
    const onClose = vi.fn();
    setHook([], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("点击对话框内部不冒泡触发关闭", () => {
    const onClose = vi.fn();
    setHook([], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("超长种子 → 默认折叠 + 展开/收起切换", () => {
    const longSeed: FollowupSeed = { text: "甲".repeat(400) };
    setHook([], false);
    render(<FollowupOverlay seed={longSeed} sessionCtx={ctxClaude} onClose={() => {}} />);
    const toggle = screen.getByRole("button", { name: "展开" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("关闭按钮 → cancel + onClose", () => {
    const onClose = vi.fn();
    setHook([], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(cancelSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("发送后清空草稿", () => {
    setHook([], false);
    render(<FollowupOverlay seed={seed} sessionCtx={ctxClaude} onClose={() => {}} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "问一句" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("");
  });
});
