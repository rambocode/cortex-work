// 内嵌浏览器「截图到剪贴板」hook(计划 U3/KTD4)。
// 渲染端调 webview.capturePage()(可视区)→ toPNG() 字节 → 经 bridge.browserCopyImage
// 交主进程写系统剪贴板(contextIsolation+sandbox 下渲染端不能直接用 clipboard)。
// 仅 Electron <webview> 有 capturePage;iframe 回退无此能力,故按钮在 Web 端隐藏(BrowserView 门控)。

import { useCallback, useState } from "react";
import type { DesktopBridge } from "@cortex-work/core/desktop/bridge";

// webview 元素的截图能力(运行期由 Electron 提供);NativeImage 仅用到这两个方法。
export type CapturableWebview = {
  capturePage(): Promise<{ toPNG(): Uint8Array; isEmpty(): boolean }>;
};

export type CaptureResult = "ok" | "empty" | "failed";

export function useBrowserCapture(bridge: Pick<DesktopBridge, "browserCopyImage"> | null) {
  const [capturing, setCapturing] = useState(false);

  const capture = useCallback(
    async (webview: CapturableWebview | null): Promise<CaptureResult> => {
      if (!webview || typeof bridge?.browserCopyImage !== "function") return "failed";
      setCapturing(true);
      try {
        const image = await webview.capturePage();
        // 隐藏/空白页 capturePage 可能返回空图 → 报错而非写空剪贴板。
        if (image.isEmpty()) return "empty";
        const ok = await bridge.browserCopyImage(image.toPNG());
        return ok ? "ok" : "failed";
      } catch {
        return "failed";
      } finally {
        setCapturing(false);
      }
    },
    [bridge],
  );

  return { capture, capturing };
}
