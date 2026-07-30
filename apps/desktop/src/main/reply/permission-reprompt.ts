// TCC「重新申请授权」：先 tccutil reset 清掉「已提示过」的记录，再触发一次系统授权提示。
//
// **为什么需要它**：macOS 对每个应用只弹一次授权提示。用户忽略或误关了那一次之后，
// AXIsProcessTrustedWithOptions / CGRequestScreenCaptureAccess 就再也不会把应用加进
// 「系统设置 › 隐私与安全性」的列表——于是「去授权」确实把面板打开了，面板里却空无一物，
// 用户唯一的出路是自己去 Finder 里把 .app 翻出来拖进列表。
//
// 开发模式下这尤其难受：dev 跑的是 node_modules/.pnpm/electron@<版本>/…/Electron.app，
// 路径深、含点开头目录（Finder 默认不显示），而且每次升级 Electron 路径还会变。
//
// tccutil reset 清掉那条记录后，下一次请求就能重新弹出提示，用户点一下条目自动出现，
// 全程不必知道 .app 在哪。tccutil 是系统自带命令，**不需要 sudo**（实测：对不存在的
// bundle id 报的是 -10814「无此 bundle identifier」而非权限拒绝）。
//
// 只对「辅助功能」「屏幕录制」有意义：这两项没有应用内授权弹窗，只能靠系统提示或手动添加；
// 日历/麦克风/语音识别本来就有真正的模态弹窗，不该动它们的 TCC 记录。

import { execFile } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";

import type { ReplyPermissionKind } from "../ipc/reply-types";

const TCCUTIL_TIMEOUT_MS = 10_000;

/// kind → tccutil 的 service 名。只列可 reprompt 的两项（见文件头理由）。
export const TCC_SERVICE_BY_KIND: Partial<Record<ReplyPermissionKind, string>> = {
  accessibility: "Accessibility",
  screenRecording: "ScreenCapture",
};

/**
 * 由主进程可执行文件路径回推 .app bundle 根目录。
 *
 * exe 形如 `<Foo>.app/Contents/MacOS/Foo`，向上三级即 bundle 根。
 * dev 下得到 node_modules 里的 Electron.app，打包后得到 Cortex.app —— 两者都对，
 * 因为 TCC 认的就是当前实际在跑的那个 bundle。
 */
export function resolveAppBundlePath(exePath: string): string {
  return dirname(dirname(dirname(exePath)));
}

/**
 * 读 bundle 的 CFBundleIdentifier（tccutil reset 的目标）。
 *
 * 直接正则读 XML plist，不 spawn PlistBuddy：Electron 与 electron-builder 产出的 Info.plist
 * 都是 XML。读不出来就返回 null —— 调用方据此降级成「只开面板 + 在 Finder 中显示」，
 * 而不是拿一个猜的 bundle id 去 reset（reset 错的对象既无效也可能误伤别的应用）。
 */
export function readBundleId(bundlePath: string): string | null {
  try {
    const xml = readFileSync(join(bundlePath, "Contents", "Info.plist"), "utf-8");
    const m = xml.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** 跑 `tccutil reset <service> <bundleId>`。成功返回 true；失败只报 false，不抛。 */
export function resetTccRecord(service: string, bundleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tccutil", ["reset", service, bundleId], { timeout: TCCUTIL_TIMEOUT_MS }, (err) => {
      // 失败最常见的原因是该 bundle id 压根不在 TCC 库里（= 本来就没提示过）。
      // 那种情况下后续的 requestAccess 照样能弹提示，所以不当作致命错误。
      resolve(!err);
    });
  });
}

export interface RepromptDeps {
  bundleId: string | null;
  resetTcc: (service: string, bundleId: string) => Promise<boolean>;
  requestAccess: (kind: ReplyPermissionKind) => Promise<boolean>;
  openSettings: (kind: ReplyPermissionKind) => Promise<void>;
}

export interface RepromptResult {
  /** 是否成功清掉了「已提示过」的记录（false 表示大概率本来就没记录，或该 kind 不支持）。 */
  reset: boolean;
  /** 是否已触发系统授权请求。 */
  requested: boolean;
}

/**
 * 重新申请一项授权：reset TCC 记录 → 触发系统提示 → 顺带打开对应设置面板。
 *
 * 三步都做而不是二选一：提示可能因系统状态仍不弹出，此时面板已经开着，用户还能手动勾/添加。
 * 顺序很重要——必须先 reset 再 request，反过来 request 会被「已提示过」的记录挡住。
 */
export async function repromptPermission(
  kind: ReplyPermissionKind,
  deps: RepromptDeps,
): Promise<RepromptResult> {
  const service = TCC_SERVICE_BY_KIND[kind];
  let reset = false;
  if (service && deps.bundleId) {
    reset = await deps.resetTcc(service, deps.bundleId);
  }
  const requested = await deps.requestAccess(kind);
  // 面板始终打开:提示没弹出来时它是唯一可见的着力点（同 permission-settings 的 ALWAYS_OPEN_PANEL）。
  await deps.openSettings(kind);
  return { reset, requested };
}
