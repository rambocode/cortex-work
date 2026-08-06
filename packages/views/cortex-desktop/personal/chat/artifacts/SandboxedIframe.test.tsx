// SandboxedIframe 组件测试。最重要的一条是 sandbox 属性的**精确**断言——它是逃逸红线的
// 结构性锁（谁想加 allow-same-origin,这里先红）。

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PI_SANDBOX_ATTR, SandboxedIframe } from "./SandboxedIframe";

describe("SandboxedIframe", () => {
  it("sandbox 属性精确等于 allow-scripts allow-modals(无 allow-same-origin/popups/top-navigation)", () => {
    render(<SandboxedIframe sandboxId="sb" mode="html" code="<div/>" version={1} title="t" />);
    const iframe = screen.getByTitle("t");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-modals");
    expect(PI_SANDBOX_ATTR).not.toContain("allow-same-origin");
  });

  it("version 变化触发重挂(key 变 → 新 iframe 节点)", () => {
    const { rerender } = render(<SandboxedIframe sandboxId="sb" mode="html" code="<div/>" version={1} title="t" />);
    const first = screen.getByTitle("t");
    rerender(<SandboxedIframe sandboxId="sb" mode="html" code="<div>v2</div>" version={2} title="t" />);
    const second = screen.getByTitle("t");
    expect(second).not.toBe(first);
    expect(second.getAttribute("srcdoc")).toContain("v2");
  });
});
