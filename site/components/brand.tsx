/* =========================================================================
   品牌标识：小号发光水母标 + 「Cortex」文字
   - 水母伞盖用品牌蓝紫渐变（与 app/icon.svg、--grad-jelly 同源同色）
   - 几条下垂触手 + 伞盖发光白点（神经元意象）
   - 可被 server 组件渲染：纯 SVG，无 hooks。多处复用时渐变 id 相同，
     浏览器按文档顺序解析首个同 id 定义，视觉一致、安全。
   ========================================================================= */

/** 单一发光水母小标（约 24px），渐变与色值同 app/icon.svg。 */
function JellyMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable="false"
    >
      <defs>
        {/* 伞盖渐变：浅蓝 → 蓝 → 蓝紫 → 紫，与 --grad-jelly 一致 */}
        <linearGradient id="cortexBell" x1="8" y1="4" x2="24" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8fd2ff" />
          <stop offset="0.45" stopColor="#6a8bff" />
          <stop offset="0.8" stopColor="#9a6bff" />
          <stop offset="1" stopColor="#b46bff" />
        </linearGradient>
        {/* 柔和外光晕 */}
        <radialGradient id="cortexHalo" cx="16" cy="13" r="13" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6a8bff" stopOpacity="0.42" />
          <stop offset="1" stopColor="#6a8bff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 光晕 */}
      <circle cx="16" cy="14" r="13" fill="url(#cortexHalo)" />

      {/* 伞盖（半圆穹顶） */}
      <path
        d="M5.5 15.5C5.5 9.7 10.2 5 16 5C21.8 5 26.5 9.7 26.5 15.5C26.5 16.6 25.6 17.5 24.5 17.5H7.5C6.4 17.5 5.5 16.6 5.5 15.5Z"
        fill="url(#cortexBell)"
      />

      {/* 飘动触手 */}
      <g stroke="url(#cortexBell)" strokeWidth="2" strokeLinecap="round">
        <path d="M9.5 18C9 21 10 24 8.8 27" />
        <path d="M13.2 18.2C13 21.5 13.6 24 12.6 27.5" />
        <path d="M16 18.3C16 22 16 24.5 16 28" />
        <path d="M18.8 18.2C19 21.5 18.4 24 19.4 27.5" />
        <path d="M22.5 18C23 21 22 24 23.2 27" />
      </g>

      {/* 伞盖上的发光白点（神经元意象） */}
      <g fill="#ffffff">
        <circle cx="13" cy="10.5" r="1" />
        <circle cx="17.5" cy="9.2" r="1.1" />
        <circle cx="20" cy="12" r="0.9" />
        <circle cx="14.6" cy="13.2" r="0.8" />
      </g>
    </svg>
  );
}

/**
 * 品牌标：水母小标 + 可选「Cortex」文字。
 * @param withWord 是否显示文字（默认 true）；为 false 时仅渲染纯标。
 */
export function BrandMark({ withWord = true }: { withWord?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        lineHeight: 1,
      }}
    >
      <JellyMark />
      {withWord && (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: "1.18rem",
            letterSpacing: "-0.01em",
            color: "var(--ink)",
          }}
        >
          Cortex
        </span>
      )}
    </span>
  );
}
