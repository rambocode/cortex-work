import { cleanup, render, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { ModePill } from "./ModePill";

function renderPill(props: Partial<Parameters<typeof ModePill>[0]> = {}) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={{} as unknown as DesktopBridge}>
      <ModePill permissionMode="plan" onChange={() => {}} running={false} {...props} />
    </CoreProvider>,
  );
}

describe("ModePill", () => {
  afterEach(() => cleanup());

  it("渲染 4 档(plan/accept-edits/auto/full-auto)", () => {
    const { container } = renderPill();
    const sel = container.querySelector("select") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["plan", "accept-edits", "full-auto", "auto"]);
  });

  it("选择回调透传具体值", () => {
    const onChange = vi.fn();
    const { container } = renderPill({ onChange });
    fireEvent.change(container.querySelector("select")!, { target: { value: "auto" } });
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("running 时禁用", () => {
    const { container } = renderPill({ running: true });
    expect((container.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
  });

  it("auto + resolvedMode → 选中项附显「→ 具体档」(KTD7)", () => {
    const { container } = renderPill({ permissionMode: "auto", resolvedMode: "accept-edits" });
    const sel = container.querySelector("select") as HTMLSelectElement;
    const autoOpt = [...sel.options].find((o) => o.value === "auto")!;
    expect(autoOpt.textContent).toContain("→");
  });
});
