import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const desktopCss = readFileSync("cortex-desktop/cortex-desktop.css", "utf8");

describe("会话产物入口布局", () => {
  it("入口卡片与消息流、输入框使用相同的 728px 阅读列上限", () => {
    expect(desktopCss).toMatch(
      /\.pw-artifact-card\s*\{[^}]*width:\s*calc\(100%\s*-\s*80px\)[^}]*max-width:\s*728px[^}]*margin:\s*0 auto 10px/s,
    );
  });
});
