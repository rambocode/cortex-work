// 自定义 Provider 的**会话运行时**：把用户保存的整段 Pi Provider JSON 渲染成 pi extension，
// 并算出 spawn 时要注入的 Secret 环境变量。同时承载 pi 会话的「三段式 provider 解析」。
//
// ── 为什么需要这个模块（2026-08-03 的 P0 缺口）────────────────────────────────
// 在此之前，设置页保存的自定义 Provider 只有「保存 / 校验 / Secret 管理」通道在消费，
// 聊天会话的 spawn 链路完全不认它：`resolvePiProviderInput` 只查随包 Catalog，自定义 id
// 解析为 undefined 后**仍继续 spawn**，pi 收到一个孤立的 `--model xxx` 匹配不上，
// 于是走自己的 `findInitialModel` 兜底链选中了一个用户从没选过的 provider（实测落到
// `azure-openai-responses`），发消息时报 `No API key found for azure-openai-responses`。
// —— 用户视角：配置保存成功，聊天却报一个毫不相干的错。
//
// ── 两条不可让步的红线 ───────────────────────────────────────────────────────
//  1. **明文不落盘**：JSON 里的敏感值只以 `${secret:NAME}` 引用存在。渲染 extension 时把它换成
//     `${CORTEX_PI_SECRET_<N>}` 环境变量占位（pi 原生支持 `$VAR` / `${VAR}` 插值，见
//     pi-coding-agent `dist/core/resolve-config-value.js`，`apiKey` 与 `headers` 都走该解析），
//     真值只经 spawn env 进入子进程 —— 与既有 `$CORTEX_PI_KEY` 同一模式。
//  2. **不静默回退**：解析不出 provider 就让 `pi:open` 响亮失败，绝不带着未解析的占位符、
//     更不让 pi 自己换一个模型。宁可开会话失败，也不可让用户以为在用选定的模型、实际不是。

import {
  renderPiExtensionSource,
  safeId,
  writePiExtension,
  writePiExtensionFile,
} from "../agents/pi-providers";
import type { PiProviderInput } from "../ipc/types";
import { getProviderCatalog } from "./catalog";
import type { ProviderCatalog } from "./contract";
import { listSecretNames, readSecrets } from "./credentials";
import { listCustomProviders } from "./custom-providers";
import { resolvePiProviderInput } from "./pi-provider-input";
import { collectSecretRefs } from "./secrets";

/** 注入给 pi 子进程的 Secret 环境变量前缀，与 extension 里的 `${...}` 占位一一对应。 */
export const CUSTOM_SECRET_ENV_PREFIX = "CORTEX_PI_SECRET_";

// ── 结构化错误 ────────────────────────────────────────────────────────────────

/**
 * 自定义 Provider 无法进入会话时抛出。刻意带 `code` 与 `providerId`：
 * 渲染端据此把「一句红色报错」升级成「跳转设置 → 模型服务」的可操作指引。
 */
export class CustomProviderRuntimeError extends Error {
  readonly code: "custom-provider-not-found" | "custom-provider-invalid-json" | "custom-provider-secret-missing";
  readonly providerId: string;

  constructor(code: CustomProviderRuntimeError["code"], providerId: string, message: string) {
    super(message);
    this.name = "CustomProviderRuntimeError";
    this.code = code;
    this.providerId = providerId;
  }
}

// ── Secret 引用 → 环境变量占位 ───────────────────────────────────────────────

/**
 * 按 Secret 名在 JSON 文本中的出现顺序派生环境变量名。
 *
 * 用序号而非 Secret 名本身做变量名，是因为 Secret 名允许 `.` `-`（`SECRET_NAME_RE`），
 * 而 shell 环境变量名只允许 `[A-Za-z0-9_]`（pi 的 `ENV_VAR_NAME_RE` 同样如此）。
 * 直接拼名字会生成 pi 根本解析不出来的变量名，且不同名字可能规范化后撞车。
 * 序号来自 `collectSecretRefs` 的稳定顺序 —— 同一段 JSON 每次派生结果一致。
 */
function deriveSecretEnvNames(names: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  names.forEach((name, index) => map.set(name, `${CUSTOM_SECRET_ENV_PREFIX}${index}`));
  return map;
}

