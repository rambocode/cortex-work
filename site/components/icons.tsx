import type { ReactElement } from "react";
import type { FeatureItem } from "@/lib/dictionary";

/* =========================================================================
   内联 SVG 图标库（线性图标）
   统一规范：viewBox 0 0 24 24 · fill none · stroke currentColor ·
   stroke-width 1.7 · 圆角线帽/线接。颜色随父级 currentColor，由调用方控制。
   品牌水母标见 brand.tsx（带渐变填充，不在此处）。
   ========================================================================= */

/** 所有线性图标共享的 <svg> 属性，保证线条风格统一。 */
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true,
  focusable: false,
};

/* ===================== 功能图标（对应 FeatureItem.icon）===================== */

/** 三栏工作台：外框 + 两条竖分隔，呼应「左会话 / 中工作 / 右上下文」。 */
export function IconWorkspace({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="M9 4.5v15M15 4.5v15" />
      <path d="M5.4 8.2h1.2M5.4 11h1.2" />
    </svg>
  );
}

/** 团队协作：两个叠放的人形头肩，意指「Agent 像同事」。 */
export function IconTeam({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <circle cx="9" cy="8.4" r="2.7" />
      <path d="M3.8 19c0-2.9 2.3-5 5.2-5s5.2 2.1 5.2 5" />
      <path d="M15.6 6.2a2.7 2.7 0 0 1 .3 5.2" />
      <path d="M16.5 14.2c2.2.4 3.7 2.3 3.7 4.8" />
    </svg>
  );
}

/** 时间线：竖轴 + 三个活动节点与事件行，意指「项目活动按时间回看」。 */
export function IconTimeline({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M6 3.6v16.8" />
      <circle cx="6" cy="7" r="1.7" />
      <circle cx="6" cy="12.5" r="1.7" />
      <circle cx="6" cy="18" r="1.7" />
      <path d="M10 7h9M10 12.5h7M10 18h5" />
    </svg>
  );
}

/** Diff 人审：左右两栏文本块 + 右上对勾，意指「审阅并批准改动」。 */
export function IconReview({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M4 5.5h6M4 9h6M4 12.5h4.5" />
      <path d="M14 5.5h6M14 9h4.5" />
      <path d="M12 4v8.5" />
      <path d="M13.5 17.6l2.1 2.1 4.2-4.4" />
    </svg>
  );
}

/** 定时自动化：时钟表盘 + 一段循环回环箭头，意指「按节奏循环执行」。 */
export function IconAutomation({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M20.2 11.2a8 8 0 1 0-1.5 5.6" />
      <path d="M20.4 11.6V7.6M20.4 11.6h-3.4" />
      <path d="M12 7.6V12l2.8 1.7" />
    </svg>
  );
}

/** 用量日历：日历外框 + 顶部挂耳 + 底部一排上升柱，意指「按天累计用量」。 */
export function IconUsage({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.2" />
      <path d="M3.5 9h17" />
      <path d="M8 3.5v3M16 3.5v3" />
      <path d="M8 16.5v-2.4M12 16.5v-4M16 16.5v-1.4" />
    </svg>
  );
}

/** 终端与 Git：命令行框（提示符 + 光标）+ 角落分支节点，意指「终端 + 分支」。 */
export function IconTerminal({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <rect x="2.8" y="4.6" width="18.4" height="14.8" rx="2.4" />
      <path d="M6.4 9.2l2.4 2.2-2.4 2.2" />
      <path d="M10.8 14.4h3.4" />
      <circle cx="17" cy="9" r="1.2" />
      <circle cx="17" cy="14.4" r="1.2" />
      <path d="M17 10.2v3" />
    </svg>
  );
}

/* ===================== UI 图标 ===================== */

/** 下载：向下箭头落入托盘。 */
export function IconDownload({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M12 3.5v10.5" />
      <path d="M7.8 10l4.2 4.2 4.2-4.2" />
      <path d="M4.5 18.5h15" />
    </svg>
  );
}

/** GitHub：猫标轮廓（简化八爪鱼猫剪影）。 */
export function IconGithub({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M9 19.4c-3.4 1-3.4-1.7-4.8-2M19 17.2c0 1.3.1 2.2.1 2.6" />
      <path d="M19.1 19.8c0-1.1.1-2.1-.6-3 2.5-.3 4.2-1.5 4.2-5 0-1.2-.4-2.2-1-3 .3-.9.3-1.9-.1-2.9 0 0-1-.3-3.2 1.2a10.7 10.7 0 0 0-5.6 0C9.8 5.6 8.8 5.9 8.8 5.9c-.4 1-.4 2-.1 2.9-.7.8-1 1.8-1 3 0 3.5 1.7 4.7 4.2 5-.4.4-.6 1-.6 1.7v3.3" />
    </svg>
  );
}

/** 右向箭头：常用于「次要 CTA / 跳转」。 */
export function IconArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M4.5 12h15" />
      <path d="M13.5 6l6 6-6 6" />
    </svg>
  );
}

/** 太阳：亮色主题。 */
export function IconSun({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.6v2.4M12 19v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.6 12h2.4M19 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" />
    </svg>
  );
}

/** 月亮：暗色主题。 */
export function IconMoon({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.2 8.2 0 1 0 10.2 10.2z" />
    </svg>
  );
}

/** 地球：语言切换。 */
export function IconGlobe({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.6c2.4 2.4 3.7 5.4 3.7 8.4s-1.3 6-3.7 8.4c-2.4-2.4-3.7-5.4-3.7-8.4s1.3-6 3.7-8.4z" />
    </svg>
  );
}

/** 对勾：列表要点 / 已完成。 */
export function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M4.5 12.5l4.5 4.5L19.5 6.5" />
    </svg>
  );
}

/** 账本：带横账行的票据本 + 底部金额勾，意指「结构化记账条目」。 */
export function IconLedger({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2.2" />
      <path d="M8 8h5M8 11.5h5M8 15h3" />
      <circle cx="16" cy="8" r="0.9" />
      <circle cx="16" cy="11.5" r="0.9" />
      <path d="M14.6 15.4l1.2 1.2 2.2-2.4" />
    </svg>
  );
}

/** 火花：智能 / 点睛点缀（四角星 + 一小星）。 */
export function IconSparkle({ className }: { className?: string }) {
  return (
    <svg className={className} {...base}>
      <path d="M12 3.2c.5 3.6 1.8 4.9 5.4 5.4-3.6.5-4.9 1.8-5.4 5.4-.5-3.6-1.8-4.9-5.4-5.4 3.6-.5 4.9-1.8 5.4-5.4z" />
      <path d="M18.2 14.4c.2 1.6.8 2.2 2.4 2.4-1.6.2-2.2.8-2.4 2.4-.2-1.6-.8-2.2-2.4-2.4 1.6-.2 2.2-.8 2.4-2.4z" />
    </svg>
  );
}

/* ===================== 功能图标映射 ===================== */

/**
 * FeatureItem.icon -> 对应图标组件。
 * Features 区块用 featureIcon[item.icon] 取用，无需 switch。
 */
export const featureIcon: Record<
  FeatureItem["icon"],
  (p: { className?: string }) => ReactElement
> = {
  workspace: IconWorkspace,
  timeline: IconTimeline,
  review: IconReview,
  automation: IconAutomation,
  usage: IconUsage,
  terminal: IconTerminal,
};
