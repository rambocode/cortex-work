// 个人工作区内置头像 id 清单（纯数据,无 JSX —— core 不依赖 react-dom）。
// SVG 渲染映射在 views 层（packages/views/cortex-desktop/personal/avatars.tsx）,
// 两侧 id 必须逐一对应,由测试交叉守护。

export const BUILTIN_AVATAR_IDS = [
  "fox",
  "cat",
  "owl",
  "bear",
  "panda",
  "rabbit",
  "penguin",
  "koala",
  "frog",
  "robot",
] as const;

export type BuiltinAvatarId = (typeof BUILTIN_AVATAR_IDS)[number];

// 设置页未选时的建议默认（用户首次进入个人资料时高亮）。
export const DEFAULT_AVATAR_ID: BuiltinAvatarId = "fox";

export function isBuiltinAvatarId(id: string | undefined | null): id is BuiltinAvatarId {
  return !!id && (BUILTIN_AVATAR_IDS as readonly string[]).includes(id);
}
