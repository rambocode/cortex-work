#!/usr/bin/env node
// 从锁定版本的 @earendil-works/pi-ai 生成 apps/desktop/assets/provider-catalog.json。
//
// 为什么需要它：Cortex 曾自己维护一份「Provider → 模型能力」映射，并把它当作 models 传给 pi
// extension，结果覆盖掉 pi 内置目录、把多模态模型降级成纯文本（图片被静默替换为占位文本）。
// 修复的第一步就是**取消 Cortex 侧的能力再解释**：能力唯一来源是 pi 自己的内置目录，
// 构建期原样抄出来，运行时只读。本脚本刻意不补任何默认值——猜默认值正是那次事故的根因。
//
// 产出位置（U4·R9 变更）：`assets/provider-catalog.json`。
//   pi 的 bun 二进制与 `resources/pi/`（extraResources）已随 gateway 化删除；
//   electron-builder 的 `files` 已包含 `assets/**`，放这里无需改打包配置即可随 asar 分发，
//   dev 与打包态都由 `app.getAppPath()` 定位同一相对路径（见 src/main/providers/catalog.ts）。
//   产物入库（非 gitignore）：它是确定性输出，入库后新克隆无需先跑构建即可类型检查/测试；
//   每次构建都会原样重写，pi 版本不变时字节一致、git 保持干净。
//
// 版本一致性（**必须保留**）：Catalog 必须与运行时实际加载的那份 pi 同版本，否则会出现
//   「UI 说模型支持图片、实际 pi 里没有该模型」的漂移。校验点有两处，缺一不可：
//     · 构建期（本脚本 resolvePiPackages）：pi-ai 与 pi-coding-agent 的版本必须一致；
//     · 运行时（catalog.ts）：catalog.piVersion 必须等于 node_modules 里 pi-coding-agent 的版本。
//
// 既是 CLI 也是模块：`node scripts/build-pi-catalog.mjs` 直接生成并写盘；
// 单测 import `buildProviderCatalog()` 拿到同一份内存结果做断言（不写盘）。
// 任何失败（包解析不到、版本不一致、目录为空）都以非零退出，让构建整体失败。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(here); // apps/desktop
const piPkgDir = join(desktopRoot, "node_modules/@earendil-works/pi-coding-agent");
// 与 src/main/providers/catalog.ts 的 CATALOG_REL_PATH 一一对应，改动必须同步。
const outDir = join(desktopRoot, "assets");
const outPath = join(outDir, "provider-catalog.json");

/** Catalog 结构版本。改字段语义时必须 +1，运行时加载器会拒绝不认识的版本。 */
export const SCHEMA_VERSION = 1;

/**
 * 稳定序列化：对象键升序、跳过 undefined。hash 依赖它，
 * 运行时校验方 `src/main/providers/catalog.ts` 必须实现**逐字相同**的规则，
 * 否则每次启动都会误判 hash 不符。两处改动必须同步。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * 派生 Provider 支持的认证方式。判定规则直接引自 pi 的 `ProviderAuth` 文档语义
 * （`pi-ai/dist/auth/types.d.ts`），不做任何 Cortex 侧发挥：
 *   · `oauth` 存在            → "oauth"
 *   · `apiKey` 且有 `login`   → "api-key"（可交互录入密钥）
 *   · `apiKey` 但无 `login`   → "ambient"（原文：Ambient-only providers omit `login`）
 * 注意：0.82.1 的内建 Provider 无一是 ambient-only，故 "ambient" 目前不会出现；
 * bedrock / vertex 这类「也能吃环境变量与 ADC 文件」的能力由 `envVars` 表达，
 * 二者是正交信息，不要把 envVars 非空当成 ambient。
 */
function deriveAuthKinds(auth) {
  const kinds = [];
  if (auth?.apiKey) kinds.push(auth.apiKey.login ? "api-key" : "ambient");
  if (auth?.oauth) kinds.push("oauth");
  return kinds;
}

/**
 * 探测 Provider 会读取哪些环境变量：用一个只记录、永远返回「无」的 AuthContext 跑一遍
 * pi 自己的 `apiKey.resolve()`，把它查询过的变量名收集下来。
 *
 * 为什么用探测而不是写死一张表：env 变量名闭包在 `envApiKeyAuth(name, envVars)` 里，
 * 对象上没有对应字段；手抄一张表就又回到了「Cortex 自己维护映射、迟早漂移」的老路。
 * 安全性已逐个核对（all.js 里全部 provider 的 resolve 实现）：credential 传 undefined、
 * env 全返回 undefined、fileExists 恒 false 时，所有分支都只调用 ctx.env / ctx.fileExists
 * 后落到末尾 return undefined——不发网络请求、不执行命令、不碰真实文件系统。
 */
async function probeEnvVars(provider) {
  const seen = [];
  const ctx = {
    env: async (name) => {
      if (!seen.includes(name)) seen.push(name);
      return undefined;
    },
    fileExists: async () => false,
  };
  try {
    await provider.auth?.apiKey?.resolve?.({ ctx, credential: undefined });
  } catch (e) {
    // resolve 抛错说明 pi 侧实现变了（探测前提被打破），宁可让构建失败也不产出半份表。
    throw new Error(`探测 ${provider.id} 的环境变量失败: ${e.message}`);
  }
  return seen;
}

/**
 * Provider 级 `api`：pi 的 Provider 对象不暴露 api，只有每个 Model 有。
 * 这里取「模型中占比最高的 api」作为 Provider 的代表值（同票按名称升序定序，保证可复现）。
 * ⚠️ github-copilot / opencode / cloudflare-ai-gateway 等 Provider 内部混用多种 api，
 * **权威值永远是 CatalogModel.api**，Provider 级只作展示与筛选用。
 */
