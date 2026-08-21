// LoginGate（W1）的纯逻辑：登录步骤状态机 + slug 派生 + 输入校验。抽出便于就近单测，
// 组件只做副作用编排（fetch / 倒计时 / 渲染）。

// 登录流程线性状态机：填服务器与邮箱 → 输验证码 → 选/建工作区。
export const AUTH_STEPS = ["server", "code", "workspace"] as const;
export type AuthStep = (typeof AUTH_STEPS)[number];

// 前进一步（末步返回自身，避免越界）。索引经 clamp 后必在界内，故断言非空。
export function nextAuthStep(step: AuthStep): AuthStep {
  const i = AUTH_STEPS.indexOf(step);
  return AUTH_STEPS[Math.min(i + 1, AUTH_STEPS.length - 1)]!;
}

// 后退一步（首步返回自身），供「返回上一步」用。索引经 clamp 后必在界内，故断言非空。
export function prevAuthStep(step: AuthStep): AuthStep {
  const i = AUTH_STEPS.indexOf(step);
  return AUTH_STEPS[Math.max(i - 1, 0)]!;
}

// 从团队名派生 slug：转小写、空白折叠为连字符、剔除非 [a-z0-9-] 字符、去重复与首尾连字符。
// 服务端契约要求 slug 为「小写字母数字连字符」。中文等非 ASCII 无法映射为字母数字 → 被剔除，
// 故纯中文名会派生出空串，UI 需据此提示用户手填（deriveSlug 只做机械转换，不兜底占位）。
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// slug 合法性：非空且只含小写字母数字连字符（与服务端 409 前的前端预校验一致）。
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

// 邮箱粗校验（仅拦明显非法，真正校验以服务端为准）。
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// 验证码为 6 位数字。
export function isValidCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

// 规范化服务器地址：去首尾空白与结尾斜杠（避免拼接出 //auth/send-code）。
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
