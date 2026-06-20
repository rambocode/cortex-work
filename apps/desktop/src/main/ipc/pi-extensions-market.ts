// pi 扩展市场 IPC（U4）:把 pi 二进制当扩展（npm/git 包）的惰性下载运行时。
// pi-ext:list   → spawn `pi list`,解析出已装包的本地路径集（存在性的唯一来源,C3 库存重建）。
// pi-ext:install→ spawn `pi install <ref>`;前后 list 差分定位落盘路径;失败回滚半写入;在途去重 + 串行化。
// pi-ext:remove → spawn `pi remove <ref>`。
// 安全/一致性:env 复用 spawnEnvFor({agent:"pi"})——与长驻 RPC 会话同 HOME,故 install 与运行看到同一
// ~/.pi/agent/settings.json（C7）。装≠启用:本模块只管下载/列举/卸载,启用集/信任在 core store。
// 实测(pi 0.79.2):pi install 不跑生命周期脚本、本地源不解析依赖;pi list 仅给路径、无 version/origin
// （故溯源在 core 安装时持久化）。串行化回避并发写 settings.json 竞争。

import { ipcMain } from "electron";
import { spawn } from "child_process";
import { resolvePiBinary } from "../agents/pi-locate";
import { spawnEnvFor } from "./cli";
import type { PiExtInstallResult } from "./types";

// 子进程运行抽象:生产 spawn pi 二进制;测试注入 fake（与 pi-rpc 的 RpcTransport 注入同思路）。
export type PiRunResult = { code: number; stdout: string; stderr: string };
export type PiRunner = (args: string[]) => Promise<PiRunResult>;

function defaultRunner(args: string[]): Promise<PiRunResult> {
  return new Promise((res) => {
    const child = spawn(resolvePiBinary(), args, { env: spawnEnvFor({ agent: "pi" }) });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => res({ code: -1, stdout, stderr: `${stderr}${String(e)}` }));
    child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

let runner: PiRunner = defaultRunner;
/** 测试注入 fake runner;传 null 复位为真实 spawn。 */
export function __setPiRunnerForTest(r: PiRunner | null): void {
  runner = r ?? defaultRunner;
}

// pi list 输出形如:`User packages:\n  <显示路径>\n    <绝对路径>`。取缩进>=4 空格的绝对路径行。
export function parsePiList(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s{4,}(\/.+\S)\s*$/);
    if (m && m[1]) paths.push(m[1]);
  }
  return [...new Set(paths)];
}

// 由 sourceRef 前缀判定来源类型（溯源用;ref 唯一键沿用 sourceRef 规范形）。
export function detectOrigin(sourceRef: string): string {
  if (sourceRef.startsWith("npm:")) return "npm";
  if (
    sourceRef.startsWith("git:") ||
    sourceRef.startsWith("https://") ||
    sourceRef.startsWith("ssh://") ||
    sourceRef.includes("github.com")
  )
    return "git";
  if (sourceRef.startsWith("./") || sourceRef.startsWith("../") || sourceRef.startsWith("/")) return "local";
  return "npm";
}

// 串行化:所有写操作（install/remove）排队,回避并发写 settings.json。
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

// 在途去重:同 sourceRef 安装复用同一 Promise。
const inflight = new Map<string, Promise<PiExtInstallResult>>();

async function listPaths(): Promise<string[]> {
  const r = await runner(["list"]);
  if (r.code !== 0) return [];
  return parsePiList(r.stdout);
}

async function doInstall(sourceRef: string): Promise<PiExtInstallResult> {
  const before = new Set(await listPaths());
  const r = await runner(["install", sourceRef]);
  if (r.code !== 0) {
    // 失败:对账,若半写入（pi list 多出条目）则 pi remove 回滚。
    const added = (await listPaths()).filter((p) => !before.has(p));
    if (added.length) await runner(["remove", sourceRef]).catch(() => undefined);
    return { ok: false, error: (r.stderr || r.stdout || `pi install 退出码 ${r.code}`).trim() };
  }
  const added = (await listPaths()).filter((p) => !before.has(p));
  const path = added[added.length - 1];
  if (!path) return { ok: false, error: "安装成功但无法在 pi list 中定位新增落盘路径" };
  return { ok: true, ref: sourceRef, sourceRef, origin: detectOrigin(sourceRef), path };
}

export function registerPiExtensionMarketHandlers(): void {
  ipcMain.handle("pi-ext:list", (): Promise<string[]> => listPaths());

  ipcMain.handle("pi-ext:install", (_e, args: { sourceRef: string }): Promise<PiExtInstallResult> => {
    const ref = (args?.sourceRef ?? "").trim();
    if (!ref) return Promise.resolve({ ok: false, error: "安装来源 ref 为空" });
    const existing = inflight.get(ref);
    if (existing) return existing; // 在途去重:同 ref 复用
    const p = serialize(() => doInstall(ref)).finally(() => inflight.delete(ref));
    inflight.set(ref, p);
    return p;
  });

  ipcMain.handle("pi-ext:remove", (_e, args: { sourceRef: string }): Promise<{ ok: boolean; error?: string }> =>
    serialize(async () => {
      const r = await runner(["remove", (args?.sourceRef ?? "").trim()]);
      return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || `退出码 ${r.code}`).trim() };
    }),
  );
}
