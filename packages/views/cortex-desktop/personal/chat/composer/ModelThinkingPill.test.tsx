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

// 一级行(Agent / 模型 / 推理):按包含文本找。
function row(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".pw-mt-menu .pw-mt-row")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`找不到「${text}」行`);
  return found;
}

// 二级 flyout 里的选项(作用域限定 .pw-mt-sub,避免和一级行上的当前值文本撞车)。
function subItem(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".pw-mt-sub .pw-tb-menu-item")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`二级菜单里找不到「${text}」`);
  return found;
}

describe("ModelThinkingPill(agent+模型+推理 单 pill 悬停二级菜单)", () => {
  afterEach(() => cleanup());

  it("触发器显示模型 + 推理短标签;无 agent props 时用 lightning 图标、无头像", () => {
    const { container } = renderPill();
    const trigger = container.querySelector(".pw-mt-trigger")!;
    expect(trigger.textContent).toContain("Sonnet");
    expect(trigger.textContent).toContain("中"); // medium 短标签
    expect(trigger.querySelector(".pw-mt-avatar")).toBeNull();
    expect(trigger.querySelector(".lightning")).not.toBeNull();
  });

  it("悬停「推理」行展开二级单选(不点击),选「高」触发 onChangeThinking 并关菜单", () => {
    const onChangeThinking = vi.fn();
    const { container } = renderPill({ onChangeThinking });
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    // 未悬停时无二级 flyout、根层不内联推理选项。
    expect(container.querySelector(".pw-mt-sub")).toBeNull();
    fireEvent.mouseEnter(row(container, "推理"));
    const sub = container.querySelector(".pw-mt-sub");
    expect(sub).not.toBeNull();
    fireEvent.click(subItem(container, "高"));
    expect(onChangeThinking).toHaveBeenCalledWith("high");
    // 选中后整个菜单关闭,下次打开不残留 flyout。
    expect(container.querySelector(".pw-mt-menu")).toBeNull();
  });

  it("悬停「模型」行展开模型列表(✓ 当前),选中触发 onChangeModel", () => {
    const onChangeModel = vi.fn();
    const { container } = renderPill({ onChangeModel });
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.mouseEnter(row(container, "模型"));
    const opts = [...container.querySelectorAll(".pw-mt-sub .pw-mt-models .pw-tb-menu-item")];
    expect(opts.map((b) => b.textContent?.replace(/\s/g, ""))).toEqual(
      expect.arrayContaining(["Sonnet", "Opus"]),
    );
    fireEvent.click(subItem(container, "Opus"));
    expect(onChangeModel).toHaveBeenCalledWith("opus");
  });

  it("行间移动:悬停另一行即切换二级 flyout", () => {
    const { container } = renderPill();
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.mouseEnter(row(container, "模型"));
    expect(container.querySelector(".pw-mt-sub .pw-mt-models")).not.toBeNull();
    fireEvent.mouseEnter(row(container, "推理"));
    expect(container.querySelector(".pw-mt-sub .pw-mt-models")).toBeNull();
    expect(subItem(container, "高")).toBeTruthy();
  });

  it("二级 flyout 默认右侧(jsdom 视口无溢出 → 不翻左)", () => {
    const { container } = renderPill();
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.mouseEnter(row(container, "模型"));
    expect(container.querySelector(".pw-mt-sub")).not.toBeNull();
    // jsdom 的 getBoundingClientRect 全 0,右侧不溢出 → 保持默认右侧,不带翻左类。
    expect(container.querySelector(".pw-mt-sub--left")).toBeNull();
  });

  it("右侧空间不足时二级 flyout 自动翻到左侧", () => {
    // jsdom innerWidth 默认 1024;让 flyout 右缘超出视口 → 应翻左。
    const rect = {
      right: 2000, left: 1800, top: 0, bottom: 100, width: 200, height: 100, x: 1800, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
    try {
      const { container } = renderPill();
      fireEvent.click(container.querySelector(".pw-mt-trigger")!);
      fireEvent.mouseEnter(row(container, "模型"));
      expect(container.querySelector(".pw-mt-sub--left")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("菜单默认下弹;底部空间不足(历史会话页贴底)自动翻上", () => {
    // jsdom innerHeight 默认 768;让菜单底缘超出视口 → 应翻上。
    const rect = {
      right: 100, left: 0, top: 700, bottom: 2000, width: 200, height: 1300, x: 0, y: 700,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
    try {
      const { container } = renderPill();
      fireEvent.click(container.querySelector(".pw-mt-trigger")!);
      expect(container.querySelector(".pw-mt-menu.pw-tb-menu--up")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("pi:模型列表用 provider::model 选项,回调拆分", () => {
    const onChangePiModel = vi.fn();
    const { container } = renderPill({
      isPi: true,
      piModelOptions: [{ value: "prov::m1", label: "Prov · M1" }],
      piModelValue: "prov::m1",
      onChangePiModel,
    });
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.mouseEnter(row(container, "模型"));
    fireEvent.click(container.querySelector(".pw-mt-sub .pw-mt-models .pw-tb-menu-item")!);
    expect(onChangePiModel).toHaveBeenCalledWith("prov", "m1");
  });

  it("agent props:触发器含头像,悬停 Agent 行展开列表,点派生项触发 onSwitchAgent", () => {
    const onSwitchAgent = vi.fn();
    const { container } = renderPill({
      agent: "claude",
      agentsAvailable: { claude: true, codex: true },
      derivedAgents: [{ id: "my-cx", base: "codex", label: "我的CX" }],
      onSwitchAgent,
    });
    const trigger = container.querySelector(".pw-mt-trigger")!;
    // 头像替代 lightning 图标。
    expect(trigger.querySelector(".pw-mt-avatar")).not.toBeNull();
    expect(trigger.querySelector(".lightning")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.mouseEnter(row(container, "Agent"));
    // agent 二级:内置三项 + 新派生。
    expect(subItem(container, "Claude Code")).toBeTruthy();
    expect(subItem(container, "Codex")).toBeTruthy();
    expect(subItem(container, "Cortex")).toBeTruthy();
    fireEvent.click(subItem(container, "我的CX"));
    expect(onSwitchAgent).toHaveBeenCalledWith("codex", { id: "my-cx", base: "codex", label: "我的CX" });
  });

  it("agent 二级:未安装的内置 agent 禁用并标注(与 AgentSelect 同规则)", () => {
    const { container } = renderPill({
      agent: "pi",
      agentsAvailable: { claude: false, codex: true },
      derivedAgents: [],
      onSwitchAgent: () => {},
    });
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    fireEvent.mouseEnter(row(container, "Agent"));
    const claude = subItem(container, "Claude Code");
    expect(claude.disabled).toBe(true);
    expect(claude.textContent).toContain("未安装");
  });
});
