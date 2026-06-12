import { cleanup, render, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { PersonalRightPanel, RP_CENTER_RESERVED, RP_MIN_WIDTH } from "./PersonalRightPanel";

const bridge = {} as unknown as DesktopBridge;

function renderPanel() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PersonalRightPanel onToast={() => {}} />
    </CoreProvider>,
  );
}

describe("PersonalRightPanel 拖拽调宽", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: true,
      projects: [],
      sessions: [],
      todos: [],
      rightView: "todos",
      rightPanelWidth: undefined,
    });
  });

  it("自定义宽度以 --rp-custom-width 变量注入(只作用于详情态档位);未设置时无变量", () => {
    const { container, rerender } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe("");
    // 列表态不设 inline width,固定宽度交给 CSS
    expect(aside.style.width).toBe("");

    usePersonalStore.setState({ rightPanelWidth: 420 });
    rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <PersonalRightPanel onToast={() => {}} />
      </CoreProvider>,
    );
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe("420px");
    expect(aside.style.width).toBe("");
  });

  it("拖动改写 store 宽度,向左拖增宽并夹在 [MIN, 容器宽-保留宽] 内", () => {
    const { container } = renderPanel();
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    // jsdom 元素无实际尺寸:起始宽回退 RP_MIN_WIDTH,容器宽回退 window.innerWidth
    const max = Math.max(RP_MIN_WIDTH, window.innerWidth - RP_CENTER_RESERVED);
    const clamp = (w: number) => Math.min(max, Math.max(RP_MIN_WIDTH, w));

    fireEvent.mouseDown(resizer, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 500 }); // 向左 100px
    expect(usePersonalStore.getState().rightPanelWidth).toBe(clamp(RP_MIN_WIDTH + 100));

    fireEvent.mouseMove(document, { clientX: -5000 }); // 向左拖到底 → 上限
    expect(usePersonalStore.getState().rightPanelWidth).toBe(max);

    fireEvent.mouseMove(document, { clientX: 900 }); // 远超右边界 → 不低于 MIN
    expect(usePersonalStore.getState().rightPanelWidth).toBe(RP_MIN_WIDTH);
    fireEvent.mouseUp(document);

    // 松手后继续移动不再改宽
    fireEvent.mouseMove(document, { clientX: 100 });
    expect(usePersonalStore.getState().rightPanelWidth).toBe(RP_MIN_WIDTH);
  });

  it("双击拖拽条恢复自动宽度", () => {
    usePersonalStore.setState({ rightPanelWidth: 500 });
    const { container } = renderPanel();
    fireEvent.doubleClick(container.querySelector(".pw-rp-resizer")!);
    expect(usePersonalStore.getState().rightPanelWidth).toBeUndefined();
  });
});