/**
 * 把 JSON 文本里的 `${secret:NAME}` 全部替换成 `${CORTEX_PI_SECRET_<N>}`。
 *
 * 用花括号形式而非裸 `$VAR`：`${secret:A}xyz` 这类紧邻后缀的写法，裸形式会被 pi 解析成
 * 变量名 `CORTEX_PI_SECRET_0xyz`（它的 `ENV_VAR_NAME_PREFIX_RE` 会贪婪吃掉后面的字母数字），
 * 花括号能明确终止变量名边界。
 *
 * ⚠️ 已知限制：pi 只对 **`apiKey` 与 `headers`（provider 级与 model 级）** 做 `$ENV` 插值
 * （`dist/core/provider-composer.js` 里 `resolveConfigValueOrThrow` / `resolveHeadersOrThrow`
 * 的调用点），`baseUrl` 等字段不过这一层。用户若把 `${secret:X}` 写在这些字段里，占位符会
 * 原样进入请求 —— 表现是一个带着 `${CORTEX_PI_SECRET_0}` 字面量的地址报错，可诊断但不友好。
 * 这里刻意**不**为此新增拒绝：保存时 `validateCustomProviderJson` 允许引用出现在任何位置，
 * 在开会话这一刻反悔会造成「存得下、开不了」的割裂，且哪些字段算合法用法本次没有实证。
 * 待阶段 B 的聚合网关生成器落地（届时 JSON 由系统生成、位置可控）时再统一收口。
 */
function substituteSecretPlaceholders(text: string, envNames: ReadonlyMap<string, string>): string {
  return text.replace(/\$\{secret:([A-Za-z0-9_.-]+)\}/g, (whole, name: string) => {
    const env = envNames.get(name);
    // 理论上不可达（envNames 就是从同一段文本收集来的）；保持原样而非替空串，
    // 与 `resolveSecretRefs` 的 missing 语义一致：绝不拼出一个「看起来配好了、实际无鉴权」的请求。
    return env ? `\${${env}}` : whole;
  });
}

/**
 * Cortex 自己写进落盘 JSON、但 **pi 的 schema 里没有** 的模型级字段。
 *
 * 目前只有 `capabilitySource`（聚合网关向导记录的能力来源，供设置页只读展示与审计，
 * 见 `gateway-onboarding.ts` 的 toPiModel）。
 */
const NON_PI_MODEL_FIELDS = ["capabilitySource"] as const;

/**
 * 渲染 extension 前剥掉非 pi 字段。
 *
 * 为什么要剥：pi 的 `applyExtension` 对 `config.models` 走的是
 * `{ ...definition, api, provider, baseUrl, headers: undefined }` —— **原样展开**，
 * 未知键会一路留在 Model 对象上（另一条 `modelFromJson` 路径则会丢掉它们，两边并不一致）。
 * 今天无害，但「只把 pi 定义过的字段交给 pi」是一条便宜且能一直成立的边界：
 * 落盘 JSON 是 Cortex 的记录，extension 是 pi 的输入，两者刻意不等同。
 */
function stripNonPiModelFields(config: Record<string, unknown>): void {
  if (!Array.isArray(config.models)) return;
  for (const model of config.models) {
    if (!model || typeof model !== "object") continue;
    for (const field of NON_PI_MODEL_FIELDS) delete (model as Record<string, unknown>)[field];
  }
}

// ── 自定义 Provider → extension ──────────────────────────────────────────────

/** 一个自定义 Provider 进入 pi 会话所需的全部运行时产物。 */
export interface CustomProviderRuntime {
  /** pi 侧的注册名，同时是 `--provider` 的取值（必须与 registerProvider 同源）。 */
  providerId: string;
  /** 生成的 extension 文件绝对路径（`-e` 加载）。 */
  extensionPath: string;
  /** spawn 时要注入的 Secret 环境变量（明文真值，**仅主进程内部**，不得过 IPC / 进日志）。 */
  secretEnv: Record<string, string>;
  /** 定义的最后修改时间，渲染端计入 extensionFingerprint 以触发会话重开。 */
  updatedAt: number;
}

/**
 * 由 providerId 解析出自定义 Provider 的运行时产物。未命中自定义列表返回 undefined
 * （调用方据此继续往下判定，而不是当作错误）。
 *
 * 命中但配置不可用（JSON 坏了 / 引用的 Secret 已被删）一律**抛错**：这类情况下继续 spawn
 * 只会得到一次令人费解的下游报错，直接失败并指明缺什么才是可诊断的。
 */
