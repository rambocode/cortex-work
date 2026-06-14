// 个人工作区内置头像:10 套扁平 SVG（仿 pet/designs 的内联 SVG 范式）。
// 每个头像自带背景色,viewBox 0 0 64 64 满幅绘制;放进圆形 .m-avatar 容器
// （overflow:hidden + border-radius:50%）即裁成圆头像。id 与 core 的
// BUILTIN_AVATAR_IDS 逐一对应（avatars.test.ts 交叉校验）。

import type { ReactNode } from "react";
import { BUILTIN_AVATAR_IDS, type BuiltinAvatarId } from "@cortex-work/core";

const OUTLINE = "#3a352c";

// 统一外框:满幅背景 + 细描边的子元素绘制区。
function Frame({ bg, children }: { bg: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
      <rect width="64" height="64" fill={bg} />
      {children}
    </svg>
  );
}

// 一对眼睛 + 可选高光（多数动物共用）。
function Eyes({ cx1 = 26, cx2 = 38, cy = 34, r = 3.2 }: { cx1?: number; cx2?: number; cy?: number; r?: number }) {
  return (
    <g fill={OUTLINE}>
      <circle cx={cx1} cy={cy} r={r} />
      <circle cx={cx2} cy={cy} r={r} />
    </g>
  );
}

