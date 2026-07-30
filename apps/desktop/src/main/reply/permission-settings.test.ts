import { describe, expect, it, vi } from "vitest";

import { openReplyPermissionSettings, PERMISSION_SETTINGS_URL } from "./permission-settings";

describe("openReplyPermissionSettings", () => {
  it("日历/语音识别先触发系统授权请求，请求已处理时不只打开空设置页", async () => {
    const requestAccess = vi.fn().mockResolvedValue(true);
    const openExternal = vi.fn();

    await openReplyPermissionSettings("calendar", { requestAccess, openExternal });
    await openReplyPermissionSettings("speechRecognition", { requestAccess, openExternal });

    expect(requestAccess).toHaveBeenNthCalledWith(1, "calendar");
    expect(requestAccess).toHaveBeenNthCalledWith(2, "speechRecognition");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("授权请求不可用或已拒绝时回退打开对应系统设置页", async () => {
    const requestAccess = vi.fn().mockResolvedValue(false);
    const openExternal = vi.fn().mockResolvedValue(undefined);

    await openReplyPermissionSettings("speechRecognition", { requestAccess, openExternal });

    expect(openExternal).toHaveBeenCalledWith(PERMISSION_SETTINGS_URL.speechRecognition);
  });

  // 回归:辅助功能/屏幕录制没有应用内授权弹窗,且那次系统提示每个应用只出现一次、之后静默
  // no-op 却照样返回 true。若沿用「requestAccess 为 true 就不开面板」,第二次点击起按钮就
  // 彻底没反应（实际用户反馈:「点击去授权没有响应」）。故这两项必须无条件打开设置面板。
  it.each(["accessibility", "screenRecording"] as const)(
    "%s:即使 requestAccess 返回 true 也照样打开设置面板（否则按钮会变成死键）",
    async (kind) => {
      const requestAccess = vi.fn().mockResolvedValue(true);
      const openExternal = vi.fn().mockResolvedValue(undefined);

      await openReplyPermissionSettings(kind, { requestAccess, openExternal });

      // 仍要先请求:那一步负责把本应用自注册进 TCC 列表,否则设置面板里根本没有条目可勾。
      expect(requestAccess).toHaveBeenCalledWith(kind);
      expect(openExternal).toHaveBeenCalledWith(PERMISSION_SETTINGS_URL[kind]);
    },
  );

  it.each(["accessibility", "screenRecording"] as const)(
    "%s:requestAccess 返回 false 时同样打开设置面板",
    async (kind) => {
      const openExternal = vi.fn().mockResolvedValue(undefined);
      await openReplyPermissionSettings(kind, {
        requestAccess: vi.fn().mockResolvedValue(false),
        openExternal,
      });
      expect(openExternal).toHaveBeenCalledWith(PERMISSION_SETTINGS_URL[kind]);
    },
  );
});
