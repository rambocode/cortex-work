import type { ReplyPermissionKind } from "../ipc/reply-types";

// 五项权限逐一映射到系统设置「隐私与安全性」对应子页。notDetermined 时必须先触发 TCC 请求，
// 否则日历/语音识别等列表里不会出现 Cortex；请求不可用或已拒绝时再回退到这些面板。
export const PERMISSION_SETTINGS_URL: Record<ReplyPermissionKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  calendar: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  speechRecognition: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
};

export interface OpenReplyPermissionSettingsDeps {
  requestAccess: (kind: ReplyPermissionKind) => Promise<boolean>;
  openExternal: (url: string) => Promise<unknown>;
}

// 「必须无条件打开设置面板」的两项。
//
// 与日历/麦克风/语音识别不同,macOS **不提供**这两项的应用内授权弹窗:
// AXIsProcessTrustedWithOptions / CGRequestScreenCaptureAccess 的作用只是把本应用注册进
// TCC 列表（外加一次系统提示），真正的开关必须用户自己到 系统设置 里手动勾选。
// 而那次系统提示**每个应用只出现一次**,之后再调用就静默 no-op、并且照样返回 true。
//
// 于是「requestAccess 返回 true 就不开面板」对这两项是错的:第一次点或许能看到提示,
// 第二次点开始就彻底没有任何反应——用户报的正是「点了去授权没响应」。
// 正确做法是先请求（完成自注册,让应用出现在列表里）,然后**无条件**把面板打开。
const ALWAYS_OPEN_PANEL: ReadonlySet<ReplyPermissionKind> = new Set<ReplyPermissionKind>([
  "accessibility",
  "screenRecording",
]);

export async function openReplyPermissionSettings(
  kind: ReplyPermissionKind,
  deps: OpenReplyPermissionSettingsDeps,
): Promise<void> {
  const requested = await deps.requestAccess(kind);
  // 日历/麦克风/语音识别有真正的模态授权弹窗:系统已经接手时就别再叠一个设置窗口。
  if (requested && !ALWAYS_OPEN_PANEL.has(kind)) return;
  const url = PERMISSION_SETTINGS_URL[kind];
  if (url) await deps.openExternal(url);
}
