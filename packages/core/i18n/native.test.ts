import { describe, expect, it } from "vitest";
import { languageInstruction, trayStrings } from "./native";

// U4:语言指令映射须覆盖 LOCALES 全集,未知 locale 回退 DEFAULT_LOCALE,避免 agent 静默拿不到语言指令。
describe("languageInstruction（U4 语言指令映射）", () => {
  it("zh-Hans → 简体中文指令", () => {
    expect(languageInstruction("zh-Hans")).toBe("请始终用简体中文回复。");
  });

  it("en → 英文指令", () => {
    expect(languageInstruction("en")).toBe("Always respond in English.");
  });

  it("未知 locale → 回退 DEFAULT_LOCALE(zh-Hans) 文案", () => {
    expect(languageInstruction("fr" as never)).toBe("请始终用简体中文回复。");
  });
});

describe("trayStrings（既有,回归保护）", () => {
  it("zh-Hans / en 各取对应托盘文案", () => {
    expect(trayStrings("zh-Hans").quit).toBe("退出 Cortex");
    expect(trayStrings("en").quit).toBe("Quit Cortex");
  });
});
