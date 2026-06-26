import { cleanup, render, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { ApprovalPill } from "./ApprovalPill";

function renderPill(props: Partial<Parameters<typeof ApprovalPill>[0]> = {}) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={{} as unknown as DesktopBridge}>
      <ApprovalPill approvalPolicy="auto" onChange={() => {}} running={false} agent="pi" {...props} />
    </CoreProvider>,
  );
}

describe("ApprovalPill(执行/审批)", () => {
  afterEach(() => cleanup());

  it("渲染 2 档(自动执行/询问后执行)", () => {
    const { container } = renderPill();
    const sel = container.querySelector("select") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["auto", "ask"]);
  });

  it("选择回调透传", () => {
    const onChange = vi.fn();
    const { container } = renderPill({ onChange });
    fireEvent.change(container.querySelector("select")!, { target: { value: "ask" } });
    expect(onChange).toHaveBeenCalledWith("ask");
  });

  it("非 pi + ask:pill 标降级(data-warn)", () => {
    const { container } = renderPill({ agent: "claude", approvalPolicy: "ask" });
    expect(container.querySelector('[data-warn="1"]')).not.toBeNull();
  });

  it("pi + ask:不降级", () => {
    const { container } = renderPill({ agent: "pi", approvalPolicy: "ask" });
    expect(container.querySelector('[data-warn="1"]')).toBeNull();
  });

  it("running 时禁用", () => {
    const { container } = renderPill({ running: true });
    expect((container.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
  });
});