function dominantApi(models) {
  const counts = new Map();
  for (const m of models) counts.set(m.api, (counts.get(m.api) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "";
}

/**
 * 原样抄录模型能力字段。刻意只做「挑字段 + 浅拷贝」，不补默认值、不改写、不推断：
 * 任何一处「缺失就填个合理值」都会重演本次能力降级事故。
 * `cost` 与 `compat` 整体透传（cost 可能带 pi 的分档 `tiers`，compat 是 api 相关的
 * 兼容性开关），契约类型只声明了它们的子集，多出来的字段随 JSON 原样带过。
 */
function toCatalogModel(model) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    input: [...model.input],
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.cost ? { cost: model.cost } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

/**
 * 解析锁定版本的 pi-ai 与 pi-coding-agent，并核对二者版本一致。
 *
 * pi-ai 用**裸说明符动态 import** 取：它是纯 ESM，且 `./providers/*` 的 exports 只声明了
 * "import" 条件，createRequire().resolve() 会直接抛 ERR_PACKAGE_PATH_NOT_EXPORTED，走不通。
 * 本文件位于 apps/desktop/scripts/，Node 会沿 apps/desktop/node_modules → 工作区根
 * node_modules 解析。apps/desktop/package.json 里显式声明了 @earendil-works/pi-ai 直接依赖，
 * 是为了把版本钉死、不靠 pnpm 提升的传递依赖碰运气。
 */
async function resolvePiPackages() {
  if (!existsSync(piPkgDir)) throw new Error(`找不到 pi 包: ${piPkgDir}\n请先 pnpm install。`);
  const piVersion = JSON.parse(readFileSync(join(piPkgDir, "package.json"), "utf-8")).version;

  let all;
  try {
    all = await import("@earendil-works/pi-ai/providers/all");
  } catch (e) {
    throw new Error(`无法加载 @earendil-works/pi-ai/providers/all: ${e.message}`);
  }

  // pi-ai 的 exports 不暴露 ./package.json，只能从已解析模块的物理路径倒推包目录
  // （dist/providers/all.js → 上溯三级）。
  const aiPkgDir = dirname(
    dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/all")))),
  );
  const aiVersion = JSON.parse(readFileSync(join(aiPkgDir, "package.json"), "utf-8")).version;

  // 版本必须与 pi-coding-agent 完全一致：主进程运行时加载的是 pi-coding-agent 依赖的那份
  // pi-ai（in-process 迁移后二者同在 node_modules 里，pnpm 解析到同一物理目录），
  // 若这里解析到另一个版本，生成的能力表就不是运行时实际持有的那份。
  // ⚠️ 这条校验是防「pi-ai 与 pi-coding-agent 版本漂移」的唯一构建期闸门，不得删除。
  if (aiVersion !== piVersion) {
    throw new Error(`版本不一致: pi-coding-agent@${piVersion} vs pi-ai@${aiVersion}。请对齐两者版本后重试。`);
  }
  return { all, piVersion };
}

/**
 * 生成完整 Catalog（内存对象，不写盘）。返回 `{ catalog, skipped }`，
 * `skipped` 是被排除的零静态模型 Provider（0.82.1 里是纯动态的 radius）。
 */
export async function buildProviderCatalog() {
  const { all, piVersion } = await resolvePiPackages();

  const providers = [];
  const skipped = [];
  for (const provider of all.builtinProviders()) {
    // getModels() 按契约不得抛异常；抛了就是 pi 侧坏了，直接失败而不是静默产出空目录。
    let models;
    try {
      models = provider.getModels();
    } catch (e) {
      throw new Error(`读取 ${provider.id} 模型列表失败: ${e.message}`);
    }

    // 零静态模型 = 纯动态 Provider（0.82.1 里是 radius，目录需联网向网关拉取）。
    // Catalog 是「随包、离线、只读」的静态快照，收录一个空壳只会让 UI 出现永远没有模型的条目。
    if (models.length === 0) {
      skipped.push(provider.id);
      continue;
    }

    const envVars = await probeEnvVars(provider);
    providers.push({
      id: provider.id,
      name: provider.name,
      api: dominantApi(models),
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      auth: deriveAuthKinds(provider.auth),
      ...(envVars.length > 0 ? { envVars } : {}),
      models: models.map(toCatalogModel).sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
  }

  // 排序保证同版本 pi 反复生成的字节完全一致（hash 稳定、自动更新差量不虚增）。
  providers.sort((a, b) => (a.id < b.id ? -1 : 1));
  if (providers.length === 0) throw new Error("生成结果为空：一个 Provider 都没有，拒绝写出。");

  const hash = createHash("sha256").update(canonicalJson(providers)).digest("hex");
  return { catalog: { schemaVersion: SCHEMA_VERSION, piVersion, hash, providers }, skipped };
}

// ── CLI 入口 ──────────────────────────────────────────────────────────────────

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  const log = (msg) => console.log(`[build-pi-catalog] ${msg}`);
  try {
    const { catalog, skipped } = await buildProviderCatalog();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const modelCount = catalog.providers.reduce((sum, p) => sum + p.models.length, 0);
    log(`pi@${catalog.piVersion}: ${catalog.providers.length} providers / ${modelCount} models → ${outPath}`);
    if (skipped.length > 0) log(`已排除零静态模型的 Provider: ${skipped.join(", ")}`);
    log(`hash=${catalog.hash}`);
  } catch (e) {
    console.error(`[build-pi-catalog] ✖ ${e.message}`);
    process.exit(1);
  }
}
