// Computer Use package（pi-computer-use）的预装与落盘定位。
//
// 为什么是 `pi install` 到 ~/.pi，而不是随 app 分发一份 vendored 副本：
//   1. 该 package 有 npm 依赖（@sinclair/typebox）。vendored 就得自己把依赖树打进去并保持同步,
//      而 `pi install` 让 pi 自己的 package manager 解析——它本来就干这个。
//   2. `-e npm:...` 每次启动临时安装也能跑通,但那样每次开会话都要走一遍 npm 解析,冷启动变慢;
//      而且离线时行为不确定。装一次、之后只读本地路径,是唯一冷启零开销的做法。
//   （注：该 package 首次调用 gui_* 时会现编一个 Swift helper,但它编到 tmpdir()、不写包目录,
//     所以「包目录只读」本身不是障碍——理由是上面两条,不是可写性。见 native-helper.ts:329。）
//
// 幂等:落一个 marker（userData/computer-use-package.json）记住解析到的绝对路径。
// marker 命中且路径仍存在 → 零 spawn 直接返回。这让「每次启动都预装」退化成一次 statSync。
// 与 resources/pi/.pi-version 的幂等标记同款思路。

import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { createLogger } from "../../log";
import { parsePiList, runPiCli, type PiRunner } from "../../ipc/pi-extensions-market";
import { COMPUTER_USE_SOURCE_REF } from "../../ipc/types";

const log = createLogger("computer-use");

// 子进程运行抽象:生产复用市场的 runPiCli（同 HOME、同超时/强杀语义）;测试注入 fake。
let runner: PiRunner = runPiCli;
/** 测试注入 fake runner;传 null 复位为真实 spawn。 */
export function __setRunnerForTest(r: PiRunner | null): void {
  runner = r ?? runPiCli;
}

interface PackageMarker {
  sourceRef: string;
  path: string;
  installedAt: number;
}

function markerPath(): string {
  return join(app.getPath("userData"), "computer-use-package.json");
}

// 读 marker。任何异常（文件不存在/JSON 坏/字段缺）都当作「没装过」——marker 只是缓存,
// 读不出来最坏是多跑一次 pi install（幂等），不该让启动链路抛错。
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
    // 写不下 marker 不影响本次可用性,只是下次启动会再跑一遍 pi install（幂等）。
    log.warn(`marker 写入失败,下次启动将重新预装: ${String(e)}`);
  }
}

// 在 pi list 输出里认出 pi-computer-use 的落盘路径。
// 用「路径含包名」判定而非 install 前后差分:差分只在本次真的新装时有效,而这里也要覆盖
// 「用户先前已手动装过（marker 缺失但包在）」的情况,否则会白跑一次 install。
export function findComputerUsePath(paths: string[]): string | undefined {
  return paths.find((p) => /(^|\/)pi-computer-use$/.test(p) || p.includes("/pi-computer-use/"));
}

async function listPaths(): Promise<string[]> {
  const r = await runner(["list"]);
  if (r.code !== 0) return [];
  return parsePiList(r.stdout);
}

// 在途去重:whenReady 与设置页「重试」可能并发触发,同一时刻只跑一次 install。
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
    const existing = findComputerUsePath(await listPaths());
    if (existing) {
      writeMarker({ sourceRef: COMPUTER_USE_SOURCE_REF, path: existing, installedAt: Date.now() });
      return existing;
    }

    log.info(`预装 Computer Use package: ${COMPUTER_USE_SOURCE_REF}`);
    const r = await runner(["install", COMPUTER_USE_SOURCE_REF]);
    if (r.code !== 0) {
      log.warn(`预装失败(退出码 ${r.code}): ${(r.stderr || r.stdout || "").trim()}`);
      return null;
    }
    const path = findComputerUsePath(await listPaths());
    if (!path) {
      log.warn("预装报成功,但 pi list 里找不到落盘路径");
      return null;
    }
    writeMarker({ sourceRef: COMPUTER_USE_SOURCE_REF, path, installedAt: Date.now() });
    log.info(`Computer Use package 就绪: ${path}`);
    return path;
  } catch (e) {
    log.warn(`预装异常: ${String(e)}`);
    return null;
  }
}

/** 只读探测:已装则返回路径,未装返回 null,**不触发**安装（设置页状态查询用）。 */
export function peekComputerUsePackage(): string | null {
  const marker = readMarker();
  if (marker && marker.sourceRef === COMPUTER_USE_SOURCE_REF && existsSync(marker.path)) return marker.path;
  return null;
}
