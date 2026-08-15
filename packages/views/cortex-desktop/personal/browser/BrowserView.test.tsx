import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { BrowserView, canUseElectronWebviewEnvironment } from "./BrowserView";

// BrowserTabPane 的导航/事件逻辑依赖 Electron <webview> 运行期 API,jsdom 无法仿真;
// 此处单测:① 纯逻辑导出的环境探测(决定 webview vs iframe 回退);② 多标签壳的
// 标签生命周期(新建/切换/关闭)与「在浏览器打开」请求到活跃标签的路由。
// jsdom 下 bridge 无 openExternal → 走 iframe 回退分支,恰好可用 iframe src 断言加载路由。
describe("canUseElectronWebviewEnvironment", () => {
  it("bridge 可用 + UA 含 Electron → 用 webview", () => {
    expect(
      canUseElectronWebviewEnvironment({
        bridgeAvailable: true,
        userAgent: "Mozilla/5.0 Electron/39.8.10 Chrome",
      }),
    ).toBe(true);
  });

  it("无 bridge(Web 端)→ 回退 iframe", () => {
    expect(
      canUseElectronWebviewEnvironment({
        bridgeAvailable: false,
        userAgent: "Mozilla/5.0 Electron/39.8.10 Chrome",
      }),
    ).toBe(false);
  });

  it("普通浏览器 UA → 回退 iframe", () => {
    expect(
      canUseElectronWebviewEnvironment({
        bridgeAvailable: true,
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/120 Safari/537",
      }),
    ).toBe(false);
  });
});

const bridge = {} as unknown as DesktopBridge;

function renderBrowser() {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <BrowserView />
    </CoreProvider>,
  );
}

// 便捷断言:当前所有标签页 pane 与活跃 pane。
function panes(): Element[] {
  return Array.from(document.querySelectorAll(".pw-browser-pane"));
}
function activePane(): Element | null {
  return document.querySelector(".pw-browser-pane.is-active");
}

describe("BrowserView 多标签壳", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    usePersonalStore.setState({ browserUrlRequest: undefined });
  });

  it("默认一个空标签,标签条含「新标签页」与新建按钮", () => {
    renderBrowser();
    expect(panes()).toHaveLength(1);
    expect(activePane()).not.toBeNull();
    expect(screen.getByRole("tab")).toHaveTextContent("新标签页");
    expect(screen.getByRole("button", { name: "新建标签页" })).toBeInTheDocument();
  });

  it("新建标签:pane 增加且新标签被激活", () => {
    renderBrowser();
    fireEvent.click(screen.getByRole("button", { name: "新建标签页" }));
    expect(panes()).toHaveLength(2);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    // 新标签激活:第二个 tab aria-selected
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
  });

  it("点击标签切换活跃;关闭活跃标签激活邻居", () => {
    renderBrowser();
    fireEvent.click(screen.getByRole("button", { name: "新建标签页" }));
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[0]!);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    // 关闭活跃的第一个标签 → 剩下的(原第二个)被激活
    fireEvent.click(screen.getAllByRole("button", { name: "关闭标签页" })[0]!);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab")).toHaveAttribute("aria-selected", "true");
    expect(panes()).toHaveLength(1);
  });

  it("关闭最后一个标签 → 重置为全新空标签(面板始终至少一个标签)", () => {
    renderBrowser();
    fireEvent.click(screen.getByRole("button", { name: "关闭标签页" }));
    expect(panes()).toHaveLength(1);
    expect(screen.getByRole("tab")).toHaveTextContent("新标签页");
  });

  it("browserUrlRequest 路由到活跃标签加载;新建标签不重复消费旧请求", () => {
    renderBrowser();
    // store 变更发生在 React 之外,需 act() 才会同步刷新组件。
    act(() => usePersonalStore.setState({ browserUrlRequest: { url: "https://example.com/", nonce: 7 } }));
    // 活跃 pane 的 iframe 加载该 URL
    expect(activePane()!.querySelector("iframe")?.getAttribute("src")).toBe("https://example.com/");
    // 新建标签:新 pane 是空标签,不重复消费 nonce=7 的旧请求
    fireEvent.click(screen.getByRole("button", { name: "新建标签页" }));
    expect(activePane()!.querySelector("iframe")).toBeNull();
    // 新请求路由到当前活跃(新)标签,旧标签内容不变
    act(() => usePersonalStore.setState({ browserUrlRequest: { url: "https://foo.dev/", nonce: 8 } }));
    expect(activePane()!.querySelector("iframe")?.getAttribute("src")).toBe("https://foo.dev/");
    const all = panes();
    expect(all[0]!.querySelector("iframe")?.getAttribute("src")).toBe("https://example.com/");
  });

  it("挂载时消费当前 pending 请求(面板被本次请求打开的场景,首击不空白)", () => {
    usePersonalStore.setState({ browserUrlRequest: { url: "https://pending.io/", nonce: 3 } });
    renderBrowser();
    expect(activePane()!.querySelector("iframe")?.getAttribute("src")).toBe("https://pending.io/");
  });
});
