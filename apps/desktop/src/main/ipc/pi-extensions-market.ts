// pi 扩展市场 IPC（U4·R8）:扩展（npm/git 包）的惰性下载运行时,**已由 spawn pi 二进制改为
// 主进程内直接调用 pi-coding-agent 的 `DefaultPackageManager`**。
//
// pi-ext:list   → listConfiguredPackages() 取已装包的落盘路径集（存在性的唯一来源,C3 库存重建）。
// pi-ext:install→ installAndPersist(<ref>);getInstalledPath 定位落盘路径;失败回滚半写入;在途去重 + 串行化。
// pi-ext:remove → removeAndPersist(<ref>)。
//
// ── 为什么是动态 import 且用变量做 specifier（KTD1,与 providers/pi-runtime.ts 同一套约束）──
// `@earendil-works/pi-coding-agent` 是纯 ESM 包,主进程被 electron-vite 打成 CJS。写成字符串
// 字面量会让 rollup 把整个 ESM 依赖闭包（glob/minimatch/undici/jiti/photon…）静默打进 CJS chunk,
// 正是 0.1.52/0.1.53 正式包「模型运行时不可用」那类事故的成因。用数组 join 出的变量 specifier
// + `@vite-ignore` 让打包器完全不参与,运行时保留原生 `import()`。同理**不得出现 top-level await**
//（KTD2:rollup 对 CJS 输出直接拒绝,构建期即失败）。
//
// 一致性（C7）:agentDir 取 pi 自己的 `getAgentDir()`（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）,
// 与长驻会话看到同一份 `~/.pi/agent/settings.json`。装≠启用:本模块只管下载/列举/卸载,
// 启用集/信任在 core store。串行化回避并发写 settings.json 竞争。
//
// 已知限制（相对旧的 spawn 路径）:
//   1. 超时只能 race 掉等待,杀不掉 DefaultPackageManager 内部已 spawn 的 npm/git 子进程
//      （SDK 未暴露 signal）。关键性质仍在:Promise 必 settle,串行链不会被永久卡住。
//   2. SDK 内部 `npm install` 用 stdio:"inherit",拿不到 stderr 明细,失败信息只有
//      「npm ... failed with code N」+ 进度回调里的 error message。故进度事件必须收集起来拼进错误文本。

import { ipcMain } from "electron";
import { homedir } from "os";

import { createLogger } from "../log";
import { buildEnv } from "./cli";
import type { PiExtInstallResult } from "./types";

const log = createLogger("pi-ext");

// 刻意不是字符串字面量,见文件头 KTD1。
const PI_CODING_AGENT = ["@earendil-works", "pi-coding-agent"].join("/");

// 超时上限:install 可能联网拉包给长超时;list/remove 是本地操作给短超时。无超时则挂死的 npm
// 会让 Promise 永不 settle → 永久阻塞 serialize 串行链与 inflight 去重,后续 install/remove 全卡死。
const INSTALL_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 30_000;

// ── pi 包管理运行时的收窄视图 ────────────────────────────────────────────────

/** `DefaultPackageManager` 的进度事件（结构类型镜像,刻意不从纯 ESM 包 import 类型）。 */
export interface PiPackageProgressEvent {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
}

/** 已配置包条目（`listConfiguredPackages()` 的返回元素）。`installedPath` 缺失即「配置了但没装上」。 */
export interface PiConfiguredPackage {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

/**
 * 本模块真正用到的 `DefaultPackageManager` 方法面。
 * 收窄成结构类型（而非 import 上游类型）有两个理由:一是纯 ESM 包的 .d.ts 不该被拉进
 * 主进程的类型图,二是单测可以喂一个普通对象当替身,不必加载真实 pi 运行时。
 */
export interface PiPackageManager {
  listConfiguredPackages(): PiConfiguredPackage[];
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
  getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
  setProgressCallback(callback: ((event: PiPackageProgressEvent) => void) | undefined): void;
}

/**
 * 一次包管理操作所需的上下文。
 * `flush` 必不可少:`installAndPersist` 只是把 settings 变更**入队**,不排空就报成功,
 * 长驻 pi 会话可能读到还没写下去的 `~/.pi/agent/settings.json`（装了却"没配置"）。
 */
export interface PiPackageSession {
  pm: PiPackageManager;
  flush(): Promise<void>;
}

type PiPackageSessionFactory = () => Promise<PiPackageSession>;

/** pi-coding-agent 里我们用到的那几个导出（同样是结构类型镜像）。 */
interface PiCodingAgentModule {
  getAgentDir(): string;
  SettingsManager: {
    create(cwd: string, agentDir?: string, options?: { projectTrusted?: boolean }): { flush(): Promise<void> };
  };
  DefaultPackageManager: new (options: { cwd: string; agentDir: string; settingsManager: unknown }) => PiPackageManager;
}

let modulePromise: Promise<PiCodingAgentModule> | null = null;

/**
 * 惰性加载 pi-coding-agent。失败**不缓存**（装包/权限问题修好后无需重启即可恢复），
 * 且抛出的是一句人类可读的中文错误——绝不静默降级成「没有任何扩展」。
 */
function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  modulePromise ??= (async () => (await import(/* @vite-ignore */ PI_CODING_AGENT)) as PiCodingAgentModule)().catch(
    (err: unknown) => {
      modulePromise = null;
      log.error("pi-coding-agent 加载失败:", String(err));
      throw new Error(`pi 包管理运行时不可用（pi-coding-agent 加载失败）: ${errorText(err)}`);
    },
  );
  return modulePromise;
}

