// 团队成员/岗位标签纯逻辑（参照 IFocus 资源管理设置页）。
// 头像底色不落盘：由姓名 hash 稳定派生 0..5 索引，views 层映射到 6 个渐变类（同名恒同色）。
// 岗位标签库 jobTypes：undefined = 用默认表（刻意不 backfill 落盘，默认随 App 升级演进；
// 用户实际增删后才整表落盘固化，包括删空为 []）。纯函数无 IO，表驱动单测见 members.test.ts。

// 默认岗位/角色标签（对齐 IFocus）。
export const DEFAULT_JOB_TYPES: readonly string[] = Object.freeze([
  "开发",
  "设计",
  "产品",
  "测试",
  "运维",
  "项目经理",
]);

// 解析岗位标签库：undefined → 默认表副本（副本防调用方误改常量）；已定义（含空数组）原样返回。
export function resolveJobTypes(list?: string[]): string[] {
  return list === undefined ? [...DEFAULT_JOB_TYPES] : list;
}

// 头像色索引：对姓名做经典 djb2 变体 hash（char + (h<<5) - h），取 |h| % 6。
// 与 IFocus 同算法族——确定性（同名同色）、分布均匀即可，无密码学要求。
export const MEMBER_AVATAR_COLOR_COUNT = 6;
export function memberAvatarColorIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0; // 收敛到 32 位，防长名溢出为浮点丢确定性
  }
  return Math.abs(hash) % MEMBER_AVATAR_COLOR_COUNT;
}

// 成员输入校验：姓名必填。返回错误文案（zh-Hans）或 null（合法）。
export function validateMemberInput(input: { name: string }): string | null {
  if (!input.name.trim()) return "成员姓名不能为空";
  return null;
}
