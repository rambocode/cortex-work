// 全局热键(globalShortcut)注册结果 → 降级状态的纯函数。把「register 返回值」与
// 「降级标记 + 用户提示文案」解耦,便于单测;globalShortcut 本身的系统行为(实际唤起/
// 占用冲突)属人工验证。仿 logger.ts 等可测纯模块,不 import electron。

// 默认闪记热键键位(契约 8.5 / 待解问题 5)。register 与降级判定共用此常量,避免漂移。
export const NOTES_HOTKEY_ACCELERATOR = "CommandOrControl+Shift+N";

// register 失败(被占用)时给用户的提示文案。降级到仅窗口图标入口仍可用。
export const NOTES_HOTKEY_OCCUPIED_TOAST = "闪记热键被占用,改用窗口图标入口";

export interface HotkeyRegistration {
  // register 是否成功(true = 热键可用;false = 被占用,已降级)。
  registered: boolean;
  // 是否进入降级态(仅窗口图标入口可用)。
  degraded: boolean;
  // 降级时给用户的提示文案;未降级为 undefined。
  toast?: string;
}

// globalShortcut.register 返回值 → 降级状态。ok=true 无降级;ok=false 降级且带提示。
export function resolveHotkeyRegistration(ok: boolean): HotkeyRegistration {
  if (ok) return { registered: true, degraded: false };
  return { registered: false, degraded: true, toast: NOTES_HOTKEY_OCCUPIED_TOAST };
}
