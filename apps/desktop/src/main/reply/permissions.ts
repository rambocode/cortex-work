// reply 权限查询:五项 macOS TCC 权限(辅助功能 / 屏幕录制 / 日历 / 麦克风 / 语音识别)状态。
//
// 数据源优先级:node-mac-permissions(原生只读查询)→ 加载失败(未安装 / ABI 不匹配 / 非 mac)
// 时回退 helper 的 `permissions` one-shot 命令。两条通道都归一化到同一三态模型,供 U9 权限中心 UI
// 与 U7 降级判定消费。
//
// 关键约束:node-mac-permissions 是可选原生依赖,**必须动态 import + try/catch**——
// 非 mac 平台 / 打包缺失时不得在 import 期崩溃(core/views 边界之外,但仍守「非 mac 不崩」)。
//
// 可观测性:此前加载失败是完全静默的(catch 不留日志),生产环境一旦该模块因架构/ABI 问题
// 加载失败,四项权限永远不会被主动注册进系统列表,却没有任何日志线索可查——排查过一次真实
// 故障后补上:所有 catch 分支都经可选注入的 logger 留痕(默认 no-op,保持本模块 electron-free)。

import type { HelperLogger } from "./helper-client";

/** 归一化三态,与 helper Permissions.swift 的 stateString 对齐。 */
export type PermissionState = "granted" | "denied" | "notDetermined";

/**
 * 五项权限状态快照。
 *
 * 键名契约(重要):字段名对齐 IPC/UI 契约 `ReplyPermissionKind`
 * (ipc/reply-types.ts:`screenRecording` / `speechRecognition`),而非底层数据源的原始键——
 * helper permissions 命令输出用 `screen` / `speech`(见 Permissions.swift),
 * node-mac-permissions 的 AuthType 用 `screen` / `speech-recognition`。
 * 这两处原始键只出现在「读取侧」(parseHelperPermissions / NMP_TYPES),读入后即映射到本契约键,
 * 保证本模块「输出」的键与 IPC/UI 一致,日后接线权限中心 UI 时不会漏映射。
 */
export interface ReplyPermissions {
  accessibility: PermissionState;
  screenRecording: PermissionState;
  calendar: PermissionState;
  microphone: PermissionState;
  speechRecognition: PermissionState;
}

/** 全部未决(非 mac / 查询完全失败时的安全默认)。 */
export function unknownPermissions(): ReplyPermissions {
  return {
    accessibility: "notDetermined",
    screenRecording: "notDetermined",
    calendar: "notDetermined",
    microphone: "notDetermined",
    speechRecognition: "notDetermined",
  };
}

/**
 * node-mac-permissions.getAuthStatus 的返回值 → 三态。
 * 其取值为 'authorized' | 'denied' | 'restricted' | 'not determined' | 'limited';
 * restricted(受管控策略禁用)按用户视角等价于 denied;limited(部分授权)视为已授。
 */
export function mapAuthStatus(status: string): PermissionState {
  switch (status) {
    case "authorized":
    case "limited":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    default:
      return "notDetermined"; // 'not determined' 及任何未知值
  }
}

/** helper permissions 命令输出的单项字符串 → 三态(helper 已输出规范三态,仅做类型收敛)。 */
function normalizeHelperState(value: unknown): PermissionState {
  return value === "granted" || value === "denied" ? value : "notDetermined";
}

// node-mac-permissions 的权限类型标识 → 本模块字段(其 AuthType 字面量)。集中在此避免散落。
const NMP_TYPES = {
  accessibility: "accessibility",
  screen: "screen",
  calendar: "calendar",
  microphone: "microphone",
  speech: "speech-recognition",
} as const;

/** node-mac-permissions 的最小依赖形状(getAuthStatus 查询 + askForAccessibilityAccess 触发注册)。 */
interface MacPermissionsModule {
  getAuthStatus(type: string): string;
  askForAccessibilityAccess?(): void;
  askForCalendarAccess?(accessType?: "write-only" | "full"): Promise<unknown>;
  askForMicrophoneAccess?(): Promise<unknown>;
  askForSpeechRecognitionAccess?(): Promise<unknown>;
  askForScreenCaptureAccess?(openPreferences?: boolean): void;
}

/** 原生模块加载器签名。默认动态 import;测试注入以确定性模拟「可用 / 加载失败」。 */
export type NativeModuleLoader = () => Promise<MacPermissionsModule>;

/** 默认加载器:动态 import node-mac-permissions(可选原生依赖,缺失 / ABI 不匹配时抛错)。 */
const defaultNativeLoader: NativeModuleLoader = () => import("node-mac-permissions");

/**
 * 经 node-mac-permissions 读取五项权限。模块加载失败或任一 getAuthStatus 抛错 → 返回 null,
 * 交由调用方回退 helper。整体 try/catch 保证非 mac / 缺失依赖 / electron ABI 不匹配时不崩
 * (ABI 不匹配是本原生模块在 npmRebuild:false 下的已知风险,靠回退 helper 兜底,见 KTD2)。
 */
async function queryViaNodeMacPermissions(
  loader: NativeModuleLoader,
  logger?: HelperLogger,
): Promise<ReplyPermissions | null> {
  try {
    const perms = await loader();
    if (typeof perms.getAuthStatus !== "function") return null;
    // 读取侧用 NMP 原始 AuthType 键,写入侧映射到 IPC 契约键(screenRecording/speechRecognition)。
    return {
      accessibility: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.accessibility)),
      screenRecording: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.screen)),
      calendar: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.calendar)),
      microphone: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.microphone)),
      speechRecognition: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.speech)),
    };
  } catch (err) {
    logger?.warn("[reply] node-mac-permissions 加载/查询失败,回退 helper 兜底", err);
    return null;
  }
}

