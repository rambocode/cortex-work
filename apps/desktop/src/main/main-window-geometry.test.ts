import { describe, expect, it } from "vitest";
import { createMainWindowOptions } from "./main-window-geometry";

describe("主窗口宽度", () => {
  it("默认宽度 1180、最小宽度 520（允许缩到 770 以下触发自动收左栏，中栏保 440）", () => {
    const options = createMainWindowOptions({
      isMacOS: false,
      icon: "/tmp/cortex-icon.png",
      preload: "/tmp/preload.js",
    });

    expect(options.width).toBe(1180);
    expect(options.minWidth).toBe(520);
  });
});
