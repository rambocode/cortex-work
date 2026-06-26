import { cleanup, render, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { ModePill } from "./ModePill";

function renderPill(props: Partial<Parameters<typeof ModePill>[0]> = {}) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={{} as unknown as DesktopBridge}>
      <ModePill permissionMode="accept-edits" onChange={() => {}} running={false} {...props} />
    </CoreProvider>,
  );
}

describe("ModePill(访问范围)", () => {
  afterEach(() => cleanup());

  it("渲染 4 档(可写工作区/只读文件/访问所有文件/外部沙箱)", () => {
    const { container } = renderPill();
    const sel = container.querySelector("select") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["accept-edits", "plan", "full-auto", "sandbox"]);
  });

  it("选择回调透传具体值", () => {
    const onChange = vi.fn();
    const { container } = renderPill({ onChange });
    fireEvent.change(container.querySelector("select")!, { target: { value: "sandbox" } });
    expect(onChange).toHaveBeenCalledWith("sandbox");
  });

  it("running 时禁用", () => {
    const { container } = renderPill({ running: true });
    expect((container.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
  });
});
