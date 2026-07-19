// 个人工作区内置头像:10 套精致卡通 SVG（与 pet/designs 同源的内联 SVG 范式:
// 统一描边 #4a3f30、分层眼睛 = 白眼窝 + 虹膜 + 瞳孔 + 双高光、腮红点缀）。
// 每个头像自带背景色,viewBox 0 0 64 64 满幅绘制;放进圆形 .m-avatar 容器
// （overflow:hidden + border-radius:50%）即裁成圆头像。id 与 core 的
// BUILTIN_AVATAR_IDS 逐一对应（avatars.test.ts 交叉校验）。

import type { ReactNode } from "react";
import { BUILTIN_AVATAR_IDS, type BuiltinAvatarId } from "@cortex-work/core";

const OUTLINE = "#4a3f30";
const IRIS_EDGE = "#2e241a";
const PUPIL = "#1c1812";

// 统一外框:满幅背景 + 描边卡通造型的绘制区。
function Frame({ bg, children }: { bg: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
      <rect width="64" height="64" fill={bg} />
      {children}
    </svg>
  );
}

// 分层卡通眼:白色眼窝 + 虹膜(深色缘) + 瞳孔 + 主高光/下侧反光。
function Eyes({
  cx1 = 26,
  cx2 = 38,
  cy = 34,
  r = 3.4,
  iris = "#6b4a2c",
}: {
  cx1?: number | string;
  cx2?: number | string;
  cy?: number | string;
  r?: number | string;
  iris?: string;
}) {
  const x1 = Number(cx1);
  const x2 = Number(cx2);
  const y = Number(cy);
  const rr = Number(r);
  return (
    <g>
      <circle cx={x1} cy={y} r={rr + 0.9} fill="#fff" stroke={OUTLINE} strokeWidth="1.1" />
      <circle cx={x2} cy={y} r={rr + 0.9} fill="#fff" stroke={OUTLINE} strokeWidth="1.1" />
      <circle cx={x1} cy={y + 0.3} r={rr * 0.72} fill={iris} stroke={IRIS_EDGE} strokeWidth="0.7" />
      <circle cx={x2} cy={y + 0.3} r={rr * 0.72} fill={iris} stroke={IRIS_EDGE} strokeWidth="0.7" />
      <circle cx={x1} cy={y + 0.5} r={rr * 0.38} fill={PUPIL} />
      <circle cx={x2} cy={y + 0.5} r={rr * 0.38} fill={PUPIL} />
      <circle cx={x1 + rr * 0.26} cy={y - rr * 0.22} r={rr * 0.2} fill="#fff" />
      <circle cx={x2 + rr * 0.26} cy={y - rr * 0.22} r={rr * 0.2} fill="#fff" />
      <circle cx={x1 - rr * 0.24} cy={y + rr * 0.42} r={rr * 0.11} fill="#fff" opacity="0.75" />
      <circle cx={x2 - rr * 0.24} cy={y + rr * 0.42} r={rr * 0.11} fill="#fff" opacity="0.75" />
    </g>
  );
}

// 腮红:两团柔和的椭圆。
function Blush({ cx1 = 21.5, cx2 = 42.5, cy = 40, fill = "#f2a08c" }: {
  cx1?: number;
  cx2?: number;
  cy?: number;
  fill?: string;
}) {
  return (
    <g fill={fill} opacity="0.55">
      <ellipse cx={cx1} cy={cy} rx="2.6" ry="1.7" />
      <ellipse cx={cx2} cy={cy} rx="2.6" ry="1.7" />
    </g>
  );
}

