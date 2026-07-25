import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { describeEgress } from "@cortex-work/core/research/model-policy";
import { ResearchPolicyNotice } from "./ResearchPolicyNotice";

afterEach(() => cleanup());

describe("ResearchPolicyNotice", () => {
  it("三种策略都渲染 core 给出的 summaryZh（文案单一真源在 describeEgress）", () => {
    for (const policy of ["local_only", "metadata_only", "evidence_allowed"] as const) {
      const { unmount } = render(<ResearchPolicyNotice policy={policy} />);
      expect(screen.getByText(describeEgress(policy).summaryZh)).toBeTruthy();
      unmount();
    }
  });

  it("local_only：明确标注「不离开本机」", () => {
    render(<ResearchPolicyNotice policy="local_only" />);
    expect(screen.getByText("数据不会离开本机")).toBeTruthy();
  });

  it("metadata_only：标注正文不出站、元数据出站", () => {
    render(<ResearchPolicyNotice policy="metadata_only" />);
    expect(screen.getByText("正文不会发给模型")).toBeTruthy();
    expect(screen.getByText("会发送标题、摘要、域名等元数据")).toBeTruthy();
  });

  it("evidence_allowed：给出供应商名称，让用户知道收件方是谁", () => {
    render(<ResearchPolicyNotice policy="evidence_allowed" providerLabel="OpenRouter" />);
    expect(screen.getByText("将发送给：OpenRouter")).toBeTruthy();
  });

  it("已确认过同一策略时不再展示（首次使用或策略变化才提示）", () => {
    const { container } = render(
      <ResearchPolicyNotice policy="metadata_only" acknowledgedPolicy="metadata_only" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("策略与已确认值不同则重新展示，点击「我知道了」回传当前策略", () => {
    const acked: string[] = [];
    render(
      <ResearchPolicyNotice
        policy="evidence_allowed"
        acknowledgedPolicy="local_only"
        onAcknowledge={(p) => acked.push(p)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "我知道了" }));
    expect(acked).toEqual(["evidence_allowed"]);
  });

  it("未提供 onAcknowledge 时不渲染确认按钮（纯告知模式，例如嵌在新建表单里）", () => {
    render(<ResearchPolicyNotice policy="local_only" />);
    expect(screen.queryByRole("button", { name: "我知道了" })).toBeNull();
  });
});