export async function resolveCustomProviderExtension(
  providerId: string,
): Promise<CustomProviderRuntime | undefined> {
  const wanted = safeId(providerId);
  const definition = (await listCustomProviders()).find((item) => safeId(item.id) === wanted);
  if (!definition) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(definition.json);
  } catch (err) {
    throw new CustomProviderRuntimeError(
      "custom-provider-invalid-json",
      wanted,
      `供应商「${definition.id}」的配置不是合法 JSON，无法启动会话：${(err as Error)?.message ?? "解析失败"}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CustomProviderRuntimeError(
      "custom-provider-invalid-json",
      wanted,
      `供应商「${definition.id}」的配置顶层必须是一个 JSON 对象`,
    );
  }

  // Secret：先确认全部引用都能在金库里取到，缺任何一个立即失败。
  // 保存时校验过「引用的 Secret 已定义」，但用户随后可能把 Secret 删了 —— 那时这段 JSON
  // 仍留在盘上，只有开会话这一刻能发现。
  const refs = collectSecretRefs(definition.json);
  const envNames = deriveSecretEnvNames(refs);
  const secretEnv: Record<string, string> = {};
  if (refs.length) {
    const vault = await readSecrets();
    const missing = refs.filter((name) => vault[name] === undefined);
    if (missing.length) {
      // 「取不到」有两种成因，排查方向完全不同，必须分开说：
      //   · 金库里压根没有这个名字     → 用户删了它（或从没填过）；
      //   · 名字在、但解不开（readSecrets 会静默丢弃 decrypt 失败的条目，见 credentials.ts）
      //     → 换机 / 重装 / 钥匙串变更导致 safeStorage 密钥失效。
      // 合并成一句「尚未配置，请去填写」会让第二种情况的用户对着一个明明已填的值发呆。
      const defined = new Set(await listSecretNames());
      const undecryptable = missing.filter((name) => defined.has(name));
      const absent = missing.filter((name) => !defined.has(name));
      const detail = [
        absent.length ? `尚未配置：${absent.join("、")}` : "",
        undecryptable.length
          ? `已保存但无法解密（多为换机或系统钥匙串变更导致）：${undecryptable.join("、")}`
          : "",
      ]
        .filter(Boolean)
        .join("；");
      throw new CustomProviderRuntimeError(
        "custom-provider-secret-missing",
        wanted,
        `供应商「${definition.id}」的 Secret ${detail}。请在「设置 → 模型服务 → Secret 管理」中重新填写后重试。`,
      );
    }
    for (const name of refs) {
      // 非空断言安全：envNames 与 vault 都已按 refs 逐项确认过。
      secretEnv[envNames.get(name)!] = vault[name]!;
    }
  }

  // 占位替换在**文本层**做，再 parse 成对象：这样 JSON 结构、嵌套 headers 等都无需逐字段遍历，
  // 且能保证 extension 文件里绝无明文（下面的 JSON.stringify 只会看到占位符）。
  const substituted = JSON.parse(substituteSecretPlaceholders(definition.json, envNames)) as Record<string, unknown>;
  // `id` 由 registerProvider 的第一个实参承担；把用户 JSON 里可能带大小写/空格的 `id` 一并
  // 塞进 config 只会与注册名产生歧义，故剔除。其余字段（name/baseUrl/api/models/headers…）原样下发。
  delete substituted.id;
  stripNonPiModelFields(substituted);

  const extensionPath = writePiExtensionFile(wanted, renderPiExtensionSource(wanted, substituted));
  return { providerId: wanted, extensionPath, secretEnv, updatedAt: definition.updatedAt };
}

// ── pi 会话的三段式 provider 解析 ────────────────────────────────────────────

/**
 * 读 Catalog 且吞掉加载异常，与 `pi-providers.ts` 的 `classifyPiProvider` 同一约定。
 *
 * `getProviderCatalog()` 的文档说「失败时返回结构化错误，不抛异常」，但那只覆盖**校验**失败：
 * 它内部先经 `resolvePiBinary()` 定位随包目录，二进制缺失或 `app` 尚未就绪时会直接抛
 *（单测里已实测到 `Cannot read properties of undefined (reading 'isPackaged')`）。
 * 一次目录定位失败不该把整个聊天打死 —— 取不到就当「Catalog 不可用」走降级分支。
 */
function readCatalogSafely(): ProviderCatalog | undefined {
  try {
    return getProviderCatalog();
  } catch {
    return undefined;
  }
}

/** 解析结果：内建路径与自定义路径的产物形状不同，用 kind 区分，调用方各自接线。 */
export type SessionProviderResolution =
  | { kind: "builtin"; provider: PiProviderInput; extensionPath: string }
  | { kind: "custom"; runtime: CustomProviderRuntime };

/**
 * 由 providerId 解析出会话要用的 provider：**Catalog → 自定义 → 响亮失败**。
 *
 * 三段的顺序是刻意的：
 *  1. 命中随包 Catalog（= pi 内置目录）→ 走内建路径，绝不下发 models（`pi-providers.ts` 的核心
 *     不变量）。放在最前，避免用户用同名 id 的自定义定义把内建目录整体替换掉 —— 那正是
 *     2026-07-30 能力事故的形态。
 *  2. 命中自定义列表 → 渲染 extension + 算 Secret env。
 *  3. 都不命中 → 抛错。调用方（`pi:open`）在 spawn 之前就会失败，pi 进程根本不会被拉起来。
 *
 * ⚠️ Catalog 不可用（构建产物缺失 / 校验失败）时的降级：先让自定义列表有机会命中，
 * 再退回内建路径。若顺序反过来，Catalog 一次加载失败就会把所有自定义 Provider 误判成内建
 * （`classifyPiProvider` 的 unclassified 分支），pi 拿不到任何 models，会话必挂。
 */
export async function resolvePiSessionProvider(providerId: string): Promise<SessionProviderResolution> {
  const id = safeId(providerId);
  const catalog = readCatalogSafely();
  const inCatalog = catalog?.providers.some((p) => p.id === id) ?? false;

  if (inCatalog) return builtinResolution(providerId, id);

  const runtime = await resolveCustomProviderExtension(providerId);
  if (runtime) return { kind: "custom", runtime };

  // Catalog 不可用：无法断言「这个 id 不存在」，按内建保守处理（同 classifyPiProvider 的取舍：
  // 误把自定义当内建会得到 pi 侧一次响亮的「no models available」，而不是静默降级能力）。
  if (!catalog) return builtinResolution(providerId, id);

  throw new CustomProviderRuntimeError(
    "custom-provider-not-found",
    id,
    `供应商「${providerId}」未配置，无法启动会话。请在「设置 → 模型服务」中检查该供应商是否仍存在。`,
  );
}

/**
 * 单发路径（cli 单发 / ask / automation / workflow headless）的守卫：命中自定义 Provider
 * 时**响亮失败**。
 *
 * 为什么是「拒绝」而不是「接上」：本阶段刻意只把自定义 Provider 收敛在聊天 RPC 一条路径上
 * 验证（方案 §A2），五个调用点同时改风险过高。但不加这道守卫，单发路径会重演本次事故 ——
 * `resolvePiProviderInput` 对自定义 id 返回 undefined，调用方**继续 spawn**，pi 拿到孤立的
 * `--model` 后走自己的兜底链换一个 provider，最终报一个与用户配置毫不相干的错。
 *
 * 非自定义 id 一律放行，既有行为完全不变。
 */
export async function assertOneShotProviderSupported(providerId: string | undefined): Promise<void> {
  if (!providerId) return;
  const wanted = safeId(providerId);
  let hit = false;
  try {
    // Catalog 命中说明是内建 provider，无需检查（自定义 id 与内建 id 撞车时以内建为准，
    // 与 resolvePiSessionProvider 的三段式顺序一致）。
    if (getProviderCatalog()?.providers.some((p) => p.id === wanted)) return;
    hit = (await listCustomProviders()).some((item) => safeId(item.id) === wanted);
  } catch {
    // 读不到 Catalog 或自定义列表（构建产物缺失 / 磁盘异常）时**放行**，保持接入这道守卫
    // 之前的既有行为。守卫的职责是拦下一种已知的错误配置，绝不该反过来成为新的失败源 ——
    // 真正的问题会在下游 spawn 时以原来的方式暴露出来。
    return;
  }
  if (!hit) return;
  throw new CustomProviderRuntimeError(
    "custom-provider-not-found",
    wanted,
    `自定义供应商「${providerId}」目前只支持在聊天中使用，该功能尚未接入自定义供应商。` +
      `请为它改选一个已内置的供应商。`,
  );
}

/** 内建路径：沿用既有的 Catalog + provider-prefs + 凭据金库解析，并生成 extension。 */
async function builtinResolution(providerId: string, id: string): Promise<SessionProviderResolution> {
  const provider = await resolvePiProviderInput(providerId);
  if (!provider) {
    throw new CustomProviderRuntimeError(
      "custom-provider-not-found",
      id,
      `供应商「${providerId}」未配置，无法启动会话。请在「设置 → 模型服务」中检查该供应商是否仍存在。`,
    );
  }
  return { kind: "builtin", provider, extensionPath: writePiExtension(provider) };
}