const AVATARS: Record<BuiltinAvatarId, { name: string; bg: string; Svg: () => ReactNode }> = {
  fox: {
    name: "狐狸",
    bg: "#ef7d4e",
    Svg: () => (
      <Frame bg="#ef7d4e">
        {/* 尖耳:外深橙 + 内奶油 */}
        <path d="M13 16 L25 32 L11 34 Z" fill="#d35f33" stroke={OUTLINE} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M51 16 L39 32 L53 34 Z" fill="#d35f33" stroke={OUTLINE} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M16 22 L22 30 L15 30.5 Z" fill="#fbe6d6" />
        <path d="M48 22 L42 30 L49 30.5 Z" fill="#fbe6d6" />
        {/* 奶油脸 + 橙色刘海 */}
        <circle cx="32" cy="36" r="16" fill="#fbe6d6" stroke={OUTLINE} strokeWidth="1.6" />
        <path d="M18 30 Q32 19 46 30 Q44 22 32 21 Q20 22 18 30 Z" fill="#f0935c" />
        <Blush cx1={22} cx2={42} cy={39.5} />
        <Eyes cy={33.5} iris="#7a4a26" />
        {/* 白色吻部 + 鼻 + 嘴 */}
        <ellipse cx="32" cy="43.5" rx="7" ry="5" fill="#fff" />
        <circle cx="32" cy="40.8" r="2.4" fill={OUTLINE} />
        <path d="M32 43.2 q0 2.4 -3 2.8 M32 43.2 q0 2.4 3 2.8" fill="none" stroke={OUTLINE} strokeWidth="1.2" strokeLinecap="round" />
      </Frame>
    ),
  },
  cat: {
    name: "猫",
    bg: "#8a8f99",
    Svg: () => (
      <Frame bg="#8a8f99">
        {/* 耳朵:外灰 + 内粉 */}
        <path d="M15 17 L26 29 L13 31 Z" fill="#6e727b" stroke={OUTLINE} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M49 17 L38 29 L51 31 Z" fill="#6e727b" stroke={OUTLINE} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M17.5 21.5 L23 27.5 L16.5 28 Z" fill="#f4b8c1" />
        <path d="M46.5 21.5 L41 27.5 L47.5 28 Z" fill="#f4b8c1" />
        <circle cx="32" cy="36" r="16" fill="#c3c7cd" stroke={OUTLINE} strokeWidth="1.6" />
        {/* 额头条纹 */}
        <g stroke="#9aa0a8" strokeWidth="1.4" strokeLinecap="round">
          <path d="M28 23.5 v4" />
          <path d="M32 22.5 v4.5" />
          <path d="M36 23.5 v4" />
        </g>
        <Blush cx1={22} cx2={42} cy={40} fill="#f4a6b0" />
        <Eyes cy={33} iris="#3f7d5a" />
        <path d="M32 38.2 l-2.2 2.8 h4.4 Z" fill="#e89aa8" stroke={OUTLINE} strokeWidth="0.9" strokeLinejoin="round" />
        <path d="M32 41 q0 2 -2.6 2.4 M32 41 q0 2 2.6 2.4" fill="none" stroke={OUTLINE} strokeWidth="1.2" strokeLinecap="round" />
        {/* 胡须 */}
        <g stroke={OUTLINE} strokeWidth="1.1" strokeLinecap="round" opacity="0.8">
          <path d="M21 38.5 h-8" />
          <path d="M21.5 41 l-7.5 2" />
          <path d="M43 38.5 h8" />
          <path d="M42.5 41 l7.5 2" />
        </g>
      </Frame>
    ),
  },
  owl: {
    name: "猫头鹰",
    bg: "#2f9c95",
    Svg: () => (
      <Frame bg="#2f9c95">
        {/* 耳羽簇 */}
        <path d="M20 18 L17 11.5 L25.5 14.5 Z" fill="#1f6f6a" stroke={OUTLINE} strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M44 18 L47 11.5 L38.5 14.5 Z" fill="#1f6f6a" stroke={OUTLINE} strokeWidth="1.4" strokeLinejoin="round" />
        {/* 身体 */}
        <path d="M32 15 C17 15 15 31 17.5 43 C20 53 44 53 46.5 43 C49 31 47 15 32 15 Z" fill="#1f6f6a" stroke={OUTLINE} strokeWidth="1.6" strokeLinejoin="round" />
        <ellipse cx="32" cy="44.5" rx="8" ry="6.5" fill="#f3e3cf" />
        {/* 大眼盘 */}
        <circle cx="24.5" cy="31" r="9" fill="#fbe6d6" stroke={OUTLINE} strokeWidth="1.4" />
        <circle cx="39.5" cy="31" r="9" fill="#fbe6d6" stroke={OUTLINE} strokeWidth="1.4" />
        <Eyes cx1={24.5} cx2={39.5} cy={30.5} r={4.2} iris="#b5803c" />
        <path d="M32 35.5 l-3 4.5 h6 Z" fill="#f2a94e" stroke={OUTLINE} strokeWidth="1" strokeLinejoin="round" />
      </Frame>
    ),
  },
  bear: {
    name: "熊",
    bg: "#a9714b",
    Svg: () => (
      <Frame bg="#a9714b">
        {/* 圆耳:外深棕 + 内浅 */}
        <circle cx="19" cy="21" r="7.5" fill="#8a5a39" stroke={OUTLINE} strokeWidth="1.6" />
        <circle cx="45" cy="21" r="7.5" fill="#8a5a39" stroke={OUTLINE} strokeWidth="1.6" />
        <circle cx="19" cy="21" r="3.6" fill="#c79468" />
        <circle cx="45" cy="21" r="3.6" fill="#c79468" />
        <circle cx="32" cy="37" r="16" fill="#c79468" stroke={OUTLINE} strokeWidth="1.6" />
        <Blush cx1={22} cx2={42} cy={38.5} />
        <Eyes cx1={25.5} cx2={38.5} cy={32.5} iris="#4a3524" />
        {/* 奶油口鼻 + 鼻 + 嘴 */}
        <ellipse cx="32" cy="43" rx="6.5" ry="4.8" fill="#f0ddc8" />
        <ellipse cx="32" cy="40.6" rx="2.8" ry="2.2" fill={OUTLINE} />
        <path d="M32 42.8 v1.8 M32 44.6 q-1 1.6 -3 1.7 M32 44.6 q1 1.6 3 1.7" fill="none" stroke={OUTLINE} strokeWidth="1.2" strokeLinecap="round" />
      </Frame>
    ),
  },
  panda: {
    name: "熊猫",
    bg: "#5b6470",
    Svg: () => (
      <Frame bg="#5b6470">
        <circle cx="19" cy="21" r="6.8" fill={OUTLINE} />
        <circle cx="45" cy="21" r="6.8" fill={OUTLINE} />
        <circle cx="32" cy="37" r="16" fill="#fff" stroke={OUTLINE} strokeWidth="1.6" />
        {/* 黑眼圈(略外旋) */}
        <ellipse cx="25" cy="33.5" rx="5" ry="6.4" fill={OUTLINE} transform="rotate(-12 25 33.5)" />
        <ellipse cx="39" cy="33.5" rx="5" ry="6.4" fill={OUTLINE} transform="rotate(12 39 33.5)" />
        {/* 斑内眼睛:白底 + 瞳孔 + 高光 */}
        <circle cx="25.5" cy="33" r="2.6" fill="#fff" />
        <circle cx="38.5" cy="33" r="2.6" fill="#fff" />
        <circle cx="25.5" cy="33.3" r="1.4" fill={PUPIL} />
        <circle cx="38.5" cy="33.3" r="1.4" fill={PUPIL} />
        <circle cx="26.2" cy="32.4" r="0.55" fill="#fff" />
        <circle cx="39.2" cy="32.4" r="0.55" fill="#fff" />
        <Blush cx1={21.5} cx2={42.5} cy={41} fill="#f4b0a6" />
        <ellipse cx="32" cy="42.5" rx="2.6" ry="2" fill={OUTLINE} />
        <path d="M32 44.5 q0 2 -2.8 2.3 M32 44.5 q0 2 2.8 2.3" fill="none" stroke={OUTLINE} strokeWidth="1.2" strokeLinecap="round" />
      </Frame>
    ),
  },
  rabbit: {
    name: "兔子",
    bg: "#e88aa6",
    Svg: () => (
      <Frame bg="#e88aa6">
        {/* 长耳:外白 + 内粉,略外撇 */}
        <ellipse cx="25.5" cy="17" rx="4.6" ry="12" fill="#fff" stroke={OUTLINE} strokeWidth="1.5" transform="rotate(-6 25.5 17)" />
        <ellipse cx="38.5" cy="17" rx="4.6" ry="12" fill="#fff" stroke={OUTLINE} strokeWidth="1.5" transform="rotate(6 38.5 17)" />
        <ellipse cx="25.5" cy="18" rx="2.2" ry="8" fill="#f4b8c9" transform="rotate(-6 25.5 18)" />
        <ellipse cx="38.5" cy="18" rx="2.2" ry="8" fill="#f4b8c9" transform="rotate(6 38.5 18)" />
        <circle cx="32" cy="39" r="15" fill="#fff" stroke={OUTLINE} strokeWidth="1.6" />
        <Blush cx1={22.5} cx2={41.5} cy={42} fill="#f4a6b8" />
        <Eyes cy={36.5} iris="#6b3a4a" />
        <path d="M32 41.6 l-2 2.6 h4 Z" fill="#e87f9d" stroke={OUTLINE} strokeWidth="0.9" strokeLinejoin="round" />
        <path d="M32 44.2 v1.4" fill="none" stroke={OUTLINE} strokeWidth="1.1" strokeLinecap="round" />
        {/* 门牙 */}
        <rect x="30.2" y="45.6" width="3.6" height="3.2" rx="0.9" fill="#fff" stroke={OUTLINE} strokeWidth="0.9" />
        <path d="M32 45.6 v3.2" stroke={OUTLINE} strokeWidth="0.8" />
      </Frame>
    ),
  },
  penguin: {
    name: "企鹅",
    bg: "#2b3a55",
    Svg: () => (
      <Frame bg="#2b3a55">
        {/* 脚蹼(压在身下) */}
        <ellipse cx="24.5" cy="52.5" rx="3.6" ry="2.1" fill="#f2a94e" stroke={OUTLINE} strokeWidth="0.9" />
        <ellipse cx="39.5" cy="52.5" rx="3.6" ry="2.1" fill="#f2a94e" stroke={OUTLINE} strokeWidth="0.9" />
        {/* 深色身体 */}
        <ellipse cx="32" cy="35" rx="16.5" ry="18.5" fill="#26221c" stroke={OUTLINE} strokeWidth="1.6" />
        {/* 白脸 + 白肚 */}
        <ellipse cx="32" cy="31.5" rx="10.5" ry="9" fill="#fff" />
        <ellipse cx="32" cy="44" rx="8" ry="9.5" fill="#fff" />
        <Eyes cx1={27} cx2={37} cy={29.5} r={3} iris="#3a2c1c" />
        <path d="M32 33 l-4 3.5 q4 2.5 8 0 Z" fill="#f2a94e" stroke={OUTLINE} strokeWidth="1" strokeLinejoin="round" />
      </Frame>
    ),
  },
  koala: {
    name: "考拉",
    bg: "#9aa0a6",
    Svg: () => (
      <Frame bg="#9aa0a6">
        {/* 大绒耳:外灰 + 内浅绒 */}
        <circle cx="17" cy="27" r="9.5" fill="#bfc4c9" stroke={OUTLINE} strokeWidth="1.6" />
        <circle cx="47" cy="27" r="9.5" fill="#bfc4c9" stroke={OUTLINE} strokeWidth="1.6" />
        <circle cx="17" cy="27" r="5" fill="#eef1f3" />
        <circle cx="47" cy="27" r="5" fill="#eef1f3" />
        <circle cx="32" cy="37" r="15.5" fill="#d7dade" stroke={OUTLINE} strokeWidth="1.6" />
        <Blush cx1={21.5} cx2={42.5} cy={39.5} fill="#f4a6a0" />
        <Eyes cx1={25.5} cx2={38.5} cy={32.5} r={3.2} iris="#4a4038" />
        {/* 标志性大鼻子 + 高光 */}
        <ellipse cx="32" cy="41.5" rx="4.6" ry="5.6" fill="#6e727b" stroke={OUTLINE} strokeWidth="1.2" />
        <ellipse cx="30.8" cy="39.4" rx="1.4" ry="1.8" fill="#9aa0a6" />
        <path d="M32 47.4 q0 2 -2.6 2.3 M32 47.4 q0 2 2.6 2.3" fill="none" stroke={OUTLINE} strokeWidth="1.2" strokeLinecap="round" />
      </Frame>
    ),
  },
  frog: {
    name: "青蛙",
    bg: "#4caf76",
    Svg: () => (
      <Frame bg="#4caf76">
        {/* 头身一体 */}
        <ellipse cx="32" cy="39" rx="18" ry="14" fill="#57b981" stroke={OUTLINE} strokeWidth="1.6" />
        {/* 头顶眼凸 */}
        <circle cx="23" cy="24" r="8.5" fill="#57b981" stroke={OUTLINE} strokeWidth="1.6" />
        <circle cx="41" cy="24" r="8.5" fill="#57b981" stroke={OUTLINE} strokeWidth="1.6" />
        <Eyes cx1={23} cx2={41} cy={23} r={4} iris="#4d7c3a" />
        {/* 鼻孔 + 大嘴微笑 */}
        <circle cx="29" cy="35.5" r="0.9" fill={OUTLINE} opacity="0.6" />
        <circle cx="35" cy="35.5" r="0.9" fill={OUTLINE} opacity="0.6" />
        <Blush cx1={17} cx2={47} cy={41.5} />
        <path d="M22 42 q10 8 20 0" fill="none" stroke={OUTLINE} strokeWidth="2.2" strokeLinecap="round" />
      </Frame>
    ),
  },
  robot: {
    name: "机器人",
    bg: "#3b82c4",
    Svg: () => (
      <Frame bg="#3b82c4">
        {/* 天线 */}
        <line x1="32" y1="9.5" x2="32" y2="17" stroke={OUTLINE} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="32" cy="7.5" r="3.2" fill="#f2a94e" stroke={OUTLINE} strokeWidth="1.2" />
        {/* 头部圆角机箱 + 两侧螺栓耳 */}
        <rect x="12.5" y="28" width="3.5" height="9" rx="1.5" fill="#9dc3e4" stroke={OUTLINE} strokeWidth="1" />
        <rect x="48" y="28" width="3.5" height="9" rx="1.5" fill="#9dc3e4" stroke={OUTLINE} strokeWidth="1" />
        <rect x="16" y="17" width="32" height="28" rx="7" fill="#cde2f5" stroke={OUTLINE} strokeWidth="1.8" />
        {/* 深色面屏 + 发光眼(带高光) */}
        <rect x="21" y="23" width="22" height="13" rx="4" fill="#26221c" />
        <circle cx="27.5" cy="29.5" r="2.8" fill="#7dd3fc" />
        <circle cx="36.5" cy="29.5" r="2.8" fill="#7dd3fc" />
        <circle cx="28.3" cy="28.7" r="0.8" fill="#fff" />
        <circle cx="37.3" cy="28.7" r="0.8" fill="#fff" />
        <Blush cx1={21.5} cx2={42.5} cy={40} fill="#f4a6a0" />
        {/* 格栅嘴 */}
        <rect x="26" y="39.5" width="12" height="2.6" rx="1.3" fill="#8fb8d9" stroke={OUTLINE} strokeWidth="0.8" />
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
