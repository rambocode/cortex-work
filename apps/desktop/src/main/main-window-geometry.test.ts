import { describe, expect, it } from "vitest";
import { createMainWindowOptions } from "./main-window-geometry";

describe("主窗口宽度", () => {
  it("默认宽度 1000、最小宽度 960，首启即紧凑姿态", () => {
    const options = createMainWindowOptions({
      isMacOS: false,
      icon: "/tmp/cortex-icon.png",
      preload: "/tmp/preload.js",
    });

    expect(options.width).toBe(1000);
    expect(options.minWidth).toBe(960);
  });
});