/**
 * 建一次性的包管理上下文。
 *
 * 刻意**每次操作新建**而不是缓存单例:`SettingsManager` 在构造时把 settings.json 读进内存,
 * 长驻缓存会在「pi 会话或用户手动改了 settings.json」之后读到陈旧内容。构造成本只是读两个
 * 小 JSON,远低于一次 npm 解析。
 *
 * cwd 固定取用户主目录:本模块只做 user scope 的包管理,绝不能把包落进某个项目的 `.pi/`
 *（project scope 还会触发 pi 的信任校验）。
 */
async function createRealSession(): Promise<PiPackageSession> {
  const mod = await loadPiCodingAgent();
  const agentDir = mod.getAgentDir();
  const cwd = homedir();
  const settingsManager = mod.SettingsManager.create(cwd, agentDir);
  const pm = new mod.DefaultPackageManager({ cwd, agentDir, settingsManager });
  return { pm, flush: () => settingsManager.flush() };
}

let sessionFactory: PiPackageSessionFactory = createRealSession;

/** 测试注入 fake 包管理器;传 null 复位为真实 in-process 实现。 */
export function __setPiPackageSessionForTest(factory: PiPackageSessionFactory | null): void {
  sessionFactory = factory ?? createRealSession;
}

// ── 操作外壳:串行化 + PATH 补齐 + 超时 + 进度收集 ────────────────────────────

// 串行化:所有包管理操作排队,回避并发写 settings.json / npm 目录的竞争。
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 在受控环境里跑一次包管理操作。
 *
 * PATH 补齐是这里最容易被忽略的一条:`DefaultPackageManager` spawn npm/git 时直接用
 * `process.env`,而 GUI 启动的 Electron 主进程 PATH 里通常没有 nvm / homebrew 的 node 与 npm
 *（旧的 spawn 路径靠 `spawnEnvFor` 的 `buildEnv()` 补齐,in-process 后这层没了）。
 * 因为所有操作都被 serialize 串起来,临时改写 `process.env.PATH` 不会与其它操作交错;
 * finally 里恢复原值。已 spawn 的子进程在 spawn 时就取走了 env,恢复不影响它们。
 */
