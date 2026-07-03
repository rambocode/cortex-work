// 快捷回复助手（reply）IPC 域 —— U5 骨架。
//
// 本文件只搭「渲染端 → 主进程」的通道形状，返回空实现 / 内存 stub；真正的原生能力
// （权限查询、渠道 fetch + safeStorage 加密、调试环形缓冲、起草触发、设置快照消费）
// 由 U7（controller / debug-log / draft-generator）与 U9（渠道校验 fetch）填实。
//
// 通道命名与 preload personal.reply* / DesktopBridge 的 reply* 方法一一对应。
// 仿 ipc/notification-window.ts 的注册风格（一个 registerXxxHandlers 收口）。

import { ipcMain, safeStorage, shell } from "electron";
import type {
  ChannelId,
  ReplyBubbleAction,
  ReplyChannelVerifyResult,
  ReplyDebugEntry,
  ReplyPermissionKind,
  ReplyPermissionState,
  ReplySyncSnapshot,
} from "./reply-types";
import { UNKNOWN_REPLY_PERMISSIONS } from "./reply-types";
import { resizeReplyBubble, dispatchReplyBubbleAction } from "../reply/bubble-window";
// U7 controller 填实起草触发与调试记录读取（controller 单例不依赖本模块，单向引用无环）。
import { triggerReplyDraft, getReplyDebugEntries } from "../reply/controller";
// 渠道请求构造/响应解析纯函数在 core（app 可依赖 core，反向禁止）。
import type { ChannelRequest, VerifiedIdentity } from "@cortex-work/core/reply/channels";
import {
  makeSlackRequest,
  parseSlack,
  makeLarkRequest,
  parseLark,
  makeGoogleRequest,
  parseGoogle,
  ChannelVerifyError,
} from "@cortex-work/core/reply/channels";

// ── 权限设置面板 URL（源项目 PermissionCenter 的 x-apple.systempreferences 深链）──────
// 五项权限逐一映射到系统设置「隐私与安全性」对应子页，「去授权」按钮直达。
const PERMISSION_SETTINGS_URL: Record<ReplyPermissionKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  calendar: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  speechRecognition: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
};

// ── 渠道校验（构造请求 + 解析响应，纯函数在 core；此处只做网络往返与错误归一化）──────

/// 按渠道分派请求构造 + 响应解析器；不支持的渠道（日历类）返回 null。
function channelVerifier(
  channelId: ChannelId,
  token: string,
): { request: ChannelRequest; parse: (raw: string) => VerifiedIdentity } | null {
  switch (channelId) {
    case "slack":
      return { request: makeSlackRequest(token), parse: parseSlack };
    case "lark":
      return { request: makeLarkRequest(token), parse: parseLark };
    case "gmail":
      // Gmail 粘贴的是 Google access token → tokeninfo 校验（env 凭据流程见后续）。
      return { request: makeGoogleRequest(token), parse: parseGoogle };
    default:
      return null;
  }
}

/// 校验渠道凭据：core 构造请求 → main 侧 fetch → core 解析 → safeStorage 加密 token。
/// Slack/Lark 业务失败也返回 HTTP 200（读 ok/code 判定），故非 2xx 才归为 httpStatus（对齐源项目 send）。
async function verifyChannel(channelId: ChannelId, token: string): Promise<ReplyChannelVerifyResult> {
  const verifier = channelVerifier(channelId, token);
  if (!verifier) {
    return { ok: false, errorKind: "invalidResponse", errorDetail: "unsupported-channel" };
  }
  try {
    const { request, parse } = verifier;
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    // 非 2xx 先于解析抛 httpStatus（Slack/Lark 的业务错误走 200，不会落这里）。
    if (!res.ok) {
      throw new ChannelVerifyError("httpStatus", String(res.status));
    }
    const raw = await res.text();
    const identity = parse(raw);
    // 校验通过后加密 token；safeStorage 不可用（如无钥匙串）时密文置空，仅记连接态。
    const ciphertext = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token).toString("base64")
      : "";
    return {
      ok: true,
      accountName: identity.accountName,
      accountDetail: identity.accountDetail,
      ciphertext,
    };
  } catch (err) {
    if (err instanceof ChannelVerifyError) {
      return { ok: false, errorKind: err.kind, errorDetail: err.detail };
    }
    // 网络层异常（DNS/超时/离线）归为 httpStatus，携带原始信息便于诊断。
    return {
      ok: false,
      errorKind: "httpStatus",
      errorDetail: err instanceof Error ? err.message : "network-error",
    };
  }
}

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

  // 打开系统权限设置面板：直达对应隐私子页（授权引导）。
  ipcMain.handle("reply:openPermissionSettings", (_e, kind: ReplyPermissionKind): Promise<void> => {
    const url = PERMISSION_SETTINGS_URL[kind];
    return url ? shell.openExternal(url) : Promise.resolve();
  });

  // 渠道凭据校验：core 纯函数构造请求/解析响应，main fetch + safeStorage 加密 token。
  ipcMain.handle(
    "reply:verifyChannel",
    (_e, channelId: ChannelId, token: string): Promise<ReplyChannelVerifyResult> =>
      verifyChannel(channelId, token),
  );

  // 断开渠道：密文由渲染端 store 持有（safeStorage 无持久态），main 侧无残留可清，空实现即可。
  ipcMain.handle("reply:disconnectChannel", (_e, _channelId: ChannelId): void => {
    // safeStorage 只做加解密、不持久化；密文清除在渲染端 store（disconnectChannel）完成。
  });

  // 调试记录：读 controller 的环形缓冲（最近 20 条，仅内存，进程退出即清）。
  ipcMain.handle("reply:getDebugLog", (): ReplyDebugEntry[] => getReplyDebugEntries());

  // 手动触发起草：转 controller.startDraftSession（兜底 accelerator / 设置页调试入口共用）。
  // controller 未初始化（非 mac / 尚未接线）时安全 no-op。
  ipcMain.handle("reply:triggerDraft", (): void => triggerReplyDraft());

  // 设置快照推送：U5 仅缓存最近值供 U7 读取；不做副作用。
  ipcMain.handle("reply:syncSettings", (_e, snapshot: ReplySyncSnapshot): void => {
    lastSyncedSnapshot = snapshot;
  });

  // ── 候选气泡窗通道（U6）──────────────────────────────────────────────────────────
  // 气泡渲染端 → 主进程（单向 send，非 invoke）：实测高度上报 + 鼠标动作上行。
  // 状态推送（主进程 → 气泡端）不在此注册——由 bubble-window.ts 直接 webContents.send。
  // 键盘动作不经此通道（窗口 focusable:false，键由 helper 吞键 → controller 驱动）。

  // 气泡实测内容高度上报 → 重定位并（必要时）显示。
  ipcMain.on("reply-bubble:resize", (_e, height: number) => resizeReplyBubble(height));

  // 气泡鼠标动作（翻牌/重试/关闭/选择/去设置）→ 分发到 U7 注入的处理器（未注入则安全忽略）。
  ipcMain.on("reply-bubble:action", (_e, action: ReplyBubbleAction) => dispatchReplyBubbleAction(action));
}
