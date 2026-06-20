import { describe, it, expect } from "vitest";
import { canUseElectronWebviewEnvironment } from "./BrowserView";

// BrowserView 的导航/事件逻辑依赖 Electron <webview> 运行期 API,jsdom 无法仿真;
// 此处单测可纯逻辑导出的环境探测(决定 webview vs iframe 回退),组件渲染由集成/手测覆盖。
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
