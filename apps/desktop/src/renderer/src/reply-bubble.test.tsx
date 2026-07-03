// @vitest-environment jsdom
// 候选气泡纯组件单测（U6）：候选切换渲染当前项 + 圆点、生成中态、两类错误态引导文案。
// 仅测导出的纯组件 ReplyBubble（不触发 module 自举，因 jsdom 无 #root）。

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { ReplyBubble } from "./reply-bubble";

afterEach(() => cleanup());

describe("ReplyBubble - presenting", () => {
  it("渲染当前候选文本与对应数量圆点，当前项高亮", () => {
    const { container } = render(
      <ReplyBubble
        state={{ phase: "presenting", candidates: ["草稿A", "草稿B", "草稿C"], currentIndex: 1 }}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText("草稿B")).toBeTruthy();
    const dots = container.querySelectorAll(".rb-dot");
    expect(dots.length).toBe(3);
    // 当前项（index 1）为高亮 dot
    expect(dots[1].classList.contains("rb-dot-on")).toBe(true);
    expect(dots[0].classList.contains("rb-dot-on")).toBe(false);
  });

  it("点击翻牌按钮上行 flip 动作", () => {
    const onAction = vi.fn();
    render(
      <ReplyBubble state={{ phase: "presenting", candidates: ["x"], currentIndex: 0 }} onAction={onAction} />,
    );
    fireEvent.click(screen.getByLabelText("翻牌"));
    expect(onAction).toHaveBeenCalledWith({ type: "flip" });
  });

  it("点击圆点上行 select 动作", () => {
    const onAction = vi.fn();
    const { container } = render(
      <ReplyBubble
        state={{ phase: "presenting", candidates: ["a", "b"], currentIndex: 0 }}
        onAction={onAction}
      />,
    );
    fireEvent.click(container.querySelectorAll(".rb-dot")[1]);
    expect(onAction).toHaveBeenCalledWith({ type: "select", index: 1 });
  });
});

describe("ReplyBubble - generating / recording", () => {
  it("生成中显示提示胶囊且无写回/翻牌按钮", () => {
    render(<ReplyBubble state={{ phase: "generating", candidates: [], currentIndex: 0 }} onAction={() => {}} />);
    expect(screen.getByText("正在生成回复...")).toBeTruthy();
    expect(screen.queryByLabelText("翻牌")).toBeNull();
  });

  it("录音态显示聆听中占位", () => {
    render(<ReplyBubble state={{ phase: "recording", candidates: [], currentIndex: 0 }} onAction={() => {}} />);
    expect(screen.getByText("聆听中…")).toBeTruthy();
  });
});

describe("ReplyBubble - error", () => {
  it("默认 agent 未配置：引导去设置", () => {
    const onAction = vi.fn();
    render(
      <ReplyBubble
        state={{ phase: "error", candidates: [], currentIndex: 0, errorKind: "agentNotConfigured" }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText("尚未配置默认 Agent")).toBeTruthy();
    fireEvent.click(screen.getByText("去设置"));
    expect(onAction).toHaveBeenCalledWith({ type: "openSettings" });
  });

  it("生成失败：显示原因 + 重试/关闭", () => {
    const onAction = vi.fn();
    render(
      <ReplyBubble
        state={{
          phase: "error",
          candidates: [],
          currentIndex: 0,
          errorKind: "generationFailed",
          errorDetail: "网络错误",
        }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText("生成失败")).toBeTruthy();
    expect(screen.getByText("网络错误")).toBeTruthy();
    fireEvent.click(screen.getByText("重试"));
    expect(onAction).toHaveBeenCalledWith({ type: "retry" });
  });

  it("空候选：专属标题 + 重试", () => {
    render(
      <ReplyBubble
        state={{ phase: "error", candidates: [], currentIndex: 0, errorKind: "emptyCandidates" }}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText("未能生成候选")).toBeTruthy();
  });
});
