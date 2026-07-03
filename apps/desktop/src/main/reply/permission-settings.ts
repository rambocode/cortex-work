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

export async function openReplyPermissionSettings(
  kind: ReplyPermissionKind,
  deps: OpenReplyPermissionSettingsDeps,
): Promise<void> {
  if (await deps.requestAccess(kind)) return;
  const url = PERMISSION_SETTINGS_URL[kind];
  if (url) await deps.openExternal(url);
}
