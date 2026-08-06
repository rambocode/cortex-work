// pi in-process 引擎的**唯一**包加载点：三个 pi 包（coding-agent / agent-core / ai）的
// lazy 动态 import + 单例缓存 + 加载失败的响亮错误。
//
// ── 为什么必须是「动态 import + 变量 specifier」（迁移计划 KTD1，不可让步）─────────────
// 三个包都是**纯 ESM**（package.json `"type":"module"`，exports 只有 `import` 条件），而主进程
// 被 electron-vite 打成 **CJS**。写成字符串字面量的 `import("@earendil-works/pi-coding-agent")`
// 会被 rollup 静态分析并把整张 ESM 依赖图（glob/minimatch/undici/jiti/photon-node/highlight.js…）
// 内联进 CJS chunk —— 正是 CLAUDE.md 里记的「pi 纯 ESM 依赖闭包在 asar 里反复
// ERR_MODULE_NOT_FOUND」那个历史大坑，也是当年被迫改用 bun 编译二进制的直接原因。
// 用数组 `join("/")` 拼出 specifier + `/* @vite-ignore */`，打包器完全不参与，运行时保留原生
// `import()` 加载 ESM。实测：这样写主 bundle 里 `pi-coding-agent` 字符串出现 **0 次**。
// 写法与 `providers/pi-runtime.ts` 同源，改动前先读那个文件头部的长注释。
//
// ── KTD2：本文件（以及任何会进 bundle 的文件）不得出现 top-level await ────────────────
// rollup 对 CJS 输出直接拒绝（`Module format "cjs" does not support top-level await`），
// 是**构建期**失败而非运行时失败。所以加载一律封装在 async 函数里，靠 Promise 单例缓存。
//
// ── 类型侧 ──────────────────────────────────────────────────────────────────────────
// `typeof import("...")` 只出现在类型位置，编译期擦除，零运行时/打包影响。用它而不是手抄
// 接口镜像，正是本次迁移的核心收益之一：pi 升级带来的协议漂移变成 **TS 编译期错误**，
// 而不是运行时「卡住 / 丢事件」。

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createLogger } from "../../log";

const log = createLogger("pi-inproc-runtime");

// 见文件头：刻意不是字符串字面量，避免被打包器静态分析并内联。
const PI_CODING_AGENT = ["@earendil-works", "pi-coding-agent"].join("/");
const PI_AGENT_CORE = ["@earendil-works", "pi-agent-core"].join("/");
const PI_AI_COMPAT = ["@earendil-works", "pi-ai", "compat"].join("/");

/** pi-coding-agent 的完整模块类型（SDK 层：createAgentSession / 工具工厂 / SessionManager…）。 */
export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
/** pi-agent-core 的完整模块类型（Agent / AgentEvent / 工具原语）。U3/U5 的原生能力注册会用到。 */
export type PiAgentCoreModule = typeof import("@earendil-works/pi-agent-core");
/** pi-ai compat 层（Model / streamSimple / clampThinkingLevel）。Provider 适配（U3）会用到。 */
export type PiAiCompatModule = typeof import("@earendil-works/pi-ai/compat");

/** 三包中的哪一个。错误信息里带上它，便于区分是哪一层没装好。 */
export type PiPackageId = "pi-coding-agent" | "pi-agent-core" | "pi-ai";

/**
 * pi 运行时加载失败。**刻意抛错而不是静默降级**：
 * in-process 后没有子进程退出码可依赖（KTD5），任何「装不上就悄悄退回默认」的兜底都会表现为
 * 用户看到一个毫不相干的下游报错。这里直接把包名与原始错误一并抛出，让失败点可定位。
 */
