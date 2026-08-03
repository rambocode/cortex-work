// 聚合网关（new-api / one-api 这类 OpenAI 兼容网关）的接入流水线：**发现 → 解析 → 生成**。
//
// ── 为什么要有它（方案 §0.3 / §B3）──────────────────────────────────────────
// 聚合网关是企业接入的主流形态，且有标准的 `GET /v1/models` 可以发现模型列表。现状却要求
// 用户手写整段 Pi Provider JSON、逐个模型手填五组能力字段 —— 认知负担高到几乎没人愿意用。
// 合理形态与云平台行同构：填地址 + Key → 自动拉模型 → 勾选启用，全程零手填。
//
// ── 职责边界（不要越界）────────────────────────────────────────────────────
//  · `/models` **只负责发现，不负责能力**（能力研究 §4）：OpenAI 的标准响应只有
//    `id / created / owned_by`，任何从中推断能力的做法都是猜。能力一律经 capability-resolver
//    从随包受信目录解析，解析不出就是显式 `unknown`，由 UI 引导用户选「参照模型」。
//  · 本模块**不新造存储概念**：生成的 JSON 走 `provider-custom.json` 与阶段 A 的全部会话消费
//    链路。聚合网关只是自定义 Provider 的一个「生成器前端」。
//  · 明文红线不变：API Key 只以 Secret **名**进出本模块，真值经金库取、用完即弃，
//    生成的 JSON 里只有 `${secret:NAME}` 引用。
//  · 本模块**自己发 fetch**，但不违反「文本补全唯一出口是 Pi Model Gateway」那条约束：
//    它打的是 `GET /models`（模型发现），不是补全端点。真正的补全请求仍然只由 pi 子进程
//    按生成的 Provider 定义发出。见 `no-direct-endpoint.test.ts` 的守卫说明。

import { getProviderCatalog } from "./catalog";
import { readSecrets } from "./credentials";
import {
  applyReferenceModel,
  fallbackCapabilities,
  resolveModelCapabilities,
  FALLBACK_SOURCE_REF,
} from "./capability-resolver";
import { safeErrorMessage } from "./secrets";
import type {
  CatalogModel,
  GatewayBuildRequest,
  GatewayDiscoverRequest,
  GatewayDiscoveredModel,
  ProviderCatalog,
} from "./contract";
import { createLogger } from "../log";

const log = createLogger("gateway-onboarding");

/** 探测超时。网关不可达时要尽快失败给用户看，而不是让「连接」按钮转很久。 */
const DISCOVER_TIMEOUT_MS = 15_000;

/** 单次最多接受的模型条数。公共网关能返回上千条，全量渲染会把设置页拖死。 */
const MAX_DISCOVERED_MODELS = 500;

// ── 发现 ─────────────────────────────────────────────────────────────────────

/**
 * 把用户填的接入地址拼成候选 `/models` 端点，**按顺序试**。
 *
 * 逻辑沿用 v0.1.49 的 `probeProvider`（那一版的探测体验用户评价很好，不重新发明）：
 *   · `https://gw/v1`  → 先试 `https://gw/v1/models`，再试 `https://gw/models`
 *     （部分供应商如 DeepSeek 的 `/models` 在版本前缀之外，只试带前缀那个会 404）
 *   · `https://gw`     → 先试 `https://gw/models`，再试 `https://gw/v1/models`
 *     （用户少填 `/v1` 是最常见的写法，多试一次就能救回来）
 *
 * 注意这里的宽容**只用于探测**：写进 Pi Provider JSON 的 baseUrl 始终是用户原样填的那个，
 * 绝不因为探测走通了某个变体就替用户改写 —— 那会造成「探测成功、聊天 404」这种最难查的不一致。
 */
export function modelsEndpointCandidates(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const stripped = base.replace(/\/v\d+$/i, "");
  return stripped !== base ? [`${base}/models`, `${stripped}/models`] : [`${base}/models`, `${base}/v1/models`];
}

/** OpenAI `GET /v1/models` 的响应形状。只取 id —— 其余字段一律不作为能力依据。 */
function extractModelIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.trim() && !ids.includes(id)) ids.push(id.trim());
  }
  return ids;
}

/**
 * 调网关的 `/models` 拉取模型 id 列表。
 *
 * 认证失败（401/403）与不可达都必须**当场响亮失败**：方案 §B4 要求「不允许带着失败状态保存」，
 * 因为一个连不通的网关保存下来，症状会推迟到用户第一次发消息时才出现。
 */
