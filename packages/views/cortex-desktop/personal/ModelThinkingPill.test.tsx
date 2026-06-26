import { cleanup, render, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { ModelThinkingPill } from "./ModelThinkingPill";

const models = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];
const thinkingOptions = [
  { value: "default" as const, labelKey: "composer.thinkingLevel.default" },
  { value: "low" as const, labelKey: "composer.thinkingLevel.low" },
  { value: "medium" as const, labelKey: "composer.thinkingLevel.medium" },
  { value: "high" as const, labelKey: "composer.thinkingLevel.high" },
];

function renderPill(props: Partial<Parameters<typeof ModelThinkingPill>[0]> = {}) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={{} as unknown as DesktopBridge}>
      <ModelThinkingPill
        isPi={false}
        models={models}
        model="sonnet"
        onChangeModel={() => {}}
        piModelOptions={[]}
        piModelValue="::"
        onChangePiModel={() => {}}
        thinkingOptions={thinkingOptions}
        resolvedThinkingValue="medium"
        onChangeThinking={() => {}}
        {...props}
      />
    </CoreProvider>,
  );
}

describe("ModelThinkingPill(模型+推理合并)", () => {
  afterEach(() => cleanup());

  it("触发器显示模型 + 推理短标签", () => {
    const { container } = renderPill();
    const trigger = container.querySelector(".pw-mt-trigger")!;
    expect(trigger.textContent).toContain("Sonnet");
    expect(trigger.textContent).toContain("中"); // medium 短标签
  });

  it("点击打开:含推理分区 + 模型行;子菜单列出模型(✓ 当前)", () => {
    const { container } = renderPill();
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    expect(container.querySelector(".pw-mt-menu")).not.toBeNull();
    // 推理选项「高」可见。
    expect([...container.querySelectorAll(".pw-mt-menu .pw-tb-menu-item")].some((b) => b.textContent?.trim() === "高")).toBe(true);
    // 打开模型子菜单。
    fireEvent.click(container.querySelector(".pw-submenu-wrap > button")!);
    const opts = [...container.querySelectorAll(".pw-mt-submenu .pw-tb-menu-item")];
    expect(opts.map((b) => b.textContent?.replace(/\s/g, ""))).toEqual(expect.arrayContaining(["Sonnet", "Opus"]));
  });

  it("选推理 → onChangeThinking;选模型 → onChangeModel", () => {
    const onChangeThinking = vi.fn();
    const onChangeModel = vi.fn();
    const { container } = renderPill({ onChangeThinking, onChangeModel });
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    const high = [...container.querySelectorAll(".pw-mt-menu .pw-tb-menu-item")].find((b) => b.textContent?.trim() === "高")!;
    fireEvent.click(high);
    expect(onChangeThinking).toHaveBeenCalledWith("high");

    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.click(container.querySelector(".pw-submenu-wrap > button")!);
    const opus = [...container.querySelectorAll(".pw-mt-submenu .pw-tb-menu-item")].find((b) => b.textContent?.includes("Opus"))!;
    fireEvent.click(opus);
    expect(onChangeModel).toHaveBeenCalledWith("opus");
  });

  it("pi:子菜单用 provider::model 选项,回调拆分", () => {
    const onChangePiModel = vi.fn();
    const { container } = renderPill({
      isPi: true,
      piModelOptions: [{ value: "prov::m1", label: "Prov · M1" }],
      piModelValue: "prov::m1",
      onChangePiModel,
    });
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.click(container.querySelector(".pw-submenu-wrap > button")!);
    fireEvent.click(container.querySelector(".pw-mt-submenu .pw-tb-menu-item")!);
    expect(onChangePiModel).toHaveBeenCalledWith("prov", "m1");
  });
});
