// 外观项（theme / fontScale / density / palette / sidebar）的持久化 wiring。
// useCortexUIStore 本身无持久化（裸 create）,此处在 views 层用 localStorage 补齐：
// mount 时恢复并应用到根节点,变更即写盘 + 重应用,theme=system 随系统明暗切换重算。
// （core 不得直接用 localStorage,故持久化逻辑放 views 层。）

import { useEffect } from "react";
import { DEFAULT_TWEAKS, useCortexUIStore, useDesktopBridge } from "@cortex-work/core";
import { changeLanguage } from "@cortex-work/core/i18n";
import type { FontScale, ThemeMode, Tweaks } from "@cortex-work/core/types";

const STORAGE_KEY = "cortex.tweaks";

const FONT_SCALE_RATIO: Record<FontScale, string> = {
  small: "0.9",
  medium: "1",
  large: "1.1",
};

export function fontScaleRatio(scale: FontScale): string {
  return FONT_SCALE_RATIO[scale] ?? "1";
}

// 解析有效主题：system → 跟随 matchMedia；其余直接返回。
export function resolveTheme(theme: ThemeMode): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

// 从 localStorage 读已存外观项（缺字段回退 DEFAULT_TWEAKS）。
export function loadStoredTweaks(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Tweaks>) : {};
    return { ...DEFAULT_TWEAKS, ...saved };
  } catch {
    return { ...DEFAULT_TWEAKS };
  }
}

function storeTweaks(t: Tweaks): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
  } catch {
    /* 忽略（隐私模式/配额满） */
  }
}

// 应用到根节点：data-theme + --font-scale（挂 documentElement 以覆盖 Spotlight/Pet 等
// .app-frame 外子树）。
export function applyTweaksToDom(t: Tweaks): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(t.theme);
  root.style.setProperty("--font-scale", fontScaleRatio(t.fontScale));
  // <html lang> 随活动语言更新(无障碍 + 覆盖 layout.tsx 的服务端默认值）。
  root.lang = t.language;
}

export function useTweaksPersistence(): void {
  const bridge = useDesktopBridge();
  useEffect(() => {
    // 1. 启动恢复：存档合并进 store（仅差异项写入,避免无谓 re-render）。
    const stored = loadStoredTweaks();
    const cur = useCortexUIStore.getState();
    (Object.keys(stored) as (keyof Tweaks)[]).forEach((k) => {
      if (cur.tweaks[k] !== stored[k]) cur.setTweak(k, stored[k]);
    });
    applyTweaksToDom(useCortexUIStore.getState().tweaks);
    // 启动时把已存语言喂给 i18next(异步,fire-and-forget,同 theme 范式不 await）。
    const startupLang = useCortexUIStore.getState().tweaks.language;
    void changeLanguage(startupLang);
    // 桌面端:把启动语言下发主进程,初始化托盘菜单 + 次级窗口镜像（best-effort,web 端 bridge=null）。
    void bridge?.setLocale?.(startupLang);

    // 2. 变更即写盘 + 重应用。
    const unsub = useCortexUIStore.subscribe((s, prev) => {
      if (s.tweaks !== prev.tweaks) {
        storeTweaks(s.tweaks);
        applyTweaksToDom(s.tweaks);
        // 仅语言变化时切 i18next(idempotent,但省去无谓 changeLanguage)。
        if (s.tweaks.language !== prev.tweaks.language) {
          void changeLanguage(s.tweaks.language);
          // 同步下发主进程,重建托盘菜单 + 广播给次级窗口（best-effort）。
          void bridge?.setLocale?.(s.tweaks.language);
        }
      }
    });

    // 3. system 主题随系统明暗切换重算。
    const mq =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const onSystem = () => {
      if (useCortexUIStore.getState().tweaks.theme === "system") {
        applyTweaksToDom(useCortexUIStore.getState().tweaks);
      }
    };
    mq?.addEventListener?.("change", onSystem);

    return () => {
      unsub();
      mq?.removeEventListener?.("change", onSystem);
    };
    // bridge 由宿主壳一次性注入、引用稳定（同 usePersonalPersistence 范式）。
  }, [bridge]);
}