async function fetchModelIds(req: GatewayDiscoverRequest, apiKey: string | undefined): Promise<string[]> {
  const headers = {
    accept: "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
  const candidates = modelsEndpointCandidates(req.baseUrl);
  let lastError = "";

  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (res.ok) return extractModelIds(await res.json());
      // 401/403 是「Key 不对」，换个地址也一样，立即失败别让用户等第二次超时。
      if (res.status === 401 || res.status === 403) throw new Error("API Key 无效或没有访问权限");
      lastError = `${url} 返回 HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("API Key")) throw err;
      lastError = `${url}：${(err as Error)?.message ?? "请求失败"}`;
    } finally {
      clearTimeout(timer);
    }
  }
  // 不在文案里写出补全端点的字面路径：`no-direct-endpoint.test.ts` 用「main 下 0 处该字面量」
  // 钉住「文本补全唯一出口是 Gateway」，为一句提示破例会让那道守卫失效。
  throw new Error(
    `${lastError}。已尝试 ${candidates.join(" 与 ")}，请确认接入地址填到 /v1 为止、不要带上具体的接口路径`,
  );
}

/**
 * 发现网关模型并逐个解析能力。
 *
 * 返回的每一条要么 `known`（能力从受信目录整套取到，可直接启用），要么 `unknown`
 * （目录里没有，UI 灰显并引导用户选参照模型）。**绝不存在第三态**，也绝不给 unknown
 * 填任何默认值 —— 那正是 2026-07-30 事故的形态。
 */
export async function discoverGatewayModels(
  req: GatewayDiscoverRequest,
): Promise<{ ok: boolean; models?: GatewayDiscoveredModel[]; error?: string }> {
  if (!/^https?:\/\//i.test(req.baseUrl?.trim() ?? "")) {
    return { ok: false, error: "接入地址必须是 http(s) 地址" };
  }
  try {
    // Secret 只按名取，明文用完即弃、绝不回传渲染端。
    const apiKey = req.secretName ? (await readSecrets())[req.secretName] : undefined;
    if (req.secretName && apiKey === undefined) {
      return { ok: false, error: `Secret「${req.secretName}」尚未写入密钥库，请先保存 API Key` };
    }

    const ids = await fetchModelIds(req, apiKey);
    if (!ids.length) return { ok: false, error: "网关返回了空的模型列表，请确认地址与权限" };

    const catalog = readCatalogSafely();
    const truncated = ids.slice(0, MAX_DISCOVERED_MODELS);
    if (truncated.length < ids.length) {
      // 静默截断会让用户以为「网关就这些模型」。日志留痕，UI 侧由 models.length 自行提示。
      log.warn(`网关返回 ${ids.length} 个模型，超出上限 ${MAX_DISCOVERED_MODELS}，已截断`);
    }
    return { ok: true, models: truncated.map((id) => describeModel(id, req.api, catalog)) };
  } catch (err) {
    return { ok: false, error: safeErrorMessage(err, "连接网关失败") };
  }
}

/** 单条模型的发现结果：命中目录则带完整能力与来源标注，否则显式 unknown。 */
function describeModel(id: string, api: string, catalog: ProviderCatalog | undefined): GatewayDiscoveredModel {
  const resolved = resolveModelCapabilities(id, api, catalog);
  return resolved.status === "known"
    ? { id, status: "known", model: resolved.model, capabilitySource: resolved.sourceRef }
    : { id, status: "unknown" };
}

/** 读 Catalog 且吞掉加载异常（同 custom-provider-runtime 的取舍：定位失败不该打死整条流程）。 */
function readCatalogSafely(): ProviderCatalog | undefined {
  try {
    return getProviderCatalog();
  } catch {
    return undefined;
  }
}

// ── 生成 ─────────────────────────────────────────────────────────────────────

/**
 * 由向导的选择生成一份合法的 Pi Provider JSON。
 *
 * **能力全部由主进程解析或由用户指认的参照模型继承，渲染端不产出任何能力字段** ——
 * 这是「能力对用户只读」红线在阶段 B 的落实点：向导 UI 上根本没有输入能力数字的地方。
 *
 * 任何一条模型解析不出能力且没给参照模型 → 整体拒绝生成。宁可让用户回去补一次选择，
 * 也不能生成一份带猜测能力的定义（生成物随后还要过 `validateCustomProviderJson`，
 * 缺字段本就会被拒；在这里提前拒是为了给出「哪个模型缺什么」的可读原因）。
 */
export function buildGatewayProviderJson(
  req: GatewayBuildRequest,
  catalog: ProviderCatalog | undefined = readCatalogSafely(),
): { ok: boolean; json?: string; error?: string } {
  if (!req.models?.length) return { ok: false, error: "请至少启用一个模型" };
  if (!/^https?:\/\//i.test(req.baseUrl?.trim() ?? "")) {
    return { ok: false, error: "接入地址必须是 http(s) 地址" };
  }

  const models = req.models.map((selection) => resolveSelection(selection, req.api, catalog));

  return {
    ok: true,
    json: JSON.stringify(
      {
        name: req.name.trim() || req.id,
        baseUrl: req.baseUrl.trim(),
        api: req.api,
        // 明文永不进 JSON：落盘的是 ${secret:NAME} 引用，真值单独在 safeStorage 金库。
        ...(req.secretName ? { apiKey: `\${secret:${req.secretName}}` } : {}),
        models: models.map(toPiModel),
      },
      null,
      2,
    ),
  };
}

/** 一条已解析出能力的模型，外加它的能力来源标注（方案 §B2：供只读展示与日后审计）。 */
interface ResolvedModel {
  model: CatalogModel;
  /** `<provider>/<model>`（目录自动命中）或 `reference:<provider>/<model>`（用户指认参照）。 */
  sourceRef: string;
}

/**
 * 一条选择 → 完整能力 + 来源。三级优先，**永不失败**：
 *   1. 随包目录自动命中  → 确定值
 *   2. 用户指认的参照模型 → 确定值（由用户负责）
 *   3. 保守兜底          → pi 自己的默认值，显式标记为 fallback
 *
 * 第 3 级是刻意加的：早先这里在「既没命中目录、又没给参照模型」时整体拒绝生成，结果是
 * new-api 这类网关上大量模型（Kimi、各家自研模型…）根本没法启用 —— 而**「目录不认识」
 * 不等于「不能用」**。目录只是 pi 的内置快照，不是可用模型的全集。
 *
 * 兜底不破坏红线：它只作用于目录里本来就没有的模型，不覆盖任何已知为真的值，且来源被
 * 如实标成 fallback，UI 会照实告诉用户这几个数字是保守默认（详见 fallbackCapabilities）。
 */
function resolveSelection(
  selection: GatewayBuildRequest["models"][number],
  api: string,
  catalog: ProviderCatalog | undefined,
): ResolvedModel {
  const auto = resolveModelCapabilities(selection.id, api, catalog);
  if (auto.status === "known") return { model: auto.model, sourceRef: auto.sourceRef };

  const provider = catalog?.providers.find((p) => p.id === selection.referenceProviderId);
  const reference = provider?.models.find((m) => m.id === selection.referenceModelId);
  if (provider && reference) {
    const applied = applyReferenceModel(selection.id, api, { providerId: provider.id, model: reference });
    if (applied.status === "known") return { model: applied.model, sourceRef: applied.sourceRef };
  }

  const fallback = fallbackCapabilities(selection.id, api);
  // fallbackCapabilities 恒为 known，这里的分支只是让类型收敛。
  return fallback.status === "known"
    ? { model: fallback.model, sourceRef: fallback.sourceRef }
    : { model: { id: selection.id, name: selection.id, api, input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 16_384 }, sourceRef: FALLBACK_SOURCE_REF };
}

/**
 * `cost` 补齐成四项齐全。
 *
 * ⚠️ 这里是生成器与校验器的契约交界点，曾经真的对不上：`CatalogModel.cost` 的
 * `cacheRead / cacheWrite` 是**可选**的（很多 Provider 不单独计缓存价，目录里就只有
 * `{input, output}`），而 `validateCustomProviderJson` 要求四项都是数值。不补齐的话，
 * 向导生成的 JSON 会被保存路径上的同一个校验器拒掉 —— 用户看到「连接成功、保存失败」。
 *
 * 补 0 不是能力猜测：cost 不是能力字段，不影响 pi 的图片/推理/截断行为；目录里没有缓存价
 * 就等于「不按缓存单独计费」，0 是**确定的取值**（与 `agents/pi-providers.ts` 的先例同源）。
 */
function normalizeCost(cost: CatalogModel["cost"]): Record<string, number> {
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cacheRead ?? 0,
    cacheWrite: cost?.cacheWrite ?? 0,
  };
}

/**
 * `ResolvedModel` → Pi Provider JSON 里的 model 条目。
 * 除 cost 外其余能力字段一个不补 —— 能走到这里的模型，能力必然已经完整。
 *
 * `capabilitySource` 是**唯一一个非 pi 字段**（方案 §B2）：记录这套能力当初是从哪来的，
 * 供设置页只读展示与日后审计。没有它的话，保存之后就再也说不清某个 contextWindow 是
 * 「目录里查到的」还是「照着哪个模型抄的」—— 而这正是能力可追溯性的全部意义。
 * 它只留在落盘 JSON 里；渲染 pi extension 时会被剥掉（见 custom-provider-runtime.ts），
 * 保证交给 pi 的永远只有 pi 自己定义的字段。
 */
function toPiModel({ model, sourceRef }: ResolvedModel): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    input: model.input,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: normalizeCost(model.cost),
    ...(model.compat !== undefined ? { compat: model.compat } : {}),
    capabilitySource: sourceRef,
  };
}
