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
      activeSessionId: undefined,
      todos: [],
      rightView: "todos",
      rightPanelWidth: undefined,
    });
  });

  it("画板没有当前会话时显示专用空态，不回退到 Skills 库", async () => {
    usePersonalStore.setState({ rightView: "canvas", activeSessionId: undefined });
    useCortexUIStore.setState({ rightOpen: true });

    renderPanel();

    // 面板主体经 React.lazy 懒加载,首帧是 Suspense 空窗 → findBy 等 chunk 解析完成。
    // 全量套件并行跑时 chunk 转译可能超过默认 1s,放宽超时防负载抖动。
    expect(await screen.findByText("请先选择会话", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText("Skills 库")).not.toBeInTheDocument();
  });

  it("子代理侧栏使用 Kun 同款标题层级", () => {
    usePersonalStore.setState({ rightView: "subagents" });
    useCortexUIStore.setState({ rightOpen: true });

    const { container } = renderPanel();
    const head = container.querySelector(".pw-rp-head.is-subagents");

    expect(head?.querySelector(".pw-col-head-title")?.textContent).toBe("子代理");
    expect(head?.querySelector(".pw-rp-head-subtitle")?.textContent).toBe("· 配置模型");
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

  // ── 深度研究面板（/skill:research 的右栏视图）──────────────────────────────
  // 与产物面板同构：同为右栏视图、同为 660px 中栏保留宽度、同样在失去绑定时自动收起。

  it("会话绑定了研究时渲染研究面板，标题是「深度研究」", async () => {
    usePersonalStore.setState({
      sessions: [{
        id: "s1",
        title: "S",
        agent: "claude",
        createdAt: 1,
        updatedAt: 1,
        researchSessions: [{ sessionId: "r1", objective: "调查 A", createdAt: 1 }],
        activeResearchSessionId: "r1",
      }],
      activeSessionId: "s1",
      rightView: "research",
    });
    useCortexUIStore.setState({ rightOpen: true });
    const { container } = renderPanel();
    // 面板主体懒加载:等 chunk 解析后 .pw-research-panel 才出现;头部是宿主 chrome,同步可断。
    // 超时同上放宽,防全量套件并行负载下的转译抖动。
    await waitFor(() => expect(container.querySelector(".pw-research-panel")).not.toBeNull(), {
      timeout: 5000,
    });
    expect(container.querySelector(".pw-col-head-title")?.textContent).toBe("深度研究");
  });

  it("切到没有研究绑定的会话时自动收起右栏（不留一个空壳面板）", async () => {
    usePersonalStore.setState({
      sessions: [{ id: "plain", title: "Plain", agent: "claude", createdAt: 1, updatedAt: 1 }],
      activeSessionId: "plain",
      rightView: "research",
    });
    useCortexUIStore.setState({ rightOpen: true });
    renderPanel();
    await waitFor(() => expect(useCortexUIStore.getState().rightOpen).toBe(false));
  });

  it("研究面板态拖拽同样给中栏保留 660px（与产物编辑器同档）", () => {
    usePersonalStore.setState({
      sessions: [{
        id: "s1",
        title: "S",
        agent: "claude",
        createdAt: 1,
        updatedAt: 1,
        researchSessions: [{ sessionId: "r1", objective: "调查 A", createdAt: 1 }],
        activeResearchSessionId: "r1",
      }],
      activeSessionId: "s1",
      rightView: "research",
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

  it("研究面板默认宽度按 660px 中栏下限算(CSS 契约,与产物编辑器同一条公式)", () => {
    expect(desktopCss).toMatch(
      /\.pw-prompts:has\(\.pw-research-panel\)\s*\{[^}]*width:[^;]*660px/s,
    );
  });

  // ── 知识库文档面板（点会话里的 kb:// 引用打开）───────────────────────────
  // 与研究面板同档：文档常含宽表格，320px 窄栏读不了，故同样向左展开并可放大。

  it("知识库面板态拖拽同样给中栏保留 660px（与产物 / 研究同档）", () => {
    usePersonalStore.setState({ rightView: "knowledge" });
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
    fireEvent.mouseMove(document, { clientX: -5000 });
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${parentWidth - RP_LEFT_RESERVED_ARTIFACT}px`);
    fireEvent.mouseUp(document);
  });

  it("知识库面板默认宽度按 660px 中栏下限算(CSS 契约,与研究面板同一条公式)", () => {
    expect(desktopCss).toMatch(/\.pw-prompts:has\(\.pw-kbdoc\)\s*\{[^}]*width:[^;]*660px/s);
    // 拖拽条也要在这一档出现，否则「向左展开」后无法再手动调宽。
    expect(desktopCss).toMatch(/\.pw-prompts:has\(\.pw-kbdoc\)\s+\.pw-rp-resizer\s*\{[^}]*display:\s*block/s);
  });

  it("知识库面板顶部有放大/还原按钮,点击切换 is-maximized", () => {
    usePersonalStore.setState({ rightView: "knowledge", rightPanelMaximized: false });
    useCortexUIStore.setState({ rightOpen: true });
    const { container } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    expect(aside.classList.contains("is-maximized")).toBe(false);
    fireEvent.click(screen.getByTitle("放大面板"));
    expect(aside.classList.contains("is-maximized")).toBe(true);
    fireEvent.click(screen.getByTitle("还原面板"));
    expect(aside.classList.contains("is-maximized")).toBe(false);
  });

  // 放大态是「盖住中栏」的强状态，切到窄面板还留着会让用户以为会话没了。
  it("从知识库切到窄面板(文件)时自动退出放大态", async () => {
    usePersonalStore.setState({ rightView: "knowledge", rightPanelMaximized: true });
    useCortexUIStore.setState({ rightOpen: true });
    const { rerender } = renderPanel();
    expect(usePersonalStore.getState().rightPanelMaximized).toBe(true);
    usePersonalStore.setState({ rightView: "files" });
    rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <PersonalRightPanel onToast={() => {}} />
      </CoreProvider>,
    );
    await waitFor(() => expect(usePersonalStore.getState().rightPanelMaximized).toBe(false));
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

  it("文件预览拖到最宽时仍给中栏保留 660px(与产物面板同档)", () => {
    usePersonalStore.setState({ rightView: "files" });
    const { container } = renderPanel();
    const aside = container.querySelector<HTMLElement>("aside.pw-prompts")!;
    const resizer = container.querySelector<HTMLElement>(".pw-rp-resizer")!;
    aside.getBoundingClientRect = () =>
      ({ right: 900, left: 480, width: 420, top: 0, bottom: 0, x: 480, y: 0, height: 0, toJSON() {} }) as DOMRect;
    aside.parentElement!.getBoundingClientRect = () =>
      ({ right: 1600, left: 0, width: 1600, top: 0, bottom: 0, x: 0, y: 0, height: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseDown(resizer, { clientX: 480 });
    fireEvent.mouseMove(document, { clientX: -5000 });

    // 宽度上限 = 宿主宽度 - 中栏保留 660px(RP_LEFT_RESERVED_ARTIFACT,files 同档)。
    expect(aside.style.getPropertyValue("--rp-custom-width")).toBe(`${1600 - RP_LEFT_RESERVED_ARTIFACT}px`);
    fireEvent.mouseUp(document);
  });

  it("默认文件列表仍参与同层三栏 flex 布局", () => {
    expect(desktopCss).toMatch(
      /\.pw-prompts\s*\{[^}]*width:\s*320px;[^}]*position:\s*relative/s,
    );
    // files 标记本身不能令右栏脱离文档流。
    expect(desktopCss).not.toMatch(
      /\.pw-prompts\[data-right-view="files"\]\s*\{[^}]*position:\s*absolute/s,
    );
  });

  it("会话内打开文件预览后与产物同档向左展宽,参与三栏 flex(中栏压缩自适应,非覆盖层)", () => {
    const block = desktopCss.match(
      /\.pw-prompts:not\(\.is-maximized\):has\(\.pw-rp-view\.is-fileopen\)\s*\{([^}]*)\}/s,
    )?.[1];
    // 与 .pw-prompts:has(.pw-artifact-editor) 同一条宽度公式:中栏保 660px(自适应重排),
    // 窗口不够宽时 max() 兜底不让预览被夹成窄缝。
    // 100vw 改为 --pw-vw(zoom 校正视口宽):字号缩放(zoom)下 100vw 不缩放,会高估可用
    // 宽度导致右栏溢出窗口右缘(x 按钮被裁),公式一律以 --pw-vw 为基准。
    expect(block).toContain(
      "width: var(--rp-custom-width, min(calc(var(--pw-vw) * 0.62), max(480px, calc(var(--pw-vw) - 288px - 660px))));",
    );
    expect(block).toContain(
      "min-width: var(--rp-custom-width, min(480px, calc(var(--pw-vw) - 288px - var(--pw-center-min) - 48px)));",
    );
    // 不再是绝对定位覆盖层:那会让中栏布局不动,内容左边留白、右边被遮挡。
    expect(block).not.toContain("position: absolute");
    expect(desktopCss).not.toMatch(
      /\.pw-prompts\[data-right-view="files"\][^{]*\{[^}]*position:\s*absolute/s,
    );
  });

  it("右栏容器暴露文件专属标记,避免其他右栏视图误触发 660px 中栏约束", () => {
    usePersonalStore.setState({ rightView: "files" });
    const files = renderPanel();
    expect(files.container.querySelector("aside.pw-prompts")).toHaveAttribute(
      "data-right-view",
      "files",
    );
    files.unmount();

    usePersonalStore.setState({ rightView: "todos" });
    const todos = renderPanel();
    expect(todos.container.querySelector("aside.pw-prompts")).toHaveAttribute(
      "data-right-view",
      "todos",
    );
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

  // 演示文稿的标题与播放/导出并进这条顶栏,面板内不再叠第二条工具栏(用户要求)。
  it("演示文稿产物:顶栏出标题与播放/导出,且不带设计助手开关", () => {
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
          title: "把本季度的工作进展做成 2 页汇报 PPT",
          workspaceRoot: "/w",
          entryPath: "/w/.cortex-design/d1/deck.bento.html",
          createdAt: 1,
          updatedAt: 1,
        },
      }],
      activeSessionId: "s1",
      rightView: "artifact",
    });
    useCortexUIStore.setState({ rightOpen: true });
    const { container } = renderPanel();
    const head = container.querySelector(".pw-rp-head")!;
    // deck 尚未读出时回落会话产物标题,不显示通用的「产物」二字。
    expect(head.querySelector(".pw-col-head-title")?.textContent).toBe(
      "把本季度的工作进展做成 2 页汇报 PPT",
    );
    expect(head.querySelector("[data-testid='slides-play']")).not.toBeNull();
    expect(head.querySelector("[data-testid='slides-export']")).not.toBeNull();
    expect(head.textContent).not.toContain("设计助手");
  });

  it("设计稿产物仍显示通用标题「产物」(只有演示文稿并入顶栏)", () => {
    usePersonalStore.setState({
      sessions: [{
        id: "s1",
        title: "S",
        agent: "claude",
        createdAt: 1,
        updatedAt: 1,
        activeArtifact: {
          kind: "design",
          documentId: "d2",
          title: "落地页",
          workspaceRoot: "/w",
          entryPath: "/w/.cortex-design/d2",
          createdAt: 1,
          updatedAt: 1,
        },
      }],
      activeSessionId: "s1",
      rightView: "artifact",
    });
    useCortexUIStore.setState({ rightOpen: true });
    const { container } = renderPanel();
    expect(container.querySelector(".pw-rp-head .pw-col-head-title")?.textContent).toBe("产物");
  });

  // 放大:盖住中栏,给设计画布/演示文稿一个接近全屏的编辑面。
  describe("产物面板放大", () => {
    function seedArtifactSession() {
      usePersonalStore.setState({
        sessions: [{
          id: "s1",
          title: "S",
          agent: "claude",
          createdAt: 1,
          updatedAt: 1,
          activeArtifact: {
            kind: "design",
            documentId: "d1",
            title: "海报",
            workspaceRoot: "/w",
            entryPath: "/w/.cortex-design/d1",
            createdAt: 1,
            updatedAt: 1,
          },
        }],
        activeSessionId: "s1",
        rightView: "artifact",
        rightPanelMaximized: false,
      });
      useCortexUIStore.setState({ rightOpen: true });
    }

    it("点放大切到放大态,再点还原", () => {
      seedArtifactSession();
      const { container } = renderPanel();
      fireEvent.click(screen.getByTitle("放大面板"));
      expect(usePersonalStore.getState().rightPanelMaximized).toBe(true);
      expect(container.querySelector("aside.pw-prompts")?.className).toContain("is-maximized");

      fireEvent.click(screen.getByTitle("还原面板"));
      expect(usePersonalStore.getState().rightPanelMaximized).toBe(false);
      expect(container.querySelector("aside.pw-prompts")?.className).not.toContain("is-maximized");
    });

    it("非产物视图不给放大按钮,且切走时自动还原(否则文件面板会莫名盖住会话)", () => {
      seedArtifactSession();
      const { rerender } = renderPanel();
      fireEvent.click(screen.getByTitle("放大面板"));

      usePersonalStore.setState({ rightView: "files", rightPanelMaximized: true });
      rerender(
        <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
          <PersonalRightPanel onToast={() => {}} />
        </CoreProvider>,
      );
      expect(screen.queryByTitle("放大面板")).toBeNull();
      expect(usePersonalStore.getState().rightPanelMaximized).toBe(false);
    });

    it("文件视图:列表态无放大按钮,文件预览态(filePreviewOpen)开放放大,退回列表自动还原", async () => {
      usePersonalStore.setState({ rightView: "files", filePreviewOpen: false, rightPanelMaximized: false });
      useCortexUIStore.setState({ rightOpen: true });
      renderPanel();
      expect(screen.queryByTitle("放大面板")).toBeNull();

      // 进入文件预览(FilesView 镜像 preview → store)后头部出现放大按钮
      usePersonalStore.setState({ filePreviewOpen: true });
      await waitFor(() => expect(screen.getByTitle("放大面板")).toBeInTheDocument());
      fireEvent.click(screen.getByTitle("放大面板"));
      expect(usePersonalStore.getState().rightPanelMaximized).toBe(true);

      // 返回列表:预览关闭,放大态自动还原(否则窄列表盖住中栏)
      usePersonalStore.setState({ filePreviewOpen: false });
      await waitFor(() => expect(usePersonalStore.getState().rightPanelMaximized).toBe(false));
      expect(screen.queryByTitle("放大面板")).toBeNull();
    });

    it("放大态盖住中栏是 CSS 契约(绝对定位铺满 .pw-upper)", () => {
      expect(desktopCss).toMatch(
        /\.pw-prompts\.is-maximized\s*\{[^}]*position:\s*absolute/s,
      );
      expect(desktopCss).toMatch(/\.pw-prompts\.is-maximized\s*\{[^}]*inset:/s);
      // 容器必须是定位上下文,否则绝对定位会跑到 body 上。
      expect(desktopCss).toMatch(/\.pw-upper\s*\{[^}]*position:\s*relative/s);
    });
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
