// Computer Use 的运行环境探测：Swift 编译器 + 两项 macOS TCC 权限。
//
// 探测这些是为了兑现「环境不满足就不注入工具」——给 Agent 一套必然失败的 gui_* 工具比不给
// 更糟，它会反复重试把整轮对话烧掉（同 capabilities/knowledge/inject.ts:15-17 的理由）。
//
// 缓存策略是刻意分开的：
//   · swiftc 存在性 → 缓存。装/卸 Xcode CLI Tools 不是运行期常见操作,每次开会话都 spawn 一个
//     进程去问不值得。
//   · TCC 权限 → **绝不缓存**。用户可以随时在 系统设置 › 隐私与安全性 里撤销;缓存会导致
//     「已撤销授权但工具还在注入」,那正是最危险的失效方向。

import { execFile } from "child_process";

import { createLogger } from "../../log";
import { buildEnv } from "../../ipc/cli";
import { queryReplyPermissions, type HelperPermissionsFn } from "../../reply/permissions";

const log = createLogger("computer-use");

const SWIFTC_PROBE_TIMEOUT_MS = 10_000;

let swiftcCache: boolean | undefined;

/**
 * 清掉 swiftc 探测缓存,下次 hasSwiftc() 会重新探。
 *
 * 生产用途:设置页「重试」——用户很可能是刚跑完 xcode-select --install 才回来点的,
 * 不清缓存就会一直看到那条陈旧的「没有 swiftc」。测试里也用它隔离用例。
 */
export function resetSwiftcCache(): void {
  swiftcCache = undefined;
}

/**
 * 探测 swiftc 是否可用（pi-computer-use 用它现编原生 GUI helper）。
 *
 * 关键:必须用 buildEnv() 的 PATH，而不是 process.env 原样。GUI 启动的 Electron PATH 很窄，
 * 而 pi 子进程拿到的是 buildEnv() 补齐后的 PATH——用不同的 PATH 探测就会得出与子进程
 * 实际能力不一致的结论（探测说没有、子进程其实能跑，或反之）。
 *
 * 探测 swiftc 而不是 `xcode-select -p`：后者在只装了 CLI Tools 的机器上也返回路径，
 * 但真正决定 helper 能不能编出来的是 swiftc 本身在不在 PATH 里。
 */
export function hasSwiftc(): Promise<boolean> {
  if (swiftcCache !== undefined) return Promise.resolve(swiftcCache);
  return new Promise((resolve) => {
    execFile(
      "swiftc",
      ["-version"],
      { env: buildEnv(), timeout: SWIFTC_PROBE_TIMEOUT_MS },
      (err) => {
        swiftcCache = !err;
        if (err) log.debug(`swiftc 不可用: ${String(err)}`);
        resolve(swiftcCache);
      },
    );
  });
}

/**
 * 查询辅助功能 + 屏幕录制两项授权是否都已 granted。
 *
 * 复用「快捷回复」既有的权限查询（reply/permissions.ts），不新造探测:同一台机器上两个功能
 * 问的是同一份 TCC 数据库,两套实现只会给出互相矛盾的答案。
 *
 * 刻意**不**接 reply 的 helper 兜底源:那个 Swift helper 只在「快捷回复」启用时才在跑,
 * 依赖它会让 Computer Use 的可用性莫名其妙地取决于另一个无关功能开没开。
 * 主路径 node-mac-permissions 是原生模块、与功能开关无关,足够可靠;它若加载失败则本函数
 * 得到全 notDetermined → 判定为未授权 → 不注入,这是安全的失败方向。
 * helperFallback 仅供测试注入。
 */
export async function hasScreenPermissions(
  helperFallback?: HelperPermissionsFn,
): Promise<{ accessibility: boolean; screenRecording: boolean }> {
  const perms = await queryReplyPermissions(helperFallback, process.platform, undefined, log);
  return {
    accessibility: perms.accessibility === "granted",
    screenRecording: perms.screenRecording === "granted",
  };
}