function runPackageOp<T>(
  label: string,
  timeoutMs: number,
  fn: (session: PiPackageSession, progress: string[]) => Promise<T>,
): Promise<T> {
  return serialize(async () => {
    const session = await sessionFactory();
    const progress: string[] = [];
    const prevPath = process.env.PATH;
    process.env.PATH = buildEnv().PATH;
    session.pm.setProgressCallback((event) => {
      if (event.message) progress.push(event.message);
      log.debug(`[${label}] ${event.action}/${event.type} ${event.source}${event.message ? `: ${event.message}` : ""}`);
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      // 超时只保证「本 Promise 必 settle」;底层 npm 子进程杀不掉（见文件头已知限制 1）。
      return await Promise.race([
        fn(session, progress),
        new Promise<never>((_res, rej) => {
          timer = setTimeout(() => rej(new Error(`pi ${label} 超时(${timeoutMs}ms)`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      session.pm.setProgressCallback(undefined);
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
}

/** 把 SDK 异常与进度里的 error 消息拼成一条可读错误（SDK 的 npm 错误本身不带 stderr 明细）。 */
function describeFailure(err: unknown, progress: string[]): string {
  const detail = progress.filter((m) => m && !m.endsWith("...")).join("; ");
  const base = errorText(err);
  return detail && !base.includes(detail) ? `${base}（${detail}）` : base;
}

// ── 对外能力（IPC 与 capabilities/computer-use/install.ts 共用） ─────────────

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

/** 已装包的落盘路径集（去重）。C3 库存重建的唯一来源。 */
export function listInstalledPackagePaths(): Promise<string[]> {
  return runPackageOp("list", SHORT_TIMEOUT_MS, async ({ pm }) => {
    const paths = pm
      .listConfiguredPackages()
      .map((p) => p.installedPath)
      .filter((p): p is string => Boolean(p));
    return [...new Set(paths)];
  });
}

/**
 * 查某个 sourceRef 当前的落盘路径;未装返回 undefined。**不触发安装**。
 * 注意 npm 源的落盘路径按**包名**定址（`<agentDir>/npm/node_modules/<name>`），
 * 因此它同时覆盖「用户先前装的是同名不同版本」这种情况——这正是旧实现里
 * 「在 pi list 输出里按包名认路径」想达到的效果。
 */
export function resolveInstalledPackagePath(sourceRef: string): Promise<string | undefined> {
  return runPackageOp("resolve", SHORT_TIMEOUT_MS, async ({ pm }) => pm.getInstalledPath(sourceRef, "user"));
}

/**
 * 安装并持久化到 user scope,返回落盘路径。失败抛错（错误文本已含进度里的原因）。
 *
 * 失败对账:若「装前没有、装后有」则是半写入,回滚 remove,避免留下装了一半的包目录
 * 与可能已写入的 settings 条目。回滚本身失败只记日志——原始失败原因更重要。
 */
export function installPiPackage(sourceRef: string): Promise<string> {
  return runPackageOp("install", INSTALL_TIMEOUT_MS, async (session, progress) => {
    const { pm } = session;
    const before = pm.getInstalledPath(sourceRef, "user");
    try {
      await pm.installAndPersist(sourceRef);
      await session.flush();
    } catch (err) {
      if (!before && pm.getInstalledPath(sourceRef, "user")) {
        try {
          await pm.removeAndPersist(sourceRef);
          await session.flush();
        } catch (rollbackErr) {
          log.warn(`半写入回滚失败(${sourceRef}): ${errorText(rollbackErr)}`);
        }
      }
      throw new Error(describeFailure(err, progress));
    }
    const path = pm.getInstalledPath(sourceRef, "user");
    if (!path) throw new Error("安装报成功,但无法定位新装包的落盘路径");
    return path;
  });
}

/** 卸载并从 settings 摘除。失败抛错。 */
export function removePiPackage(sourceRef: string): Promise<void> {
  return runPackageOp("remove", SHORT_TIMEOUT_MS, async (session, progress) => {
    try {
      await session.pm.removeAndPersist(sourceRef);
      await session.flush();
    } catch (err) {
      throw new Error(describeFailure(err, progress));
    }
  });
}

// ── IPC 注册 ─────────────────────────────────────────────────────────────────

// 在途去重:同 sourceRef 安装复用同一 Promise。
const inflight = new Map<string, Promise<PiExtInstallResult>>();

async function doInstall(sourceRef: string): Promise<PiExtInstallResult> {
  try {
    const path = await installPiPackage(sourceRef);
    return { ok: true, ref: sourceRef, sourceRef, origin: detectOrigin(sourceRef), path };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export function registerPiExtensionMarketHandlers(): void {
  // list 的契约是 Promise<string[]>,渲染端据此重建库存。运行时整体不可用时只能回空集,
  // 但必须 log.error 留痕——否则「pi 运行时挂了」会伪装成「用户一个扩展都没装」。
  ipcMain.handle("pi-ext:list", async (): Promise<string[]> => {
    try {
      return await listInstalledPackagePaths();
    } catch (err) {
      log.error(`列举扩展失败: ${errorText(err)}`);
      return [];
    }
  });

  ipcMain.handle("pi-ext:install", (_e, args: { sourceRef: string }): Promise<PiExtInstallResult> => {
    const ref = (args?.sourceRef ?? "").trim();
    if (!ref) return Promise.resolve({ ok: false, error: "安装来源 ref 为空" });
    const existing = inflight.get(ref);
    if (existing) return existing; // 在途去重:同 ref 复用
    const p = doInstall(ref).finally(() => inflight.delete(ref));
    inflight.set(ref, p);
    return p;
  });

  ipcMain.handle(
    "pi-ext:remove",
    async (_e, args: { sourceRef: string }): Promise<{ ok: boolean; error?: string }> => {
      try {
        await removePiPackage((args?.sourceRef ?? "").trim());
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorText(err) };
      }
    },
  );
}
