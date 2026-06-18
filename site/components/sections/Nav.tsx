"use client";

/* =========================================================================
   Nav · 顶部导航（sticky glass 顶栏）
   - 左：品牌标 BrandMark
   - 中：锚点链接（功能 / 工作流 / Agent 生态）→ /${locale}#features|#workflow|#agents
   - 右：语言开关 + 主题切换 + 主 CTA「下载」
   滚动超过阈值给顶栏加阴影与更实的背景（scrolled 态）。
   移动端（<=760px）中部锚点收进汉堡菜单：useState 控制展开，
   带可见 focus 与 aria-expanded，菜单项点击后自动收起。
   一切可见文案来自 d（Dict），不硬编码中英文。
   ========================================================================= */

import Link from "next/link";
import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand";
import { IconDownload } from "@/components/icons";
import { LangSwitch, ThemeToggle } from "@/components/ui";
import type { Dict } from "@/lib/dictionary";
import type { Locale } from "@/lib/i18n";

export default function Nav({ d, locale }: { d: Dict; locale: Locale }) {
  // 滚动态：超过阈值后顶栏背景更实、加阴影。
  const [scrolled, setScrolled] = useState(false);
  // 移动端汉堡菜单展开态。
  const [menuOpen, setMenuOpen] = useState(false);

  // 中部锚点链接（文案全部取自 d.nav，href 带 locale 前缀保证语言不丢）。
  const anchors = [
    { label: d.nav.skills, href: `/${locale}#skills` },
    { label: d.nav.accounting, href: `/${locale}#accounting` },
    { label: d.nav.notes, href: `/${locale}#notes` },
    { label: d.nav.terminal, href: `/${locale}#terminal` },
    { label: d.nav.features, href: `/${locale}#features` },
    { label: d.nav.agents, href: `/${locale}#agents` },
  ];
  const downloadHref = `/${locale}#download`;

  // 监听滚动，超过 8px 即视为「已滚动」，节流交给浏览器的 passive 监听。
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll(); // 首帧同步一次（刷新后停在中段时也能正确显态）
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 视口放宽到桌面尺寸时，自动收起移动菜单，避免状态残留。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 761px)");
    const onChange = () => {
      if (mq.matches) setMenuOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 菜单展开时按 Esc 收起，提升键盘可用性。
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <header className={`site-nav ${scrolled ? "is-scrolled" : ""}`}>
      <nav className="site-nav__bar container glass" aria-label={d.a11y.primaryNav}>
        {/* 左：品牌标，链回当前语言首页 */}
        <Link className="site-nav__brand" href={`/${locale}`} aria-label={d.brand.name}>
          <BrandMark />
        </Link>

        {/* 中：桌面锚点链接（移动端隐藏，收进汉堡菜单） */}
        <div className="site-nav__links" role="presentation">
          {anchors.map((item) => (
            <Link key={item.href} className="site-nav__link" href={item.href}>
              {item.label}
            </Link>
          ))}
        </div>

        {/* 右：语言 / 主题 / 主 CTA + 汉堡按钮 */}
        <div className="site-nav__actions">
          <LangSwitch locale={locale} />
          <ThemeToggle />
          <Link className="btn btn--primary site-nav__cta" href={downloadHref}>
            <IconDownload />
            {d.nav.download}
          </Link>

          {/* 汉堡按钮：仅移动端可见，控制中部链接菜单 */}
          <button
            type="button"
            className="site-nav__burger"
            // Dict 无「菜单」键，按契约用中性英文 aria-label。
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="site-nav-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            {/* 三道杠 ↔ 关闭叉，纯 CSS 形变，无第三方图标 */}
            <span className={`site-nav__burger-icon ${menuOpen ? "is-open" : ""}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>
      </nav>

      {/* 移动端展开菜单：仅在展开时渲染于无障碍树之内 */}
      <div
        id="site-nav-menu"
        className={`site-nav__menu glass ${menuOpen ? "is-open" : ""}`}
        hidden={!menuOpen}
      >
        <ul className="site-nav__menu-list">
          {anchors.map((item) => (
            <li key={item.href}>
              <Link
                className="site-nav__menu-link"
                href={item.href}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {/* 组件级 scoped 样式：复用 globals.css 的 token 与 .glass，仅补顶栏布局。 */}
      <style>{`
        .site-nav {
          position: sticky;
          top: 0;
          z-index: 50;
          padding-top: clamp(10px, 1.4vw, 16px);
          /* 顶栏自身不挡内容滚动，但要让玻璃栏盖在内容之上 */
        }
        .site-nav__bar {
          display: flex;
          align-items: center;
          gap: 14px;
          max-width: var(--maxw);
          /* 内层用药丸玻璃条，悬浮在纸面上 */
          padding: 9px 12px 9px 16px;
          border-radius: var(--r-pill);
          box-shadow: var(--shadow-xs);
          transition: box-shadow 0.3s var(--ease), background 0.3s var(--ease),
            border-color 0.3s var(--ease);
        }
        /* 滚动后：更实的背景 + 更明显的阴影 */
        .site-nav.is-scrolled .site-nav__bar {
          box-shadow: var(--shadow-raise);
          border-color: var(--line-strong);
          background: color-mix(in oklab, var(--paper-raise) 86%, transparent);
        }

        .site-nav__brand {
          display: inline-flex;
          align-items: center;
          border-radius: var(--r-sm);
        }

        /* 中部锚点：占据弹性空间并居中 */
        .site-nav__links {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-inline: auto;
        }
        .site-nav__link {
          padding: 8px 14px;
          border-radius: var(--r-pill);
          font-size: 0.92rem;
          font-weight: 550;
          color: var(--ink-2);
          transition: color 0.2s var(--ease), background 0.2s var(--ease);
        }
        .site-nav__link:hover {
          color: var(--ink);
          background: var(--paper-sink);
        }

        .site-nav__actions {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-left: auto;
        }
        /* CTA 在主操作区右端，水母光感留给品牌，CTA 用 clay 强调（class 已带） */
        .site-nav__cta {
          padding: 9px 16px;
          font-size: 0.9rem;
        }

        /* 汉堡按钮默认隐藏，仅移动端出现 */
        .site-nav__burger {
          display: none;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: var(--r-pill);
          color: var(--ink);
        }
        .site-nav__burger:hover {
          background: var(--paper-sink);
        }
        .site-nav__burger-icon {
          position: relative;
          display: inline-flex;
          flex-direction: column;
          justify-content: center;
          gap: 4px;
          width: 18px;
          height: 14px;
        }
        .site-nav__burger-icon span {
          display: block;
          height: 1.8px;
          width: 100%;
          border-radius: 2px;
          background: currentColor;
          transition: transform 0.26s var(--ease), opacity 0.2s var(--ease);
        }
        /* 展开态：上下两道交叉成叉，中间淡出 */
        .site-nav__burger-icon.is-open span:nth-child(1) {
          transform: translateY(5.8px) rotate(45deg);
        }
        .site-nav__burger-icon.is-open span:nth-child(2) {
          opacity: 0;
        }
        .site-nav__burger-icon.is-open span:nth-child(3) {
          transform: translateY(-5.8px) rotate(-45deg);
        }

        /* 移动端展开菜单：默认收起（仅移动端会展开） */
        .site-nav__menu {
          max-width: var(--maxw);
          margin: 10px auto 0;
          padding: 8px;
          border-radius: var(--r-lg);
          box-shadow: var(--shadow-pop);
          animation: siteNavMenuIn 0.22s var(--ease-out);
        }
        .site-nav__menu-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .site-nav__menu-link {
          display: block;
          padding: 12px 14px;
          border-radius: var(--r);
          font-size: 1rem;
          font-weight: 550;
          color: var(--ink);
        }
        .site-nav__menu-link:hover {
          background: var(--paper-sink);
        }

        @keyframes siteNavMenuIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: none; }
        }

        /* —— 移动端（<=760px）：折叠中部链接，露出汉堡 —— */
        @media (max-width: 760px) {
          .site-nav__links {
            display: none;
          }
          /* 文字版 CTA 收成图标主操作，节省横向空间 */
          .site-nav__cta {
            padding: 9px 12px;
          }
          .site-nav__burger {
            display: inline-flex;
          }
        }
        /* 桌面端不需要菜单容器占位 */
        @media (min-width: 761px) {
          .site-nav__menu {
            display: none;
          }
        }

        /* 动效在 reduced-motion 下静默 */
        @media (prefers-reduced-motion: reduce) {
          .site-nav__bar,
          .site-nav__burger-icon span {
            transition: none;
          }
          .site-nav__menu {
            animation: none;
          }
        }
      `}</style>
    </header>
  );
}
