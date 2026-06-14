import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTweaksToDom,
  fontScaleRatio,
  loadStoredTweaks,
  resolveTheme,
} from "./useTweaksPersistence";
import { DEFAULT_TWEAKS } from "@cortex-work/core";

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: dark,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--font-scale");
});

describe("fontScaleRatio", () => {
  it("映射 small/medium/large 为缩放比", () => {
    expect(fontScaleRatio("small")).toBe("0.9");
    expect(fontScaleRatio("medium")).toBe("1");
    expect(fontScaleRatio("large")).toBe("1.1");
  });
});

describe("resolveTheme", () => {
  it("light/dark 直接返回", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
  it("system 跟随 matchMedia", () => {
    mockMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");
    mockMatchMedia(false);
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("loadStoredTweaks", () => {
  it("无存档回退 DEFAULT_TWEAKS", () => {
    expect(loadStoredTweaks()).toEqual(DEFAULT_TWEAKS);
  });
  it("缺字段（旧档只有 density）以 DEFAULT_TWEAKS 补全", () => {
    localStorage.setItem("cortex.tweaks", JSON.stringify({ density: "compact" }));
    const out = loadStoredTweaks();
    expect(out.density).toBe("compact");
    expect(out.fontScale).toBe(DEFAULT_TWEAKS.fontScale);
    expect(out.theme).toBe(DEFAULT_TWEAKS.theme);
  });
  it("损坏 JSON 回退 DEFAULT_TWEAKS,不抛", () => {
    localStorage.setItem("cortex.tweaks", "{not json");
    expect(loadStoredTweaks()).toEqual(DEFAULT_TWEAKS);
  });
});

describe("applyTweaksToDom", () => {
  it("写 documentElement 的 data-theme 与 --font-scale", () => {
    mockMatchMedia(false);
    applyTweaksToDom({ ...DEFAULT_TWEAKS, theme: "dark", fontScale: "large" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.1");
  });
  it("theme=system 解析为系统明暗", () => {
    mockMatchMedia(true);
    applyTweaksToDom({ ...DEFAULT_TWEAKS, theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
