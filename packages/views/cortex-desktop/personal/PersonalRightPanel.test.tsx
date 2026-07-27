import { cleanup, render, fireEvent, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoreProvider, useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import {
  PersonalRightPanel,
  RP_LEFT_RESERVED,
  RP_LEFT_RESERVED_ARTIFACT,
  RP_MIN_WIDTH,
} from "./PersonalRightPanel";

const bridge = {} as unknown as DesktopBridge;
const desktopCss = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");

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

  it("切到没有当前产物的会话时关闭遗留的产物右栏", async () => {
    usePersonalStore.setState({
      sessions: [{
        id: "plain",
        title: "Plain",
        agent: "claude",
        createdAt: 1,
        updatedAt: 1,
      }],
      activeSessionId: "plain",
      rightView: "artifact",
    });
    useCortexUIStore.setState({ rightOpen: true });
    renderPanel();
    await waitFor(() =>
      expect(useCortexUIStore.getState().rightOpen).toBe(false),
    );
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

  it("拖动按「右缘-鼠标X」算宽、实时写 --rp-custom-width(不进 store),松手才提交;夹在 [MIN, 视口-保留] 内", () => {
    const { container } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    // jsdom 无布局:mock 面板矩形,模拟右缘固定在 x=900、初始宽 420(左缘 480)。
    const RIGHT_EDGE = 900;
    aside.getBoundingClientRect = () =>
      ({ right: RIGHT_EDGE, left: 480, width: 420, top: 0, bottom: 0, x: 480, y: 0, height: 0, toJSON() {} }) as DOMRect;
    // 上限按父级 .pw-upper 宽度算;正常状态至少保留左侧内容区。
    const parentWidth = 1024;
    aside.parentElement!.getBoundingClientRect = () =>
      ({ right: parentWidth, left: 0, width: parentWidth, top: 0, bottom: 0, x: 0, y: 0, height: 0, toJSON() {} }) as DOMRect;
    const max = Math.max(RP_MIN_WIDTH, parentWidth - RP_LEFT_RESERVED);
    const clamp = (w: number) => Math.min(max, Math.max(RP_MIN_WIDTH, w));

    fireEvent.mouseDown(resizer, { clientX: 480 });
    fireEvent.mouseMove(document, { clientX: 500 }); // 左缘随光标 → 宽 = 900-500
    // 拖拽中走 DOM 变量、绕过 React,store 暂不更新(避免逐帧重渲染抖动)
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${clamp(RIGHT_EDGE - 500)}px`);
    expect(usePersonalStore.getState().rightPanelWidth).toBeUndefined();

    fireEvent.mouseMove(document, { clientX: -5000 }); // 拖到极左 → 上限
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${max}px`);

    fireEvent.mouseMove(document, { clientX: 5000 }); // 拖过右缘 → 不低于 MIN
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${RP_MIN_WIDTH}px`);

    fireEvent.mouseUp(document);
    // 松手提交最终宽度到 store
    expect(usePersonalStore.getState().rightPanelWidth).toBe(RP_MIN_WIDTH);

    // 松手后继续移动不再改宽
    fireEvent.mouseMove(document, { clientX: 100 });
    expect(usePersonalStore.getState().rightPanelWidth).toBe(RP_MIN_WIDTH);
  });

  it("点击在拖拽热区内时保留按下偏移,第一帧左右拖动都不先向右跳", () => {
    usePersonalStore.setState({ rightView: "browser", rightPanelWidth: undefined });
    const { container, unmount } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    const LEFT_EDGE = 480;
    const RIGHT_EDGE = 900;
    const START_WIDTH = RIGHT_EDGE - LEFT_EDGE;
    const HOTSPOT_X = LEFT_EDGE + 4;
    aside.getBoundingClientRect = () =>
      ({ right: RIGHT_EDGE, left: LEFT_EDGE, width: START_WIDTH, top: 0, bottom: 0, x: LEFT_EDGE, y: 0, height: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseDown(resizer, { clientX: HOTSPOT_X });
    fireEvent.mouseMove(document, { clientX: HOTSPOT_X - 1 });
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${START_WIDTH + 1}px`);
    fireEvent.mouseUp(document);

    unmount();
    usePersonalStore.setState({ rightView: "browser", rightPanelWidth: undefined });
    const second = renderPanel();
    const aside2 = second.container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer2 = second.container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    aside2.getBoundingClientRect = () =>
      ({ right: RIGHT_EDGE, left: LEFT_EDGE, width: START_WIDTH, top: 0, bottom: 0, x: LEFT_EDGE, y: 0, height: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseDown(resizer2, { clientX: HOTSPOT_X });
    fireEvent.mouseMove(document, { clientX: HOTSPOT_X + 1 });
    expect(aside2.style.getPropertyValue("--rp-custom-width")).toBe(`${START_WIDTH - 1}px`);
    fireEvent.mouseUp(document);
  });

  it("即使测量左边界与鼠标相差 75px,拖拽也只按位移变化,不吸附到测量边界", () => {
    usePersonalStore.setState({ rightView: "browser", rightPanelWidth: undefined });
    const { container } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    const START_WIDTH = 420;
    const POINTER_X = 480;
    const MEASURED_LEFT = POINTER_X + 75;
    aside.getBoundingClientRect = () =>
      ({ right: MEASURED_LEFT + START_WIDTH, left: MEASURED_LEFT, width: START_WIDTH, top: 0, bottom: 0, x: MEASURED_LEFT, y: 0, height: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseDown(resizer, { clientX: POINTER_X });
    fireEvent.mouseMove(document, { clientX: POINTER_X - 1 });

    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${START_WIDTH + 1}px`);
    fireEvent.mouseUp(document);
  });

  it("当前宽度大于保留区上限时,第一帧不反向夹小导致边界向右跳", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 605 });
    try {
      usePersonalStore.setState({ rightView: "browser", rightPanelWidth: undefined });
      const { container } = renderPanel();
      const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
      const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
      const LEFT_EDGE = 480;
      const RIGHT_EDGE = 900;
      const START_WIDTH = RIGHT_EDGE - LEFT_EDGE;
      const PARENT_LEFT = 300;
      const PARENT_WIDTH = 520;
      aside.getBoundingClientRect = () =>
        ({ right: RIGHT_EDGE, left: LEFT_EDGE, width: START_WIDTH, top: 0, bottom: 0, x: LEFT_EDGE, y: 0, height: 0, toJSON() {} }) as DOMRect;
      aside.parentElement!.getBoundingClientRect = () =>
        ({ right: PARENT_LEFT + PARENT_WIDTH, left: PARENT_LEFT, width: PARENT_WIDTH, top: 0, bottom: 0, x: PARENT_LEFT, y: 0, height: 0, toJSON() {} }) as DOMRect;

      fireEvent.mouseDown(resizer, { clientX: LEFT_EDGE });
      fireEvent.mouseMove(document, { clientX: LEFT_EDGE - 1 });

      expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${START_WIDTH + 1}px`);

      fireEvent.mouseUp(document);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    }
  });

  it("只按下拖拽条或零位移移动时不写宽度,避免浏览器面板起手跳一下", () => {
    usePersonalStore.setState({ rightView: "browser", rightPanelWidth: undefined });
    const { container } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    aside.getBoundingClientRect = () =>
      ({ right: 900, left: 480, width: 420, top: 0, bottom: 0, x: 480, y: 0, height: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseDown(resizer, { clientX: 480 });
    fireEvent.mouseMove(document, { clientX: 480 });
    fireEvent.mouseUp(document);

    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe("");
    expect(usePersonalStore.getState().rightPanelWidth).toBeUndefined();
  });

  it("产物编辑器内的 webview/iframe 在拖拽期间不截获 mouseup", () => {
    expect(desktopCss).toMatch(
      /\.pw-rp-resizing\s+\.pw-artifact-editor\s+(?:webview|iframe)[^{]*\{[^}]*pointer-events:\s*none/s,
    );
  });

  // 演示文稿/设计稿的产物编辑器默认就展得很宽,中栏(会话区)必须留够宽度才不会挤成窄条。
  it("产物编辑器态拖拽给中栏保留 660px(其它视图仍是 250px)", () => {
    expect(RP_LEFT_RESERVED_ARTIFACT).toBe(660);
    usePersonalStore.setState({
      sessions: [{
        id: "s1",
        title: "S",
        agent: "claude",
        createdAt: 1,
        updatedAt: 1,
        activeArtifact: {
          kind: "slides",
          documentId: "d1",
          title: "Deck",
          workspaceRoot: "/w",
          entryPath: "/w/.cortex-slides/d1",
          createdAt: 1,
          updatedAt: 1,
        },
      }],
      activeSessionId: "s1",
      rightView: "artifact",
    });
    useCortexUIStore.setState({ rightOpen: true });
    const { container } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    aside.getBoundingClientRect = () =>
      ({ right: 900, left: 480, width: 420, top: 0, bottom: 0, x: 480, y: 0, height: 0, toJSON() {} }) as DOMRect;
    const parentWidth = 1600;
    aside.parentElement!.getBoundingClientRect = () =>
      ({ right: parentWidth, left: 0, width: parentWidth, top: 0, bottom: 0, x: 0, y: 0, height: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseDown(resizer, { clientX: 480 });
    fireEvent.mouseMove(document, { clientX: -5000 }); // 拖到极左 → 吃满上限
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${parentWidth - RP_LEFT_RESERVED_ARTIFACT}px`);
    fireEvent.mouseUp(document);
  });

  it("产物编辑器默认宽度按 660px 中栏下限算(CSS 契约)", () => {
    // 默认宽度里必须扣掉中栏下限,否则宽屏下右栏吃掉大半、会话区被压成窄条。
    expect(desktopCss).toMatch(
      /\.pw-prompts:has\(\.pw-artifact-editor\)\s*\{[^}]*width:[^;]*660px/s,
    );
  });

  it("窗口失焦时结束拖拽并移除全局监听,避免拖拽状态粘住", () => {
    const { container } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    aside.getBoundingClientRect = () =>
      ({ right: 900, left: 480, width: 420, top: 0, bottom: 0, x: 480, y: 0, height: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseDown(resizer, { clientX: 480 });
    fireEvent.mouseMove(document, { clientX: 460 });
    expect(document.body).toHaveClass("pw-rp-resizing");

    fireEvent.blur(window);
    expect(document.body).not.toHaveClass("pw-rp-resizing");
    expect(usePersonalStore.getState().rightPanelWidth).toBe(440);

    fireEvent.mouseMove(document, { clientX: 400 });
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe("440px");
  });

  it("双击拖拽条恢复自动宽度", () => {
    usePersonalStore.setState({ rightPanelWidth: 500 });
    const { container } = renderPanel();
    fireEvent.doubleClick(container.querySelector(".pw-rp-resizer")!);
    expect(usePersonalStore.getState().rightPanelWidth).toBeUndefined();
  });

  it("顶部头 × 收起面板:调用 setRightOpen(false)", () => {
    useCortexUIStore.setState({ rightOpen: true });
    renderPanel();
    fireEvent.click(screen.getByTitle("关闭面板"));
    expect(useCortexUIStore.getState().rightOpen).toBe(false);
  });
});
