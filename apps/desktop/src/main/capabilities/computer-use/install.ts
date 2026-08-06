// Computer Use package（pi-computer-use）的预装与落盘定位。
//
// 为什么是装到 ~/.pi（由 pi 自己的 package manager 管理），而不是随 app 分发一份 vendored 副本：
//   1. 该 package 有 npm 依赖（@sinclair/typebox）。vendored 就得自己把依赖树打进去并保持同步,
//      而 pi 的 package manager 本来就干这个。
//   2. `-e npm:...` 每次启动临时安装也能跑通,但那样每次开会话都要走一遍 npm 解析,冷启动变慢;
//      而且离线时行为不确定。装一次、之后只读本地路径,是唯一冷启零开销的做法。
//   （注：该 package 首次调用 gui_* 时会现编一个 Swift helper,但它编到 tmpdir()、不写包目录,
//     所以「包目录只读」本身不是障碍——理由是上面两条,不是可写性。见 native-helper.ts:329。）
//
// U4·R8:安装动作已由「spawn pi 二进制跑 `pi install`」改为主进程内调用
// `DefaultPackageManager`（见 ipc/pi-extensions-market.ts）。本模块只负责幂等与 marker,
// 与市场共用同一个包管理串行链——复制一份必然漂移。
//
// 幂等:落一个 marker（userData/computer-use-package.json）记住解析到的绝对路径。
// marker 命中且路径仍存在 → 零包管理调用直接返回。这让「每次启动都预装」退化成一次 statSync。

import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { createLogger } from "../../log";
import { installPiPackage, resolveInstalledPackagePath } from "../../ipc/pi-extensions-market";
import { COMPUTER_USE_SOURCE_REF } from "../../ipc/types";

const log = createLogger("computer-use");

interface PackageMarker {
  sourceRef: string;
  path: string;
  installedAt: number;
}

function markerPath(): string {
  return join(app.getPath("userData"), "computer-use-package.json");
}

// 读 marker。任何异常（文件不存在/JSON 坏/字段缺）都当作「没装过」——marker 只是缓存,
// 读不出来最坏是多跑一次安装（幂等），不该让启动链路抛错。
function readMarker(): PackageMarker | null {
  try {
    const raw = JSON.parse(readFileSync(markerPath(), "utf-8")) as Partial<PackageMarker>;
    if (typeof raw.path !== "string" || typeof raw.sourceRef !== "string") return null;
    return { sourceRef: raw.sourceRef, path: raw.path, installedAt: raw.installedAt ?? 0 };
  } catch {
    return null;
  }
}

function writeMarker(m: PackageMarker): void {
  try {
    writeFileSync(markerPath(), JSON.stringify(m, null, 2), "utf-8");
  } catch (e) {
    // 写不下 marker 不影响本次可用性,只是下次启动会再跑一遍预装（幂等）。
    log.warn(`marker 写入失败,下次启动将重新预装: ${String(e)}`);
  }
}

// 确认一个落盘路径确实是 pi-computer-use 本身,而不是名字相近的其它包。
// 保留这层校验是因为「路径含包名」是我们对包身份的唯一判据:npm 源的落盘路径按包名定址,
// 前缀相同的 pi-computer-use-extra 必须被判定为「不是它」。
export function findComputerUsePath(paths: string[]): string | undefined {
  return paths.find((p) => /(^|\/)pi-computer-use$/.test(p) || p.includes("/pi-computer-use/"));
}

// 在途去重:whenReady 与设置页「重试」可能并发触发,同一时刻只跑一次预装。
let inflight: Promise<string | null> | null = null;

/**
 * 确保 pi-computer-use 已装好,返回其扩展目录绝对路径;不可用时返回 null。
 *
 * 绝不抛:调用方是 whenReady 的 fire-and-forget 与设置页状态查询,失败只能降级成
 * 「Computer Use 不可用」,不该冒泡拖垮启动或让设置页白屏。
 * 失败时**不写 marker**,下次启动自动重试。
 */
export function ensureComputerUsePackage(): Promise<string | null> {
  if (inflight) return inflight;
  inflight = doEnsure().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doEnsure(): Promise<string | null> {
  // 非 macOS 直接放弃:该 package 只支持 macOS（原生 Swift helper + CGEvent）。
  if (process.platform !== "darwin") return null;

  const marker = readMarker();
  if (marker && marker.sourceRef === COMPUTER_USE_SOURCE_REF && existsSync(marker.path)) {
    return marker.path;
  }

  try {
    // 先看是否已在库存里（用户手动装过,或 marker 因升级 sourceRef 而失配但包已在）。
    // npm 源按包名定址,故同名不同版本也会命中——与旧实现「在 pi list 里按包名认路径」等价。
    const existing = findComputerUsePath([(await resolveInstalledPackagePath(COMPUTER_USE_SOURCE_REF)) ?? ""]);
    if (existing) {
      writeMarker({ sourceRef: COMPUTER_USE_SOURCE_REF, path: existing, installedAt: Date.now() });
      return existing;
    }

    log.info(`预装 Computer Use package: ${COMPUTER_USE_SOURCE_REF}`);
    const path = findComputerUsePath([await installPiPackage(COMPUTER_USE_SOURCE_REF)]);
    if (!path) {
      log.warn("预装报成功,但落盘路径不是 pi-computer-use");
      return null;
    }
    writeMarker({ sourceRef: COMPUTER_USE_SOURCE_REF, path, installedAt: Date.now() });
    log.info(`Computer Use package 就绪: ${path}`);
    return path;
  } catch (e) {
    log.warn(`预装失败: ${String(e)}`);
    return null;
  }
}

/** 只读探测:已装则返回路径,未装返回 null,**不触发**安装（设置页状态查询用）。 */
export function peekComputerUsePackage(): string | null {
  const marker = readMarker();
  if (marker && marker.sourceRef === COMPUTER_USE_SOURCE_REF && existsSync(marker.path)) return marker.path;
  return null;
}
