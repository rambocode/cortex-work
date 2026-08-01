import { describe, expect, it } from "vitest";
import { createMainWindowOptions } from "./main-window-geometry";

describe("主窗口宽度", () => {
  it("BrowserWindow 最终配置能容纳最宽左栏、660px 中栏和文件预览栏", () => {
    const options = createMainWindowOptions({
      isMacOS: false,
      icon: "/tmp/cortex-icon.png",
      preload: "/tmp/preload.js",
    });

    expect(options.width).toBe(1470);
    expect(options.minWidth).toBe(1470);
  });
});