const AVATARS: Record<BuiltinAvatarId, { name: string; bg: string; Svg: () => ReactNode }> = {
  fox: {
    name: "狐狸",
    bg: "#ef7d4e",
    Svg: () => (
      <Frame bg="#ef7d4e">
        <path d="M14 20 L24 34 L14 40 Z" fill="#d35f33" />
        <path d="M50 20 L40 34 L50 40 Z" fill="#d35f33" />
        <path d="M32 24 C20 24 18 36 22 44 C26 50 38 50 42 44 C46 36 44 24 32 24 Z" fill="#fbe6d6" />
        <path d="M32 52 L26 44 L38 44 Z" fill="#fff" />
        <Eyes />
        <circle cx="32" cy="44" r="2.4" fill={OUTLINE} />
      </Frame>
    ),
  },
  cat: {
    name: "猫",
    bg: "#8a8f99",
    Svg: () => (
      <Frame bg="#8a8f99">
        <path d="M16 18 L26 30 L16 32 Z" fill="#6e727b" />
        <path d="M48 18 L38 30 L48 32 Z" fill="#6e727b" />
        <circle cx="32" cy="36" r="16" fill="#c3c7cd" />
        <Eyes cy="34" />
        <path d="M32 38 l-2 3 h4 Z" fill={OUTLINE} />
        <g stroke={OUTLINE} strokeWidth="1.2" strokeLinecap="round">
          <path d="M22 41 h-8" />
          <path d="M42 41 h8" />
        </g>
      </Frame>
    ),
  },
  owl: {
    name: "猫头鹰",
    bg: "#2f9c95",
    Svg: () => (
      <Frame bg="#2f9c95">
        <path d="M32 16 C18 16 16 30 18 42 C20 52 44 52 46 42 C48 30 46 16 32 16 Z" fill="#1f6f6a" />
        <circle cx="25" cy="32" r="8" fill="#fbe6d6" />
        <circle cx="39" cy="32" r="8" fill="#fbe6d6" />
        <circle cx="25" cy="32" r="3.4" fill={OUTLINE} />
        <circle cx="39" cy="32" r="3.4" fill={OUTLINE} />
        <path d="M32 36 l-3 5 h6 Z" fill="#f2a94e" />
      </Frame>
    ),
  },
  bear: {
    name: "熊",
    bg: "#a9714b",
    Svg: () => (
      <Frame bg="#a9714b">
        <circle cx="20" cy="22" r="7" fill="#8a5a39" />
        <circle cx="44" cy="22" r="7" fill="#8a5a39" />
        <circle cx="32" cy="36" r="16" fill="#c79468" />
        <Eyes cy="33" r="3" />
        <ellipse cx="32" cy="42" rx="6" ry="4.5" fill="#f0ddc8" />
        <circle cx="32" cy="40" r="2.2" fill={OUTLINE} />
      </Frame>
    ),
  },
  panda: {
    name: "熊猫",
    bg: "#5b6470",
    Svg: () => (
      <Frame bg="#5b6470">
        <circle cx="20" cy="22" r="6.5" fill={OUTLINE} />
        <circle cx="44" cy="22" r="6.5" fill={OUTLINE} />
        <circle cx="32" cy="36" r="16" fill="#fff" />
        <ellipse cx="25" cy="34" rx="4.5" ry="6" fill={OUTLINE} />
        <ellipse cx="39" cy="34" rx="4.5" ry="6" fill={OUTLINE} />
        <circle cx="25" cy="34" r="2" fill="#fff" />
        <circle cx="39" cy="34" r="2" fill="#fff" />
        <circle cx="32" cy="43" r="2.2" fill={OUTLINE} />
      </Frame>
    ),
  },
  rabbit: {
    name: "兔子",
    bg: "#e88aa6",
    Svg: () => (
      <Frame bg="#e88aa6">
        <ellipse cx="26" cy="18" rx="4.5" ry="12" fill="#f6cdd9" />
        <ellipse cx="38" cy="18" rx="4.5" ry="12" fill="#f6cdd9" />
        <circle cx="32" cy="38" r="15" fill="#fff" />
        <Eyes cy="36" />
        <path d="M32 41 l-2 3 h4 Z" fill="#d4607f" />
      </Frame>
    ),
  },
  penguin: {
    name: "企鹅",
    bg: "#2b3a55",
    Svg: () => (
      <Frame bg="#2b3a55">
        <ellipse cx="32" cy="36" rx="16" ry="18" fill={OUTLINE} />
        <ellipse cx="32" cy="40" rx="9" ry="13" fill="#fff" />
        <Eyes cx1="27" cx2="37" cy="28" r="2.6" />
        <path d="M32 31 l-4 4 h8 Z" fill="#f2a94e" />
      </Frame>
    ),
  },
  koala: {
    name: "考拉",
    bg: "#9aa0a6",
    Svg: () => (
      <Frame bg="#9aa0a6">
        <circle cx="18" cy="28" r="9" fill="#bfc4c9" />
        <circle cx="46" cy="28" r="9" fill="#bfc4c9" />
        <circle cx="32" cy="36" r="15" fill="#d7dade" />
        <Eyes cy="34" r="2.8" />
        <ellipse cx="32" cy="43" rx="5.5" ry="7" fill="#6e727b" />
      </Frame>
    ),
  },
  frog: {
    name: "青蛙",
    bg: "#4caf76",
    Svg: () => (
      <Frame bg="#4caf76">
        <circle cx="23" cy="22" r="8" fill="#6cc790" />
        <circle cx="41" cy="22" r="8" fill="#6cc790" />
        <circle cx="23" cy="22" r="3.4" fill={OUTLINE} />
        <circle cx="41" cy="22" r="3.4" fill={OUTLINE} />
        <path d="M16 34 C16 46 48 46 48 34 L48 40 C48 50 16 50 16 40 Z" fill="#3c9462" />
        <path d="M24 44 q8 6 16 0" fill="none" stroke={OUTLINE} strokeWidth="2" strokeLinecap="round" />
      </Frame>
    ),
  },
  robot: {
    name: "机器人",
    bg: "#3b82c4",
    Svg: () => (
      <Frame bg="#3b82c4">
        <line x1="32" y1="10" x2="32" y2="18" stroke="#cde2f5" strokeWidth="2.4" />
        <circle cx="32" cy="9" r="3" fill="#cde2f5" />
        <rect x="18" y="20" width="28" height="24" rx="6" fill="#cde2f5" />
        <rect x="24" y="29" width="6" height="6" rx="1.5" fill={OUTLINE} />
        <rect x="34" y="29" width="6" height="6" rx="1.5" fill={OUTLINE} />
        <rect x="26" y="39" width="12" height="2.4" rx="1.2" fill="#7aa7cf" />
      </Frame>
    ),
  },
};

export interface BuiltinAvatar {
  id: BuiltinAvatarId;
  name: string;
  bg: string;
  Svg: () => ReactNode;
}

// 设置页网格按此顺序渲染（与 core BUILTIN_AVATAR_IDS 同序）。
export const BUILTIN_AVATARS: BuiltinAvatar[] = BUILTIN_AVATAR_IDS.map((id) => ({
  id,
  name: AVATARS[id].name,
  bg: AVATARS[id].bg,
  Svg: AVATARS[id].Svg,
}));

// 按 id 渲染内置头像 SVG;未知 id 返回 null（调用方回退首字母）。
export function renderAvatar(avatarId: string | undefined | null): ReactNode | null {
  if (!avatarId) return null;
  const entry = (AVATARS as Record<string, { Svg: () => ReactNode } | undefined>)[avatarId];
  return entry ? entry.Svg() : null;
}
