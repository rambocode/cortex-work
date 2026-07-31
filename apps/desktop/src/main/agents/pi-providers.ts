// 把用户配置的供应商（Provider）渲染成 pi extension（registerProvider）,供 pi `-e` 加载。
// apiKey 不写进文件,用 $CORTEX_PI_KEY 占位,真实值由 cli.ts / pi-session.ts spawn 时经环境变量
// 注入（文件 0600,且不落明文 key）。
//
// ⚠️ 本文件的核心不变量（2026-07-30 能力事故的修复点）——
//   pi 的 `registerProvider(id, config)` 一旦带上 `config.models`,就会**整体替换**该 provider
//   的内置模型目录,而不是逐字段补充（provider-composer.js:108-131 的 applyExtension:
//   `if (!config.models) return ...base models...` / 否则 `return config.models.map(...)`）。
//   旧实现无论内建还是自定义 provider 都渲染完整 models,并给缺失字段兜底
//   `reasoning:false / input:["text"] / contextWindow:131072 / maxTokens:8192`,
//   于是 pi 内置的真实 `input:["text","image"]`、`thinkingLevelMap`、真实 context/maxTokens、
//   `compat` 全部丢失 —— pi 随后按这份被简化的元数据主动把图片替换成
//   `(image omitted: model does not support images)`。
//
//   因此现在按「provider 是否在随包 Provider Catalog（= pi 内置目录）中」分两条路径：
//     · 内建 provider → 只覆盖 endpoint 与认证,**绝不传 models**,保留 pi 内置目录;
//     · 自定义 provider → 必须给出完整 Pi Model 定义（input/reasoning/contextWindow/maxTokens）,
//       缺一不可,缺失即拒绝注册并抛结构化错误 —— 不再猜任何默认值。

import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { getProviderCatalog } from "../providers/catalog";
// 同步读:renderPiExtension → writePiExtension 是纯同步且跑在 spawn 前一刻,
// 异步预热会留下竞态窗口（spawn 早于加载完成时静默拿到「无覆盖」)。
import { getBaseUrlOverride } from "../providers/prefs";
import type { ProviderCatalog } from "../providers/contract";
import type { EndpointFormat, PiProviderInput, PiProviderModelInput } from "../ipc/types";

// ProviderInput 的唯一定义已上移到 ipc/types.ts（单发与 RPC 两条路径共用）。
// 这里保留别名,避免各调用点大面积改 import。
export type ProviderInput = PiProviderInput;

// spawn 时注入的环境变量名,与渲染出的 extension 中 apiKey 占位一致。
export const PI_KEY_ENV = "CORTEX_PI_KEY";

// 把设置页的 endpointFormat 映射到 pi provider extension 的 `api` 字段（pi 合法值见 pi-ai
// types：openai-completions / openai-responses / anthropic-messages / google-generative-ai）。
// custom 暂按 OpenAI 兼容兜底（pi 无对应 api 值,UI 上 custom 语义是「不可探测」而非「非 OpenAI 协议」）。
// ⚠️ 只对自定义 provider 生效:内建 provider 的 `api` 属于 pi 内置目录的一部分,覆盖它会与内置
// 模型自带的 api 冲突,故内建路径根本不下发该字段。
export function endpointFormatToApi(fmt?: EndpointFormat): string {
  switch (fmt) {
    case "responses":
      return "openai-responses";
    case "messages":
      return "anthropic-messages";
    case "chat_completions":
    case "custom":
    default:
      return "openai-completions";
  }
}

// 文件名/ provider 名安全化:仅保留字母数字与 - _,其余替换为 -。
// 导出供 buildArgs/buildRpcArgs 复用:`--provider` 必须与 registerProvider 的注册名同源,
// 否则 id 含空格/大写时选不中。
export function safeId(id: string): string {
  const s = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "provider";
}

// ── 结构化错误 ────────────────────────────────────────────────────────────────

/** 单条配置缺陷:定位到 provider 或具体某个 model 的某个字段。 */
export interface PiProviderConfigIssue {
  modelId?: string;
  field: string;
  message: string;
}

