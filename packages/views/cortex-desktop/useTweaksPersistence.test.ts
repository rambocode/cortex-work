import { renderHook, waitFor } from "@testing-library/react";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";

// 持久化 hook 现经 useDesktopBridge 读 bridge,需 CoreProvider 上下文(web 端 bridge=null)。
const coreWrapper = ({ children }: { children: ReactNode }) =>
  createElement(CoreProvider, { wsId: "test-ws", identity: { userId: "me", name: "我" }, desktopBridge: null }, children);
import {
  applyTweaksToDom,
  fontScaleRatio,
  loadStoredTweaks,
  resolveTheme,
  useTweaksPersistence,
} from "./useTweaksPersistence";
import { DEFAULT_TWEAKS, useCortexUIStore } from "@cortex-work/core";
import { changeLanguage, i18n, i18nReady } from "@cortex-work/core/i18n";

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

beforeAll(async () => {
  await i18nReady;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("lang");
  document.documentElement.style.removeProperty("--font-scale");
  useCortexUIStore.setState({ tweaks: { ...DEFAULT_TWEAKS } });
  await changeLanguage("zh-Hans");
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
  it("写 documentElement.lang 为活动语言（U2 / R6）", () => {
    mockMatchMedia(false);
    applyTweaksToDom({ ...DEFAULT_TWEAKS, language: "en" });
    expect(document.documentElement.lang).toBe("en");
    applyTweaksToDom({ ...DEFAULT_TWEAKS, language: "zh-Hans" });
    expect(document.documentElement.lang).toBe("zh-Hans");
  });
});

describe("language 持久化（U2）", () => {
  it("DEFAULT_TWEAKS 默认语言为 zh-Hans", () => {
    expect(DEFAULT_TWEAKS.language).toBe("zh-Hans");
    expect(loadStoredTweaks().language).toBe("zh-Hans");
  });
  it("缺 language 字段（旧档）回退 zh-Hans", () => {
    localStorage.setItem("cortex.tweaks", JSON.stringify({ density: "compact" }));
    expect(loadStoredTweaks().language).toBe("zh-Hans");
  });
  it("读回已存 language", () => {
    localStorage.setItem("cortex.tweaks", JSON.stringify({ language: "en" }));
    expect(loadStoredTweaks().language).toBe("en");
  });

  it("切 store.language → i18next 切换 + documentElement.lang 更新 + 写盘（R6）", async () => {
    mockMatchMedia(false);
    renderHook(() => useTweaksPersistence(), { wrapper: coreWrapper });
    await act(async () => {
      useCortexUIStore.getState().setTweak("language", "en");
    });
    await waitFor(() => expect(i18n.language).toBe("en"));
    expect(document.documentElement.lang).toBe("en");
    expect(JSON.parse(localStorage.getItem("cortex.tweaks")!).language).toBe("en");
  });

  it("localStorage 写入抛错（隐私模式）不崩溃", async () => {
    mockMatchMedia(false);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    renderHook(() => useTweaksPersistence(), { wrapper: coreWrapper });
    await act(async () => {
      useCortexUIStore.getState().setTweak("language", "en");
    });
    await waitFor(() => expect(i18n.language).toBe("en"));
    setItem.mockRestore();
  });
});
