import { describe, expect, it } from "vitest";
import { createMainWindowOptions } from "./main-window-geometry";

describe("主窗口宽度", () => {
  it("保留完整三栏的默认宽度，同时允许窗口缩小至 960px", () => {
    const options = createMainWindowOptions({
      isMacOS: false,
      icon: "/tmp/cortex-icon.png",
      preload: "/tmp/preload.js",
    });

    expect(options.width).toBe(1470);
    expect(options.minWidth).toBe(960);
  });
});
