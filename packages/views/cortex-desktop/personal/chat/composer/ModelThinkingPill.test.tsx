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

  // 一级面板默认与 pill 左缘对齐向右展开;写作助手栏只有 ~370px 宽且 pill 贴右，
  // 200px 的面板会被推出窗口右缘（用户实测反馈），故同样要能翻成右对齐。
  it("一级面板默认左对齐(视口无溢出 → 不翻右)", () => {
    const { container } = renderPill();
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    expect(container.querySelector(".pw-mt-menu")).not.toBeNull();
    expect(container.querySelector(".pw-mt-menu--right")).toBeNull();
  });

  it("右侧空间不足时一级面板翻成右对齐", () => {
    const rect = {
      right: 2000, left: 1800, top: 0, bottom: 100, width: 200, height: 100, x: 1800, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
    try {
      const { container } = renderPill();
      fireEvent.click(container.querySelector(".pw-mt-trigger")!);
      expect(container.querySelector(".pw-mt-menu--right")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // 翻转的前提是「另一侧空间够」。窄栏里两侧都不够时（写作助手栏 ~370px + 长模型名把
  // flyout 撑到 230px+），翻完照样漏出窗口——这是用户反复反馈「模型选择右侧显示不全」的根因。
  // useOverflowSafePlacement 在翻转后再测一次，仍越界就用 translate 把浮层钳回视口内。
  it("两侧都放不下时把 flyout 钳回视口内(translate 兜底)", () => {
    // 恒定返回越界矩形:翻转后再测仍越界 → 触发钳制。
    const rect = {
      right: 1200, left: 970, top: 0, bottom: 100, width: 230, height: 100, x: 970, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
    try {
      const { container } = renderPill();
      fireEvent.click(container.querySelector(".pw-mt-trigger")!);
      fireEvent.mouseEnter(row(container, "模型"));
      const sub = container.querySelector(".pw-mt-sub") as HTMLElement;
      // jsdom innerWidth 1024:right=1200 越界 176px,需要左移到 1024-8 → translateX 为负。
      expect(sub.style.transform).toMatch(/translate\(-\d+(\.\d+)?px/);
    } finally {
      spy.mockRestore();
    }
  });

  // 回归:曾把钳制位移写成累加,且测量的是「已带 transform」的位置 —— 翻转（下弹→上弹）
  // 后旧位移仍挂着,两者叠加把一级面板从 pill 上方一路顶到屏幕中部。
  // 现在改为「摘掉 transform 量原始位置 + 覆盖而非累加」,不越界时必须是零位移。
  it("翻转后重算位移而非叠加(回归:面板漂移到屏幕中部)", () => {
    // 关键是让矩形**随翻转状态变化**：未翻转时底部越界（促成翻上），翻上之后完全在视口内。
    // 旧实现在翻转前算出一个上移量、翻转后又不覆盖它，两者叠加就把面板顶到了屏幕中部。
    const belowViewport = {
      right: 500, left: 270, top: 700, bottom: 900, width: 230, height: 200, x: 270, y: 700,
      toJSON: () => ({}),
    } as DOMRect;
    const inView = {
      right: 500, left: 270, top: 100, bottom: 300, width: 230, height: 200, x: 270, y: 100,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return (this.classList?.contains("pw-tb-menu--up") ? inView : belowViewport) as DOMRect;
      });
    try {
      const { container } = renderPill();
      fireEvent.click(container.querySelector(".pw-mt-trigger")!);
      const menu = container.querySelector(".pw-mt-menu") as HTMLElement;
      // 已翻上 → 翻上后的位置本身就在视口内 → 不该再有任何补偿位移。
      expect(menu.className).toContain("pw-tb-menu--up");
      expect(menu.style.transform).toBe("");
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
