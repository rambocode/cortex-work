// @vitest-environment jsdom
// 候选气泡纯组件单测（U6）：候选切换渲染当前项 + 圆点、生成中态、两类错误态引导文案。
// 仅测导出的纯组件 ReplyBubble（不触发 module 自举，因 jsdom 无 #root）。

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { ReplyBubble } from "./reply-bubble";

/** 候选构造快捷方式（多数用例不关心立场，缺省 null）。 */
const cand = (text: string, stance: "agree" | "reject" | "unsure" | null = null) => ({
  text,
  stance,
});

afterEach(() => cleanup());

describe("ReplyBubble - presenting", () => {
  it("渲染当前候选文本与对应数量圆点，当前项高亮", () => {
    const { container } = render(
      <ReplyBubble
        state={{ phase: "presenting", candidates: [cand("草稿A"), cand("草稿B"), cand("草稿C")], currentIndex: 1 }}
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
      <ReplyBubble state={{ phase: "presenting", candidates: [cand("x")], currentIndex: 0 }} onAction={onAction} />,
    );
    fireEvent.click(screen.getByLabelText("翻牌"));
    expect(onAction).toHaveBeenCalledWith({ type: "flip" });
  });

  it("点击圆点上行 select 动作", () => {
    const onAction = vi.fn();
    const { container } = render(
      <ReplyBubble
        state={{ phase: "presenting", candidates: [cand("a"), cand("b")], currentIndex: 0 }}
        onAction={onAction}
      />,
    );
    fireEvent.click(container.querySelectorAll(".rb-dot")[1]);
    expect(onAction).toHaveBeenCalledWith({ type: "select", index: 1 });
  });

  it("右上角 hover 热区关闭按钮上行 close 动作", () => {
    const onAction = vi.fn();
    const { container } = render(
      <ReplyBubble state={{ phase: "presenting", candidates: [cand("x")], currentIndex: 0 }} onAction={onAction} />,
    );
    fireEvent.click(container.querySelector(".rb-close-zone .rb-close")!);
    expect(onAction).toHaveBeenCalledWith({ type: "close" });
  });
});

describe("ReplyBubble - 立场 chip", () => {
  it("当前候选带立场时渲染对应中文 chip", () => {
    const { container } = render(
      <ReplyBubble
        state={{
          phase: "presenting",
          candidates: [cand("推荐回复"), cand("好，接了。", "agree")],
          currentIndex: 1,
        }}
        onAction={() => {}}
      />,
    );
    const chip = container.querySelector(".rb-stance");
    expect(chip?.textContent).toBe("同意");
  });

  it.each([
    ["reject", "拒绝"],
    ["unsure", "不确定"],
  ] as const)("立场 %s 映射为「%s」", (stance, label) => {
    const { container } = render(
      <ReplyBubble
        state={{ phase: "presenting", candidates: [cand("x", stance)], currentIndex: 0 }}
        onAction={() => {}}
      />,
    );
    expect(container.querySelector(".rb-stance")?.textContent).toBe(label);
  });

  it("当前候选无立场（首条推荐）不渲染 chip", () => {
    const { container } = render(
      <ReplyBubble
        state={{
          phase: "presenting",
          candidates: [cand("推荐回复"), cand("好，接了。", "agree")],
          currentIndex: 0,
        }}
        onAction={() => {}}
      />,
    );
    expect(container.querySelector(".rb-stance")).toBeNull();
  });
});

describe("ReplyBubble - generating / recording", () => {
  it("生成中显示提示胶囊且无写回/翻牌按钮", () => {
    render(<ReplyBubble state={{ phase: "generating", candidates: [], currentIndex: 0 }} onAction={() => {}} />);
    expect(screen.getByText("正在生成回复...")).toBeTruthy();
    expect(screen.queryByLabelText("翻牌")).toBeNull();
  });

  it("生成中也有关闭热区,点击上行 close(放弃本次生成)", () => {
    const onAction = vi.fn();
    const { container } = render(
      <ReplyBubble state={{ phase: "generating", candidates: [], currentIndex: 0 }} onAction={onAction} />,
    );
    fireEvent.click(container.querySelector(".rb-close-zone .rb-close")!);
    expect(onAction).toHaveBeenCalledWith({ type: "close" });
  });

  it("录音态显示聆听中占位", () => {
    render(<ReplyBubble state={{ phase: "recording", candidates: [], currentIndex: 0 }} onAction={() => {}} />);
    expect(screen.getByText("聆听中…")).toBeTruthy();
  });
});

describe("ReplyBubble - error", () => {
  it("生成模型未配置：引导去设置", () => {
    const onAction = vi.fn();
    render(
      <ReplyBubble
        state={{ phase: "error", candidates: [], currentIndex: 0, errorKind: "modelNotConfigured" }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText("尚未配置生成模型")).toBeTruthy();
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
