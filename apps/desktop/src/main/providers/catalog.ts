// 构建期 Provider Catalog 的运行时加载与校验（阶段①·2.1；U4·R9 改为「随 app + 对 npm 包校验」）。
//
// Catalog（apps/desktop/assets/provider-catalog.json）由 scripts/build-pi-catalog.mjs 从锁定版本的
// @earendil-works/pi-ai 原样抄出，是 Cortex 内「Provider / 模型 / 能力」的唯一事实来源。
// 本模块只做三件事：定位、校验、冻结。**绝不补默认值、绝不写回**——Cortex 侧的能力再解释
// 正是「多模态模型被降级成纯文本、图片被静默替换成占位文字」那次事故的根因。
//
// ── U4·R9：为什么不再从「pi 二进制旁置目录」读 ────────────────────────────────
// pi 正从 bun 自包含二进制迁移为主进程内直接调用 npm 包（见
// docs/plans/2026-08-05-001-refactor-pi-inprocess-migration-plan.md）。`resources/pi/` 会消失，
// 因此：
//   · Catalog 文件改放 `assets/`——electron-builder 的 `files` 已包含 `assets/**`，随 asar 分发，
//     dev 与打包态都能用 `app.getAppPath()` 定位到同一相对路径，不依赖 extraResources。
//   · 版本基准改成**实际会被加载的那个 npm 包**（node_modules/@earendil-works/pi-coding-agent
//     的 package.json）。这才是运行时真正跑的那份 pi；对着一个即将不存在的二进制校验没有意义。
//
// 校验三关（任一不过即整体不可用，返回结构化错误让调用方降级，不抛异常）：
//   1. schemaVersion —— 结构版本必须是本进程认识的那一版；
//   2. hash          —— 内容未被篡改 / 未被半截写入；
//   3. piVersion     —— 与随 app 的 pi npm 包同版本。二者漂移会让 UI 展示 pi 里根本没有的模型。

import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderCatalog, ProviderCatalogResult } from "./contract";

/** 本进程认识的 Catalog 结构版本，与 scripts/build-pi-catalog.mjs 的 SCHEMA_VERSION 对齐。 */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Catalog 相对 app 根目录的位置，与 scripts/build-pi-catalog.mjs 的 outPath 一一对应。 */
const CATALOG_REL_PATH = ["assets", "provider-catalog.json"];

/** pi 运行时包的 package.json 相对路径（版本基准的唯一来源）。 */
const PI_PACKAGE_REL_PATH = ["node_modules", "@earendil-works", "pi-coding-agent", "package.json"];

/** Catalog 加载所需的两个输入路径。抽成显式参数是为了让单测能喂 fixture，不必造 node_modules。 */
export interface ProviderCatalogSources {
  /** 构建期产出的 provider-catalog.json 绝对路径。 */
  catalogPath: string;
  /** 版本基准：@earendil-works/pi-coding-agent 的 package.json 绝对路径。 */
  piPackageJsonPath: string;
}

/**
 * 稳定序列化：对象键升序、跳过 undefined。
 * ⚠️ 必须与 scripts/build-pi-catalog.mjs 的 `canonicalJson` 逐字等价——它是 hash 的定义，
 * 两边规则一旦分叉，每次启动都会误判「hash 不符」而让整个 Catalog 不可用。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

/** 递归冻结，杜绝任何调用方就地改写能力字段（能力对 Cortex 只读是本次修复的硬约束）。 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** 最小结构校验：只确认「是不是 Catalog 这个形状」，不校验能力字段本身（那是 pi 的数据）。 */
function looksLikeCatalog(value: unknown): value is ProviderCatalog {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<ProviderCatalog>;
  return (
    typeof c.schemaVersion === "number" &&
    typeof c.piVersion === "string" &&
    typeof c.hash === "string" &&
    Array.isArray(c.providers)
  );
}

/**
 * 读取并校验 Catalog。两个路径由调用方给出（生产走 `resolveCatalogSources()`，单测喂 fixture）。
 */
