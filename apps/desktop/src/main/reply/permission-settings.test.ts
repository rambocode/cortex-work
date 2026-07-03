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
});
