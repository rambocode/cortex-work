// 构建期 Provider Catalog 的运行时加载与校验（阶段①·2.1）。
//
// Catalog（resources/pi/provider-catalog.json）由 scripts/build-pi-catalog.mjs 从锁定版本的
// @earendil-works/pi-ai 原样抄出，是 Cortex 内「Provider / 模型 / 能力」的唯一事实来源。
// 本模块只做三件事：定位、校验、冻结。**绝不补默认值、绝不写回**——Cortex 侧的能力再解释
// 正是「多模态模型被降级成纯文本、图片被静默替换成占位文字」那次事故的根因。
//
// 校验三关（任一不过即整体不可用，返回结构化错误让调用方降级，不抛异常）：
//   1. schemaVersion —— 结构版本必须是本进程认识的那一版；
//   2. hash          —— 内容未被篡改 / 未被半截写入；
//   3. piVersion     —— 与随包 pi 二进制同版本。二者漂移会让 UI 展示二进制里根本没有的模型。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolvePiBinary } from "../agents/pi-locate";

import type { ProviderCatalog, ProviderCatalogResult } from "./contract";

/** 本进程认识的 Catalog 结构版本，与 scripts/build-pi-catalog.mjs 的 SCHEMA_VERSION 对齐。 */
const SUPPORTED_SCHEMA_VERSION = 1;

const CATALOG_FILE = "provider-catalog.json";
/** build-pi-binary.mjs 把 pi-coding-agent 的 package.json 旁置到同目录，用它取随包 pi 版本。 */
const PI_PACKAGE_FILE = "package.json";

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
 * 从指定的 pi 资源目录读取并校验 Catalog。抽出 piDir 参数是为了让单测能喂 fixture 目录，
 * 生产路径由 `getProviderCatalogResult()` 传入实际目录。
 */
export function loadProviderCatalogAt(piDir: string): ProviderCatalogResult {
  const catalogPath = join(piDir, CATALOG_FILE);

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

  // 随包 pi 版本读不到就直接判失败：无法证明「目录与二进制同版本」时，宁可不可用也不能带病上线。
  let piVersion: string;
  try {
    const pkg = JSON.parse(readFileSync(join(piDir, PI_PACKAGE_FILE), "utf-8")) as { version?: unknown };
    if (typeof pkg.version !== "string") throw new Error("package.json 缺少 version");
    piVersion = pkg.version;
  } catch (e) {
    return { ok: false, error: `无法确认随包 pi 版本 (${piDir}): ${(e as Error).message}` };
  }

  if (piVersion !== parsed.piVersion) {
    return {
      ok: false,
      error: `Provider 目录与随包 pi 版本不一致：目录 ${parsed.piVersion}，二进制 ${piVersion}`,
    };
  }

  return { ok: true, catalog: deepFreeze(parsed) };
}

/** 进程内缓存：Catalog 是随包静态资源，一次读取 + 校验（含 sha256）足够，不必每次 IPC 重算。 */
let cached: ProviderCatalogResult | undefined;

/** 读取并校验随包 Catalog。失败时返回结构化错误，不抛异常（调用方需降级而非崩溃）。 */
export function getProviderCatalogResult(): ProviderCatalogResult {
  // 复用 pi 二进制的定位逻辑（dev / packaged 两条路径），Catalog 与二进制同目录，
  // 不再另写一套路径推导，避免两处规则漂移。
  cached ??= loadProviderCatalogAt(dirname(resolvePiBinary()));
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