/** 解析 helper permissions 命令的 JSON 响应为三态快照。 */
export function parseHelperPermissions(res: Record<string, unknown>): ReplyPermissions {
  // helper JSON 用原始键 screen/speech(Permissions.swift),读入后映射到 IPC 契约键。
  return {
    accessibility: normalizeHelperState(res.accessibility),
    screenRecording: normalizeHelperState(res.screen),
    calendar: normalizeHelperState(res.calendar),
    microphone: normalizeHelperState(res.microphone),
    speechRecognition: normalizeHelperState(res.speech),
  };
}

/** helper 兜底查询器签名(注入 helper-client.permissions)。 */
export type HelperPermissionsFn = () => Promise<Record<string, unknown>>;

/**
 * 查询五项权限:优先 node-mac-permissions,失败回退 helper permissions 命令,
 * 再失败返回全 notDetermined。非 mac 平台直接返回全未决(不 spawn helper)。
 */
export async function queryReplyPermissions(
  helperFallback?: HelperPermissionsFn,
  platform: NodeJS.Platform = process.platform,
  nativeLoader: NativeModuleLoader = defaultNativeLoader,
  logger?: HelperLogger,
): Promise<ReplyPermissions> {
  if (platform !== "darwin") return unknownPermissions();

  const viaNode = await queryViaNodeMacPermissions(nativeLoader, logger);
  if (viaNode) return viaNode;

  if (helperFallback) {
    try {
      const res = await helperFallback();
      if (res && res.ok !== false) return parseHelperPermissions(res);
    } catch (err) {
      logger?.warn("[reply] helper permissions 兜底查询失败", err);
    }
  }
  return unknownPermissions();
}

export type ReplyPermissionRequestKind = keyof ReplyPermissions;

function safeGetAuthStatus(perms: MacPermissionsModule, type: string): string | null {
  try {
    return perms.getAuthStatus(type);
  } catch {
    return null;
  }
}

function needsSettingsFallback(status: string | null): boolean {
  return status === "denied" || status === "restricted";
}

/**
 * 主动触发一项 macOS TCC 授权请求。只打开系统设置页不会让 notDetermined 应用出现在列表里；
 * 日历/语音识别等必须由主应用先调用对应 request API，macOS 才会把 Cortex 注册到授权数据库。
 * 返回 true 表示请求流程已由系统弹窗/API 处理；返回 false 时调用方应回退打开对应设置页。
 */
export async function requestReplyPermissionAccess(
  kind: ReplyPermissionRequestKind,
  platform: NodeJS.Platform = process.platform,
  nativeLoader: NativeModuleLoader = defaultNativeLoader,
  logger?: HelperLogger,
): Promise<boolean> {
  if (platform !== "darwin") return false;
  try {
    const perms = await nativeLoader();
    switch (kind) {
      case "accessibility":
        if (typeof perms.askForAccessibilityAccess !== "function") return false;
        perms.askForAccessibilityAccess();
        return true;
      case "calendar":
        if (typeof perms.askForCalendarAccess !== "function") return false;
        if (needsSettingsFallback(safeGetAuthStatus(perms, NMP_TYPES.calendar))) return false;
        await perms.askForCalendarAccess("full");
        return true;
      case "microphone":
        if (typeof perms.askForMicrophoneAccess !== "function") return false;
        if (needsSettingsFallback(safeGetAuthStatus(perms, NMP_TYPES.microphone))) return false;
        await perms.askForMicrophoneAccess();
        return true;
      case "screenRecording":
        if (typeof perms.askForScreenCaptureAccess !== "function") return false;
        perms.askForScreenCaptureAccess(true);
        return true;
      case "speechRecognition":
        if (typeof perms.askForSpeechRecognitionAccess !== "function") return false;
        if (needsSettingsFallback(safeGetAuthStatus(perms, NMP_TYPES.speech))) return false;
        await perms.askForSpeechRecognitionAccess();
        return true;
    }
  } catch (err) {
    logger?.warn(`[reply] 权限请求失败(kind=${kind})`, err);
    return false;
  }
}

/**
 * 主动触发「辅助功能」的系统注册(U9 权限中心「去授权」按钮消费)。
 *
 * 关键背景:辅助功能与其余四项不同——只读查询(AXIsProcessTrusted / helper 的
 * runPermissions)不会把本应用写入 系统设置 › 隐私与安全性 › 辅助功能 的列表,只有调用
 * AXIsProcessTrustedWithOptions(哪怕 prompt 传 false)才会让 macOS 把调用进程自注册进该
 * 列表(未勾选,等用户手动开)。此前只做只读查询 + 单纯跳转系统设置面板,面板里永远没有条目
 * 可勾——形成"要授权先得进列表、要进列表先得触发注册"的死锁,用户看到空列表。
 * node-mac-permissions.askForAccessibilityAccess() 内部即调用该 API(见其 permissions.mm),
 * 未授权时还会顺带打开系统设置面板,故此处只需转调、不必再重复 shell.openExternal。
 * 非 mac / 模块加载失败时静默忽略,由调用方（reply.ts）回退到普通的 shell.openExternal。
 */
export async function requestAccessibilityAccess(
  platform: NodeJS.Platform = process.platform,
  nativeLoader: NativeModuleLoader = defaultNativeLoader,
  logger?: HelperLogger,
): Promise<boolean> {
  return requestReplyPermissionAccess("accessibility", platform, nativeLoader, logger);
}