export class PiRuntimeLoadError extends Error {
  constructor(
    readonly pkg: PiPackageId,
    readonly cause: unknown,
  ) {
    super(`pi 运行时不可用（${pkg} 加载失败）：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PiRuntimeLoadError";
  }
}

// 单例缓存。**失败不缓存**：装包/权限问题修好后无需重启应用即可恢复（与 providers/pi-runtime.ts
// 的 modelsPromise 同款处理）。缓存的是 Promise 而非结果，避免并发首次加载时重复 import。
let codingAgentPromise: Promise<PiCodingAgentModule> | null = null;
let agentCorePromise: Promise<PiAgentCoreModule> | null = null;
let piAiCompatPromise: Promise<PiAiCompatModule> | null = null;

// 单测注入点：整个 import 动作的替身。测试里不真加载纯 ESM 的 pi 包
//（重、且 pi-coding-agent 顶层有 `setDefaultStreamFn` 之类的全局副作用）。
type PiImporter = (specifier: string) => Promise<unknown>;

// ── 打包态 worker 的解析兜底（0.1.54 事故，与 KTD1 同级不可让步）──────────────────────
// 本文件同时被打进两个产物：主进程 bundle（app.asar/out/main）与 pi-host worker
// （app.asar.unpacked/out/worker，KTD3 决定 fork 必须走 unpacked 真实文件）。
// Node ESM 对裸包名的解析是从 parent 文件向上逐级找 node_modules——主进程 parent 在 asar 内,
// 能命中 app.asar/node_modules；而 unpacked 目录的父链（app.asar.unpacked → Resources → …）
// **永远经过不了 app.asar 内部**，worker 里裸包名 import 必然 ERR_MODULE_NOT_FOUND。
// 此前「worker 裸包名可解析 asar」的实测结论是在仓库内 dist/ 验的：从那里向上能摸到仓库
// node_modules 兜底（lessons.md 点名的假象）；/Applications 无兜底，0.1.54 正式包 pi:open
// 全数报「找不到 pi-coding-agent」。
// 兜底方式：检测到自身位于 app.asar.unpacked 时，按包的 exports 定位 app.asar/node_modules
// 内的 ESM 入口，以 file URL import。包**内部**的裸标识符仍以 asar 内文件为 parent 解析
// （Electron 对 fs/ESM 加载的 asar 补丁在 utilityProcess 同样生效），传递依赖照常工作。

/** 定位 app.asar/node_modules；仅当本 bundle 落在 app.asar.unpacked 内（打包态 worker）才非空。 */
function unpackedAsarNodeModules(): string | null {
  const marker = `${path.sep}app.asar.unpacked${path.sep}`;
  const idx = __dirname.indexOf(marker);
  if (idx === -1) return null;
  return path.join(__dirname.slice(0, idx), "app.asar", "node_modules");
}

/** exports 条目取真实文件：字符串直接用；条件对象按 import → default → node 递归取首个命中。 */
function pickExportTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const rec = entry as Record<string, unknown>;
    return pickExportTarget(rec.import) ?? pickExportTarget(rec.default) ?? pickExportTarget(rec.node);
  }
  return null;
}

/**
 * 在 asar 的 node_modules 里手动解析 specifier 到入口文件绝对路径。
 * 只需覆盖本文件顶部三种形态：scoped 包名 + 至多一段静态子路径（如 "@earendil-works/pi-ai/compat"），
 * 刻意不实现通配 exports 等完整 ESM 解析语义——多余的通用性只会掩盖真实的解析失败。
 */
function resolvePiEntryInAsar(nodeModulesRoot: string, specifier: string): string {
  const segments = specifier.split("/");
  const name = segments.slice(0, 2).join("/");
  const subpath = segments.length > 2 ? `./${segments.slice(2).join("/")}` : ".";
  const pkgDir = path.join(nodeModulesRoot, ...name.split("/"));
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
    main?: string;
  };
  const target =
    pickExportTarget(pkg.exports?.[subpath]) ?? (subpath === "." ? (pkg.main ?? "index.js") : null);
  if (!target) {
    throw new Error(`无法从 ${pkgDir} 的 exports 解析子路径 ${subpath}`);
  }
  return path.join(pkgDir, target);
}

/** 生产实现。见文件头 KTD1：specifier 必须是变量 + @vite-ignore；unpacked worker 走 asar 兜底。 */
const realImporter: PiImporter = async (specifier) => {
  const asarNodeModules = unpackedAsarNodeModules();
  if (asarNodeModules) {
    const entry = pathToFileURL(resolvePiEntryInAsar(asarNodeModules, specifier)).href;
    return import(/* @vite-ignore */ entry);
  }
  return import(/* @vite-ignore */ specifier);
};

let importer: PiImporter = realImporter;

/**
 * 通用加载器：命中缓存 → import → 缓存。
 * reject 路径上把缓存清空，保证「失败不缓存」——装包/权限问题修好后无需重启即可恢复。
 */
function loadPackage<T>(
  pkg: PiPackageId,
  specifier: string,
  getCache: () => Promise<T> | null,
  setCache: (p: Promise<T> | null) => void,
): Promise<T> {
  let cached = getCache();
  if (!cached) {
    cached = importer(specifier).then(
      (mod) => mod as T,
      (err: unknown) => {
        setCache(null);
        log.error(`${pkg} 加载失败:`, err instanceof Error ? err.message : String(err));
        throw new PiRuntimeLoadError(pkg, err);
      },
    );
    setCache(cached);
  }
  return cached;
}

/** 取（并缓存）pi-coding-agent。in-process 引擎的主入口包。 */
export function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  return loadPackage<PiCodingAgentModule>(
    "pi-coding-agent",
    PI_CODING_AGENT,
    () => codingAgentPromise,
    (p) => {
      codingAgentPromise = p;
    },
  );
}

/** 取（并缓存）pi-agent-core。U3 的原生工具/能力注册需要它的 `AgentTool` 原语。 */
export function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  return loadPackage<PiAgentCoreModule>(
    "pi-agent-core",
    PI_AGENT_CORE,
    () => agentCorePromise,
    (p) => {
      agentCorePromise = p;
    },
  );
}

/** 取（并缓存）pi-ai 的 compat 层。U3 的 Provider/模型解析需要它的 `Model` 与 clamp 工具。 */
export function loadPiAiCompat(): Promise<PiAiCompatModule> {
  return loadPackage<PiAiCompatModule>(
    "pi-ai",
    PI_AI_COMPAT,
    () => piAiCompatPromise,
    (p) => {
      piAiCompatPromise = p;
    },
  );
}

/**
 * 预热：开关打开时在应用启动后台调一次。
 *
 * 为什么值得预热：pi-coding-agent 的 ESM 依赖闭包很大（含 undici / jiti / photon-node），
 * 冷加载耗时可观；不预热的话这段延迟会全部落在用户点「发送」后的第一次 `pi:open` 上，
 * 表现为「第一条消息特别慢」。失败只记日志、不影响启动（真正需要时会再次尝试并响亮报错）。
 */
export async function primePiInProcRuntime(): Promise<void> {
  try {
    await loadPiCodingAgent();
  } catch (err) {
    log.warn("pi in-process 运行时预热失败（不影响启动）:", err instanceof Error ? err.message : String(err));
  }
}

/** 单测注入 import 替身。传 null 恢复真实加载。注入后须自行清缓存。 */
export function __setPiRuntimeImporterForTests(next: PiImporter | null): void {
  importer = next ?? realImporter;
}

/** 单测复位：恢复真实 importer 并清空全部缓存，避免跨用例串状态。 */
export function __resetPiRuntimeCacheForTests(): void {
  importer = realImporter;
  codingAgentPromise = null;
  agentCorePromise = null;
  piAiCompatPromise = null;
}
