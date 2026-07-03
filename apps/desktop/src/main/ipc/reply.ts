// 快捷回复助手（reply）IPC 域 —— U5 骨架。
//
// 本文件只搭「渲染端 → 主进程」的通道形状，返回空实现 / 内存 stub；真正的原生能力
// （权限查询、渠道 fetch + safeStorage 加密、调试环形缓冲、起草触发、设置快照消费）
// 由 U7（controller / debug-log / draft-generator）与 U9（渠道校验 fetch）填实。
//
// 通道命名与 preload personal.reply* / DesktopBridge 的 reply* 方法一一对应。
// 仿 ipc/notification-window.ts 的注册风格（一个 registerXxxHandlers 收口）。

import { ipcMain } from "electron";
import type {
  ChannelId,
  ReplyChannelVerifyResult,
  ReplyDebugEntry,
  ReplyPermissionKind,
  ReplyPermissionState,
  ReplySyncSnapshot,
} from "./reply-types";
import { UNKNOWN_REPLY_PERMISSIONS } from "./reply-types";

// U5 stub：设置快照最近值只驻内存（进程退出即弃）。U7 draft-generator 会从此处读默认 agent。
let lastSyncedSnapshot: ReplySyncSnapshot | null = null;

/// 供 U7 controller 读取渲染端最近推送的设置快照（默认 agent / 记忆 / 触发键）。
export function getLastReplySnapshot(): ReplySyncSnapshot | null {
  return lastSyncedSnapshot;
}

/// 注册 reply IPC 域。U5 为骨架：全部返回安全默认，不触碰任何原生能力。
export function registerReplyHandlers(): void {
  // 权限查询：U5 一律回「未知」，U4/U7 接 node-mac-permissions + helper permissions 命令后返回真实态。
  ipcMain.handle("reply:getPermissions", (): ReplyPermissionState => UNKNOWN_REPLY_PERMISSIONS);

  // 打开系统权限设置面板：U5 空实现，U9 接 shell.openExternal("x-apple.systempreferences:...")。
  ipcMain.handle("reply:openPermissionSettings", (_e, _kind: ReplyPermissionKind): void => {
    // no-op（U9 填实）
  });

  // 渠道凭据校验：U5 返回未实现失败，U9 接 U2 纯函数构造请求 → fetch → 解析 → safeStorage 加密。
  ipcMain.handle(
    "reply:verifyChannel",
    (_e, _channelId: ChannelId, _token: string): ReplyChannelVerifyResult => ({
      ok: false,
      errorKind: "invalidResponse",
      errorDetail: "not-implemented",
    }),
  );

  // 断开渠道：U5 空实现，U9 清除 safeStorage 密文。
  ipcMain.handle("reply:disconnectChannel", (_e, _channelId: ChannelId): void => {
    // no-op（U9 填实）
  });

  // 调试记录：U5 返回空数组，U7 接环形缓冲（最近 20 条，仅内存）。
  ipcMain.handle("reply:getDebugLog", (): ReplyDebugEntry[] => []);

  // 手动触发起草：U5 空实现，U7 接 controller.startDraftSession（兜底 accelerator / 调试入口）。
  ipcMain.handle("reply:triggerDraft", (): void => {
    // no-op（U7 填实）
  });

  // 设置快照推送：U5 仅缓存最近值供 U7 读取；不做副作用。
  ipcMain.handle("reply:syncSettings", (_e, snapshot: ReplySyncSnapshot): void => {
    lastSyncedSnapshot = snapshot;
  });
}