// 自定义 provider 配置不完整时抛出。刻意用异常而非返回值:writePiExtension 的返回值（路径 string）
// 被 cli / ask / automation / workflow / pi-session 五处直接消费,且这些调用点本就把
// writePiExtension 的同步 fs 异常纳入了错误处理（见 automation/runner.ts:147 的注释）,
// 抛错能让「配置不完整」沿现成的错误通道一路冒泡到用户,而不需要改五处签名。
export class PiProviderConfigError extends Error {
  readonly code = "pi-provider-config-incomplete";
  readonly providerId: string;
  readonly issues: PiProviderConfigIssue[];

  constructor(providerId: string, issues: PiProviderConfigIssue[]) {
    const detail = issues
      .map((i) => (i.modelId ? `模型 ${i.modelId} 的 ${i.field}：${i.message}` : `${i.field}：${i.message}`))
      .join("；");
    super(`自定义供应商「${providerId}」配置不完整，已拒绝注册：${detail}`);
    this.name = "PiProviderConfigError";
    this.providerId = providerId;
    this.issues = issues;
  }
}

// ── Catalog 查询（可注入,便于单测） ──────────────────────────────────────────

let catalogLoader: () => ProviderCatalog | undefined = getProviderCatalog;

/** 单测注入点:传 null 恢复读取真实随包 Catalog。 */
export function setPiProviderCatalogLoaderForTest(fn: (() => ProviderCatalog | undefined) | null): void {
  catalogLoader = fn ?? getProviderCatalog;
}

/** provider 的注册模式。 */
export type PiProviderRegistrationMode =
  /** id 命中 pi 内置目录:只覆盖 endpoint/认证,保留内置模型目录。 */
  | "builtin"
  /** id 不在内置目录:必须自带完整模型定义。 */
  | "custom"
  /** Catalog 不可用,无法判定 —— 按内建方式保守处理（见 classifyPiProvider 注释）。 */
  | "unclassified";

export interface PiProviderClassification {
  mode: PiProviderRegistrationMode;
  /** 命中的内置 provider 在 Catalog 中记录的 baseUrl（用于判断用户是否显式覆盖）。 */
  catalogBaseUrl?: string;
}

// 判定 provider 是否是 pi 内置。匹配键用 safeId(id)——它同时是 registerProvider 的注册名与
// `--provider` 的选择名,与 Catalog 里的 pi provider id（本就是小写 slug）同域。
//
// ⚠️ Catalog 不可用时（构建产物缺失 / 版本校验失败 / dev 未生成）刻意**按内建处理**,而不是
// 退回旧的「猜默认值」行为,也不是直接拒绝注册。理由是两种误判的代价完全不对称：
//   · 误把内建当自定义 → 会下发一份猜出来的 models → 静默替换 pi 内置目录 = 本次事故重演;
//   · 误把自定义当内建 → 该 provider 没有任何模型,pi 会直接报「no models available」,
//     是一次响亮且可诊断的失败,不会悄悄降级能力。
// 沉默的错误比响亮的错误危险得多,所以降级方向选后者。
export function classifyPiProvider(provider: ProviderInput): PiProviderClassification {
  // Catalog 加载是另一个模块的职责,读盘/校验失败都不该让 extension 生成整体崩掉 —— 取不到就降级。
  let catalog: ProviderCatalog | undefined;
  try {
    catalog = catalogLoader();
  } catch {
    catalog = undefined;
  }
  if (!catalog) return { mode: "unclassified" };
  const id = safeId(provider.id);
  const hit = catalog.providers.find((p) => p.id === id);
  return hit ? { mode: "builtin", catalogBaseUrl: hit.baseUrl } : { mode: "custom" };
}

// ── extension 配置构造 ───────────────────────────────────────────────────────

