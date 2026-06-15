"use client";

// 站点通用客户端小工具：主题切换、语言开关、进入视口揭示动画。
// 注：ThemeToggle / Reveal 需要浏览器能力，故整文件标记为客户端组件；
// LangSwitch 本身无客户端依赖（仅 next/link），在客户端组件中同样可正常工作。

import Link from "next/link";
import { useEffect, useState } from "react";

import { IconGlobe, IconMoon, IconSun } from "@/components/icons";
import { localeLabel, otherLocale, type Locale } from "@/lib/i18n";

// localStorage 中保存主题偏好的键名（与桌面端约定一致）。
const THEME_KEY = "cortex-theme";
type Theme = "light" | "dark";

/* ===================== 主题切换 ===================== */
// 在亮 / 暗之间切换，写入 localStorage 并同步到 <html data-theme>。
// 用 useEffect 在挂载后读初值，避免 SSR / 首帧与客户端不一致导致的 hydration 抖动。
export function ThemeToggle() {
  // 初始 null = 尚未挂载，渲染占位以保持服务端与客户端首帧一致。
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    // 优先取已保存偏好，否则跟随系统暗色偏好，兜底为亮色。
    let initial: Theme;
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") {
        initial = saved;
      } else {
        initial = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    } catch {
      initial = "light";
    }
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  function toggle() {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // 隐私模式 / 存储不可用时静默降级，仅作用于当前会话。
      }
      return next;
    });
  }

  // 挂载前：渲染一个不可交互、对辅助技术隐藏的占位按钮，保持布局稳定。
  if (theme === null) {
    return (
      <button
        type="button"
        className="btn btn--quiet"
        aria-hidden="true"
        tabIndex={-1}
        // 占位仅为撑住尺寸，不响应点击。
        style={{ visibility: "hidden" }}
      >
        <IconSun />
      </button>
    );
  }

  const isDark = theme === "dark";
  // 标签描述「点击后会切到」的目标主题，语义更准确。
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button type="button" className="btn btn--quiet" onClick={toggle} aria-label={label} title={label}>
      {isDark ? <IconSun /> : <IconMoon />}
    </button>
  );
}

/* ===================== 语言开关 ===================== */
// 链接到「另一种」语言的首页，文案显示目标语言名。
export function LangSwitch({ locale }: { locale: Locale }) {
  const target = otherLocale(locale);
  return (
    <Link className="btn btn--quiet" href={`/${target}`} aria-label={`Switch language to ${localeLabel[target]}`}>
      <IconGlobe />
      {localeLabel[target]}
    </Link>
  );
}

/* ===================== 进入视口揭示 ===================== */
// 包裹任意内容，元素进入视口时给根 div 加 is-visible 触发 .reveal 动画。
// 一次性：触发后即 disconnect。SSR 安全（无 IO 时直接显示，由全局 reduced-motion 兜底静默）。
export function Reveal({
  children,
  className,
  i,
}: {
  children: React.ReactNode;
  className?: string;
  i?: number;
}) {
  // 用 callback ref 拿到真实 DOM 节点并挂 IntersectionObserver。
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!node) return;
    // 环境不支持 IntersectionObserver 时（极端老环境 / 测试），直接显示，保证内容不丢。
    if (typeof IntersectionObserver === "undefined") {
      node.classList.add("is-visible");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add("is-visible");
            io.disconnect(); // 一次性触发
            break;
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [node]);

  return (
    <div
      ref={setNode}
      className={`reveal ${className ?? ""}`}
      // --i 控制 .reveal 的 stagger 延迟（见 globals.css）。
      style={{ ["--i" as string]: i ?? 0 } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
