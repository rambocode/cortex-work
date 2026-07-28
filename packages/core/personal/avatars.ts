// 个人工作区头像模型(纯数据 + 纯函数,无 JSX —— core 不依赖 react-dom)。
// 新设计为「背景色 + 图标(用户名首字符 / Emoji)」,旧内置 SVG 头像已废弃,
// 仅保留 LEGACY_AVATAR_EMOJI_MAP 供旧存档迁移读取(见 migrateProfile)。

import type { PersonalProfile } from "../desktop/types";

// 头像可选背景色:饱和色(Tailwind 500 档),与 agent 头像(Claude #c96442 / Pi #4338ca)
// 同档深度,白字可读;pastel 档实测白字/深字都不清楚,已废弃(旧值由 migrateProfile 升级)。
export const AVATAR_BG_COLORS = [
  "#22c55e",
  "#ec4899",
  "#8b5cf6",
  "#ca8a04",
  "#f97316",
  "#14b8a6",
  "#3b82f6",
  "#6b7280",
  "#64748b",
  "#a855f7",
  "#10b981",
] as const;

// 头像可选 emoji 清单(设置页图标选择器的数据源)。
export const AVATAR_EMOJIS: string[] = [
  "🐱", "🐶", "🦊", "🐻", "🐼", "🐨", "🦁", "🐸", "🐵", "🦉",
  "🦋", "🐙", "⭐", "🌙", "☀️", "🌈", "⚡", "🎯", "🚀", "💡",
  "🎨", "🎮", "📚", "☕", "🐧", "🐰", "🐢", "🦆", "🐝", "🦄",
  "🦒", "🍄", "🌻", "🪴", "✈️", "🏛️", "🎸", "🎬", "📷", "🎤",
  "🥁", "🧩", "🚲", "🍕", "🍜", "🧁", "🍦", "⚽", "🏀", "🎾",
  "🏓", "🧸", "🎁", "👾", "🤖", "⛰️", "🌋", "🎪", "🔭", "💎",
  "🧠",
];

// 未自定义时的默认 emoji 与背景色。
export const DEFAULT_AVATAR_EMOJI = "🐼";
export const DEFAULT_AVATAR_BG = AVATAR_BG_COLORS[0];

// 历史 pastel 色板(100 档与 200 档两代)→ 现行饱和色板,按索引一一对应。
// 用户存档里可能仍存着 pastel 值(已不在色板中),随 hydrate 升级到同位置的新色,
// 否则旧值会永远残留、设置页也没有任何色块呈现选中态。
const LEGACY_BG_MAP: Record<string, string> = Object.fromEntries(
  [
    "#DCFCE7", "#FCE7F3", "#EDE9FE", "#FEF3C7", "#FFEDD5", "#CCFBF1",
    "#DBEAFE", "#E5E7EB", "#E2E8F0", "#F3E8FF", "#F0FDF4",
    "#BBF7D0", "#FBCFE8", "#DDD6FE", "#FDE68A", "#FED7AA", "#99F6E4",
    "#BFDBFE", "#D1D5DB", "#CBD5E1", "#E9D5FF", "#A7F3D0",
  ].map((old, i) => [old, AVATAR_BG_COLORS[i % AVATAR_BG_COLORS.length]!]), // 取模后必在界内
);

// 旧内置 SVG 头像 id → emoji 的一一映射,仅旧存档迁移消费,渲染层不再使用。
export const LEGACY_AVATAR_EMOJI_MAP: Record<string, string> = {
  fox: "🦊",
  cat: "🐱",
  owl: "🦉",
  bear: "🐻",
  panda: "🐼",
  rabbit: "🐰",
  penguin: "🐧",
  koala: "🐨",
  frog: "🐸",
  robot: "🤖",
};

// 旧存档迁移,两类历史数据都在这里升级:
// 1. avatarId(旧内置 SVG 头像)→ emoji 模式 + 对应 emoji,未知 id 回退默认 🐼;
// 2. pastel 档 avatarBg → 同索引的饱和色(pastel 已废弃,白字/深字都不清楚)。
// 两者皆无说明已是新档,原样返回。
export function migrateProfile(p: PersonalProfile): PersonalProfile {
  const bg = p.avatarBg ? (LEGACY_BG_MAP[p.avatarBg] ?? p.avatarBg) : p.avatarBg;
  if (!p.avatarId) {
    return bg === p.avatarBg ? p : { ...p, avatarBg: bg };
  }
  // 用 delete 去掉 avatarId:存档不再保留旧字段,避免下次启动重复走迁移分支。
  const rest = { ...p, avatarBg: bg };
  delete rest.avatarId;
  return {
    ...rest,
    avatarMode: "emoji",
    avatarEmoji: LEGACY_AVATAR_EMOJI_MAP[p.avatarId] ?? DEFAULT_AVATAR_EMOJI,
  };
}

// 头像渲染参数解析:为缺省字段套用默认值,渲染层只消费这一个出口。
export function resolveAvatar(p?: PersonalProfile): { mode: "initials" | "emoji"; emoji: string; bg: string } {
  return {
    mode: p?.avatarMode ?? "emoji",
    emoji: p?.avatarEmoji ?? DEFAULT_AVATAR_EMOJI,
    bg: p?.avatarBg ?? DEFAULT_AVATAR_BG,
  };
}

// 昵称首字符(initials 模式的图标):拉丁字母转大写,空白/缺省回退「我」。
export function profileInitial(nickname?: string): string {
  const first = nickname?.trim().charAt(0);
  if (!first) return "我";
  return first.toUpperCase();
}