// baseUrl 归一化:仅用于「用户是否显式覆盖了内置 endpoint」的比较,末尾斜杠与大小写差异不算覆盖。
function normalizeBaseUrl(url: string | undefined): string {
  return (url ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

// apiKey 占位只在**本次确有 key 要注入**时下发,这条规则对内建与自定义两条路径都成立。
//
// ⚠️ 不能无条件下发（0.82.1 实测,与 OAuth 直接冲突）：pi 的 composeApiKeyAuth 有一条守卫
// `if (!inherited && rawKey === undefined && oauth) return undefined;`
// （provider-composer.js:179-185,注释原文 "OAuth-only providers get no fabricated API-key
// login method"）。只要 extension 里带了 apiKey 字段,rawKey 就不再是 undefined,这条守卫被绕过,
// pi 会给一个**纯 OAuth** provider 凭空造出 API-key 认证方式。实测（openai-codex,未登录,
// CORTEX_PI_KEY 已设置）：
//   带 apiKey 占位 → 真拿 key 去请求 → `Failed to extract accountId from token`,
//                    用户永远看不到「请用 OAuth 登录」的指引;
//   不带 apiKey    → 正确落到 `Use /login to log into a provider via OAuth or API key.`
// （已登录的情况不受影响:auth/resolve.js 的 resolveProviderAuth 里「stored credential owns the
// provider」,OAuth 凭据优先于 apiKey——所以问题只出在未登录 / ambient 认证这一侧。）
//
// 省略 apiKey 后 config 可能是空对象 `{}`,pi 接受（实测:模型目录照常、认证指引正确）。
function authFields(provider: ProviderInput): Record<string, unknown> {
  return provider.apiKey?.trim() ? { apiKey: `$${PI_KEY_ENV}` } : {};
}

// 内建 provider 的注册配置:只有认证与「用户显式覆盖时」的 baseUrl。
// **绝不含 models / api / name** —— 那些属于 pi 内置目录。
//
// baseUrl 的真源有两处,main-owned 的覆盖优先:
//   · `provider-prefs.json` 的 baseUrlOverride —— 阶段② 的「高级 baseUrl 覆盖」,经
//     `providerAuth:setBaseUrl` 写。渲染端读不到也不该持有它（塞回 personal-workspace.json
//     会被 toPersistedState 白名单 clobber,这正是它落在 main 侧的原因）。
//   · `provider.baseUrl` —— 渲染端经 CliStartRequest.provider 传入,源自已废弃的 providerSettings。
// 不接前者的话,用户在设置页填了自建网关、extension 里却没有 baseUrl,请求照旧发往官方端点 ——
// 一次没有任何报错的静默失败。查询键用 safeId(id):与 classifyPiProvider 匹配 Catalog 的键同域,
// 直接用 provider.id 在含大写/空格时查不中。
function builtinProviderConfig(provider: ProviderInput, catalogBaseUrl?: string): Record<string, unknown> {
  const config: Record<string, unknown> = authFields(provider);
  const effective = getBaseUrlOverride(safeId(provider.id)) ?? provider.baseUrl;
  const configured = normalizeBaseUrl(effective);
  // Catalog 未知 baseUrl（unclassified 降级路径）时保守下发用户填的值:对真内建 provider 而言,
  // 用户填的通常就是官方地址,applyExtension 只会把它写回各模型的 baseUrl,不动能力字段。
  if (configured && normalizeBaseUrl(catalogBaseUrl) !== configured) config.baseUrl = effective.trim();
  return config;
}

// 把过渡期的旧 UI 字段直转为 Pi Model 字段（**只是改名,不是猜值**）:
//   vision:boolean → input: ["text"] / ["text","image"]
//   contextTokens  → contextWindow
// 阶段③ 的 JSON 编辑器落地后,input/contextWindow 会被直接填写,这两个回退自然失效。
function resolveModelInput(model: PiProviderModelInput): ("text" | "image")[] | undefined {
  if (model.input?.length) return model.input;
  if (model.vision === undefined) return undefined;
  return model.vision ? ["text", "image"] : ["text"];
}

function resolveContextWindow(model: PiProviderModelInput): number | undefined {
  return model.contextWindow ?? model.contextTokens;
}

// 自定义 provider 的注册配置:完整下发 models。缺任一能力字段即收集为 issue 并整体拒绝 ——
// pi 自己的 ProviderConfigInput.models[] 类型里 reasoning/input/cost/contextWindow/maxTokens
// 也都是必填（provider-composer.d.ts:23-35）,这里的严格校验与 pi 的契约同源。
function customProviderConfig(provider: ProviderInput): Record<string, unknown> {
  const issues: PiProviderConfigIssue[] = [];
  const models = provider.models.map((m) => {
    const input = resolveModelInput(m);
    const contextWindow = resolveContextWindow(m);
    if (!input?.length) issues.push({ modelId: m.id, field: "input", message: "缺少图片/文本输入能力声明" });
    if (m.reasoning === undefined) issues.push({ modelId: m.id, field: "reasoning", message: "缺少推理能力声明" });
    if (!contextWindow || contextWindow <= 0) {
      issues.push({ modelId: m.id, field: "contextWindow", message: "缺少上下文窗口大小" });
    }
    if (!m.maxTokens || m.maxTokens <= 0) {
      issues.push({ modelId: m.id, field: "maxTokens", message: "缺少最大输出 token 数" });
    }
    return {
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning,
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
      input,
      // cost 本地不做计费,全 0 是**确定的取值**而非对能力的猜测,不影响 pi 的图片/推理/截断行为。
      cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: m.maxTokens,
      ...(m.compat !== undefined ? { compat: m.compat } : {}),
    };
  });
  if (!normalizeBaseUrl(provider.baseUrl)) {
    issues.push({ field: "baseUrl", message: "自定义供应商必须提供接口地址" });
  }
  if (issues.length) throw new PiProviderConfigError(provider.id, issues);
  // apiKey 同样按「确有 key 才下发」（见 authFields）。自定义 provider 没填 key 时 pi 会把它
  // 视为未认证（无内置 auth 可继承）→ 报「provider 未配置」,这是响亮且可诊断的失败。
  // 这里刻意**不**新增一条「必须填 API Key」的拒绝理由:无鉴权的本地端点（Ollama / LM Studio）
  // 是否合法本次没有实证,不该顺手把它们一起挡掉。待阶段③ JSON 编辑器落地时再定。
  return {
    name: provider.id,
    baseUrl: provider.baseUrl,
    ...authFields(provider),
    api: endpointFormatToApi(provider.endpointFormat),
    models,
  };
}

/**
 * 构造交给 `pi.registerProvider` 的配置对象（纯函数,便于断言「内建 provider 不含 models」）。
 * 自定义 provider 配置不完整时抛 PiProviderConfigError。
 */
export function buildPiProviderConfig(provider: ProviderInput): Record<string, unknown> {
  const { mode, catalogBaseUrl } = classifyPiProvider(provider);
  return mode === "custom" ? customProviderConfig(provider) : builtinProviderConfig(provider, catalogBaseUrl);
}

/**
 * 渲染 extension 源码（纯函数,便于单测）。所有动态值经 JSON.stringify 编码,
 * 引号/反斜杠不会逃逸出字符串字面量。
 */
export function renderPiExtension(provider: ProviderInput): string {
  const id = safeId(provider.id);
  const config = JSON.stringify(buildPiProviderConfig(provider), null, 2).replace(/\n/g, "\n  ");
  return [
    "// 由 Cortex Desktop 自动生成,请勿手改。",
    "export default function (pi) {",
    `  pi.registerProvider(${JSON.stringify(id)}, ${config});`,
    "}",
    "",
  ].join("\n");
}

/** 写出 extension 文件,返回绝对路径。per-provider 一个文件,key 隔离清晰。 */
export function writePiExtension(provider: ProviderInput): string {
  // 先渲染再建目录:配置不完整时直接抛错,不留下空目录/半截文件。
  const source = renderPiExtension(provider);
  const dir = join(app.getPath("userData"), "pi-providers");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeId(provider.id)}.js`);
  writeFileSync(file, source, { mode: 0o600 });
  return file;
}
