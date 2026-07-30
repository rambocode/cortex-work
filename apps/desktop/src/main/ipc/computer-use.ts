// Computer Use 设置页的 IPC 域：环境自检 + 手动重试预装。
//
// 只读 + 一个幂等动作，没有凭据、没有落盘配置——总开关与定位模型都走普通的 generalSettings
// 持久化（store:save），本模块只负责回答设置页那两个它自己答不出的问题：
//   1. 这台机器现在到底能不能用（装了吗 / 有 swiftc 吗 / 两项授权给了吗）；
//   2. 没装的话，现在就装一次。
//
// 为什么状态查询要走主进程：五门控里有三条（swiftc、两项 TCC 授权、落盘 marker）是 renderer
// 拿不到的信息。设置页若自己猜，就会出现「UI 说可用、实际不注入」的错位。
// 状态与注入决策共用 resolveComputerUse，从根上保证两者口径一致。

import { app, ipcMain, shell } from "electron";

import { createLogger } from "../log";
import { resolveComputerUse } from "../capabilities/computer-use/inject";
import { ensureComputerUsePackage, peekComputerUsePackage } from "../capabilities/computer-use/install";
import { resetSwiftcCache } from "../capabilities/computer-use/env";
import { requestReplyPermissionAccess } from "../reply/permissions";
import { openReplyPermissionSettings } from "../reply/permission-settings";
import {
  readBundleId,
  repromptPermission,
  resetTccRecord,
  resolveAppBundlePath,
} from "../reply/permission-reprompt";
import { getPersistedState } from "./store";
import type { ComputerUseStatus, ComputerUsePermissionKind } from "./types";

const log = createLogger("computer-use-ipc");

/// 汇总设置页要展示的状态。ready = 五门控全过（即此刻真会给 Agent 注入 gui_* 工具）。
export async function getComputerUseStatus(): Promise<ComputerUseStatus> {
  const gs = (await getPersistedState()).generalSettings;
  const res = await resolveComputerUse(gs?.computerUse);
  return {
    ready: res.path !== null,
    installed: peekComputerUsePackage() !== null,
    reason: res.reason,
    groundingModel: gs?.computerUse?.groundingModel,
  };
}

export function registerComputerUseHandlers(): void {
  // 状态查询：设置页打开/切开关后调。刻意不缓存 —— 权限可能刚在系统设置里被改。
  ipcMain.handle("computer-use:status", (): Promise<ComputerUseStatus> => getComputerUseStatus());

  // 手动重试预装（首启时联网失败、或用户刚删了包）。ensureComputerUsePackage 自带在途去重，
  // 用户连点也只会跑一次；装完回最新状态，省一次 round-trip。
  ipcMain.handle("computer-use:install", async (): Promise<ComputerUseStatus> => {
    // 重试时顺带清掉 swiftc 探测缓存：用户很可能是刚 xcode-select --install 完再回来点重试，
    // 缓存里那个「没有 swiftc」的旧结论会让状态行一直显示错误原因。
    resetSwiftcCache();
    const path = await ensureComputerUsePackage();
    if (!path) log.warn("手动重试预装未成功");
    return getComputerUseStatus();
  });

  // 「重新申请授权」：reset TCC 记录 → 重新触发系统提示 → 打开设置面板。
  // 解决的是「提示只弹一次，忽略后列表里再也不会出现本应用」这个死角（详见 permission-reprompt.ts）。
  // 渲染端只在未授权时提供入口并先弹确认——reset 会清掉该应用已有的授权记录。
  ipcMain.handle(
    "computer-use:repromptPermission",
    async (_e, kind: ComputerUsePermissionKind): Promise<ComputerUseStatus> => {
      const bundlePath = resolveAppBundlePath(app.getPath("exe"));
      const bundleId = readBundleId(bundlePath);
      if (!bundleId) log.warn(`读不到 CFBundleIdentifier（${bundlePath}），降级为仅打开设置面板`);
      const r = await repromptPermission(kind, {
        bundleId,
        resetTcc: resetTccRecord,
        requestAccess: (k) => requestReplyPermissionAccess(k, process.platform, undefined, log),
        openSettings: (k) =>
          openReplyPermissionSettings(k, {
            requestAccess: (kk) => requestReplyPermissionAccess(kk, process.platform, undefined, log),
            openExternal: (url) => shell.openExternal(url),
          }),
      });
      log.info(`重新申请授权 kind=${kind} reset=${r.reset} requested=${r.requested}`);
      return getComputerUseStatus();
    },
  );

  // 在 Finder 中显示当前运行的 .app —— reset 仍不奏效时的兜底：用户可直接把它拖进授权列表。
  // 免去手抄路径,也绕开 Finder 默认不显示点开头目录（dev 的 Electron.app 在 .pnpm 下）这个坑。
  ipcMain.handle("computer-use:revealApp", (): void => {
    shell.showItemInFolder(resolveAppBundlePath(app.getPath("exe")));
  });
}