export function loadProviderCatalogAt(sources: ProviderCatalogSources): ProviderCatalogResult {
  const { catalogPath, piPackageJsonPath } = sources;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, "utf-8"));
  } catch (e) {
    return { ok: false, error: `无法读取 Provider 目录 (${catalogPath}): ${(e as Error).message}` };
  }

  if (!looksLikeCatalog(parsed)) {
    return { ok: false, error: `Provider 目录结构非法 (${catalogPath})` };
  }

  if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Provider 目录 schemaVersion 不受支持: ${parsed.schemaVersion}（期望 ${SUPPORTED_SCHEMA_VERSION}）`,
    };
  }

  const actualHash = createHash("sha256").update(canonicalJson(parsed.providers)).digest("hex");
  if (actualHash !== parsed.hash) {
    return { ok: false, error: `Provider 目录 hash 不符：文件声明 ${parsed.hash}，实际 ${actualHash}` };
  }

  // 随 app 的 pi 版本读不到就直接判失败：无法证明「目录与运行时同版本」时，
  // 宁可不可用也不能带病上线（漂移的表现是 UI 里出现 pi 根本没有的模型）。
  let piVersion: string;
  try {
    const pkg = JSON.parse(readFileSync(piPackageJsonPath, "utf-8")) as { version?: unknown };
    if (typeof pkg.version !== "string") throw new Error("package.json 缺少 version");
    piVersion = pkg.version;
  } catch (e) {
    return { ok: false, error: `无法确认随包 pi 版本 (${piPackageJsonPath}): ${(e as Error).message}` };
  }

  if (piVersion !== parsed.piVersion) {
    return {
      ok: false,
      error: `Provider 目录与随包 pi 版本不一致：目录 ${parsed.piVersion}，pi 包 ${piVersion}`,
    };
  }

  return { ok: true, catalog: deepFreeze(parsed) };
}

/**
 * 定位 pi npm 包的 package.json。
 *
 * 候选顺序（取第一个存在的）：
 *   1. `<app>/node_modules/...` —— dev 态是 apps/desktop 的直接依赖；打包态是 asar 内的同一相对路径
 *      （electron-builder 需放开对 pi-coding-agent 的排除，即迁移计划的 R10；未放开时这一条不命中）。
 *   2. 工作区根 `node_modules/...` —— dev 态 pnpm 提升到仓库根时的兜底。
 *   3. `<Resources>/pi/package.json` —— **过渡回退**：迁移未完成时 app 里仍带着 bun 二进制及其
 *      旁置的 pi package.json，版本与 npm 包一致，可作为灰度期的安全网。`resources/pi/` 在计划的
 *      U7 删除后这一条自然失效，届时应连同本注释一并移除。
 * 全都不存在时返回候选 1，让错误信息指向最该存在的那个路径。
 */
function resolvePiPackageJsonPath(): string {
  const appPath = app.getAppPath();
  const candidates = [
    join(appPath, ...PI_PACKAGE_REL_PATH),
    join(appPath, "..", "..", ...PI_PACKAGE_REL_PATH),
    join(process.resourcesPath ?? "", "pi", "package.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** 生产路径推导：Catalog 随 asar 分发在 `assets/`，版本基准取实际会被加载的 npm 包。 */
function resolveCatalogSources(): ProviderCatalogSources {
  return {
    catalogPath: join(app.getAppPath(), ...CATALOG_REL_PATH),
    piPackageJsonPath: resolvePiPackageJsonPath(),
  };
}

/** 进程内缓存：Catalog 是随包静态资源，一次读取 + 校验（含 sha256）足够，不必每次 IPC 重算。 */
let cached: ProviderCatalogResult | undefined;

/** 读取并校验随包 Catalog。失败时返回结构化错误，不抛异常（调用方需降级而非崩溃）。 */
export function getProviderCatalogResult(): ProviderCatalogResult {
  cached ??= loadProviderCatalogAt(resolveCatalogSources());
  return cached;
}

/** 便捷取值：Catalog 不可用时返回 undefined。主进程内部消费方用这个。 */
export function getProviderCatalog(): ProviderCatalog | undefined {
  const result = getProviderCatalogResult();
  return result.ok ? result.catalog : undefined;
}

/** 仅供单测重置进程内缓存。生产代码不要调用。 */
export function __resetProviderCatalogCacheForTests(): void {
  cached = undefined;
}
