// reply 权限查询:五项 macOS TCC 权限(辅助功能 / 屏幕录制 / 日历 / 麦克风 / 语音识别)状态。
//
// 数据源优先级:node-mac-permissions(原生只读查询)→ 加载失败(未安装 / ABI 不匹配 / 非 mac)
// 时回退 helper 的 `permissions` one-shot 命令。两条通道都归一化到同一三态模型,供 U9 权限中心 UI
// 与 U7 降级判定消费。
//
// 关键约束:node-mac-permissions 是可选原生依赖,**必须动态 import + try/catch**——
// 非 mac 平台 / 打包缺失时不得在 import 期崩溃(core/views 边界之外,但仍守「非 mac 不崩」)。

/** 归一化三态,与 helper Permissions.swift 的 stateString 对齐。 */
export type PermissionState = "granted" | "denied" | "notDetermined";

/** 五项权限状态快照(键名与 helper permissions 输出、U9 UI 一致)。 */
export interface ReplyPermissions {
  accessibility: PermissionState;
  screen: PermissionState;
  calendar: PermissionState;
  microphone: PermissionState;
  speech: PermissionState;
}

/** 全部未决(非 mac / 查询完全失败时的安全默认)。 */
export function unknownPermissions(): ReplyPermissions {
  return {
    accessibility: "notDetermined",
    screen: "notDetermined",
    calendar: "notDetermined",
    microphone: "notDetermined",
    speech: "notDetermined",
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

/** node-mac-permissions 的最小依赖形状(只用到 getAuthStatus)。 */
interface MacPermissionsModule {
  getAuthStatus(type: string): string;
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
async function queryViaNodeMacPermissions(loader: NativeModuleLoader): Promise<ReplyPermissions | null> {
  try {
    const perms = await loader();
    if (typeof perms.getAuthStatus !== "function") return null;
    return {
      accessibility: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.accessibility)),
      screen: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.screen)),
      calendar: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.calendar)),
      microphone: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.microphone)),
      speech: mapAuthStatus(perms.getAuthStatus(NMP_TYPES.speech)),
    };
  } catch {
    return null;
  }
}

/** 解析 helper permissions 命令的 JSON 响应为三态快照。 */
export function parseHelperPermissions(res: Record<string, unknown>): ReplyPermissions {
  return {
    accessibility: normalizeHelperState(res.accessibility),
    screen: normalizeHelperState(res.screen),
    calendar: normalizeHelperState(res.calendar),
    microphone: normalizeHelperState(res.microphone),
    speech: normalizeHelperState(res.speech),
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
): Promise<ReplyPermissions> {
  if (platform !== "darwin") return unknownPermissions();

  const viaNode = await queryViaNodeMacPermissions(nativeLoader);
  if (viaNode) return viaNode;

  if (helperFallback) {
    try {
      const res = await helperFallback();
      if (res && res.ok !== false) return parseHelperPermissions(res);
    } catch {
      /* 落到最终兜底 */
    }
  }
  return unknownPermissions();
}
