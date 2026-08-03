// 由「模型 id + 网关协议」从随包 Provider Catalog 解析出**完整、确定**的能力元数据。
//
// ── 它解决什么问题（方案 §0.2 / §B1）────────────────────────────────────────
// 自定义 Provider 要求用户手填 contextWindow / maxTokens / input / reasoning / cost 五组字段，
// 认知负担极高 —— 而这些数据 Cortex 手里本来就有：随包 Catalog 就是 pi 内置目录的完整快照。
// 用户经 new-api 这类聚合网关接进来的，绝大多数就是官方同名模型（gpt-4o、claude-sonnet…），
// 完全可以从目录里原样取，不必让用户去查资料。
//
// ── 三条不可让步的约束 ──────────────────────────────────────────────────────
//  1. **不猜能力**：解析结果只有 `known`（目录里查到，全字段照抄）与 `unknown`（显式未知）
//     两态。`unknown` 绝不折算成 `text-only / no-reasoning` —— 那正是 2026-07-30 事故的形态。
//  2. **匹配保守**：只做「小写 + 去 `-latest` 后缀」这类确定性归一，**不做模糊包含匹配**。
//     `gpt-4o-mini` 与 `gpt-4o` 是两个模型，宁可 unknown 也不错配。
//  3. **协议是匹配键的一部分**（能力研究 §5.3）：同名模型经不同协议，`compat` 与推理参数的
//     翻译方式不同。跨协议复用时必须丢掉 `compat`（见 pickCandidate 的说明）。

import type { CatalogModel, ProviderCatalog } from "./contract";

/** 能力解析结果。刻意只有两态 —— 「未知」是一等状态，不允许被兜底成任何默认值。 */
export type CapabilityResolution =
  | {
      status: "known";
      /** 命中的目录条目来源，形如 `openai/gpt-4o`。只读展示与日后审计用。 */
      sourceRef: string;
      /** 已按目标协议改写过的完整模型定义，可直接写进 Pi Provider JSON。 */
      model: CatalogModel;
    }
  | { status: "unknown" };

/**
 * 模型 id 归一化：只做**确定性**变换，不做模糊匹配。
 *
 * - 小写：目录里是小写 slug，网关常回大小写混排的 id；
 * - 去 `-latest` / `:latest` 后缀：这是同一模型的滚动别名，不是另一个模型。
 *
 * 刻意**不**做的：去版本日期后缀（`gpt-4o-2024-08-06` → `gpt-4o`）、去 `-mini` / `-turbo`、
 * 子串包含匹配。这些"看起来合理"的归一都会把能力不同的模型混为一谈，而错配的代价
 * （用一份错误能力去请求）比 unknown（让用户点一次参照模型）大得多。
 */
export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/[-:]latest$/, "");
}

/**
 * 网关模型 id 常带「渠道前缀」，如 new-api 的 `openai/gpt-4o`、`azure/gpt-4o`。
 * 取最后一段再匹配，是本模块唯一一处"猜"，但它是结构性的（分隔符明确）而非语义性的，
 * 且只在整串匹配失败后才尝试 —— 不会把 `openai/gpt-4o` 误当成别的模型。
 */
function idCandidates(modelId: string): string[] {
  const normalized = normalizeModelId(modelId);
  const tail = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : "";
  return tail && tail !== normalized ? [normalized, tail] : [normalized];
}

/** 目录中所有 id 归一后等于 `wanted` 的条目（跨 Provider）。 */
function collectMatches(
  catalog: ProviderCatalog,
  wanted: string,
): { providerId: string; model: CatalogModel }[] {
  const out: { providerId: string; model: CatalogModel }[] = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (normalizeModelId(model.id) === wanted) out.push({ providerId: provider.id, model });
    }
  }
  return out;
}

/** 参与「同名模型是否等价」判定的能力字段。cost 与 name 不算能力，不参与。 */
function capabilitySignature(model: CatalogModel): string {
  return JSON.stringify({
    input: [...model.input].sort(),
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap ?? null,
  });
}

/**
 * 从候选里选一条，并按目标协议改写。
 *
 * ── 关于 `compat`：**一律保留，绝不因为协议不同就丢掉** ──────────────────────
 * 早先这里的规则是「api 不一致就丢掉 compat」，理由写的是「丢掉只会回到该 api 的默认行为，
 * 是安全方向」。**实测证明这句话是反的**（用随包 pi 二进制 + 假网关逐条抓请求）：
 *
 *   reasoning:false + 无 compat → role: system    / max_completion_tokens
 *   reasoning:true  + 无 compat → role: developer / max_completion_tokens   ← 400 的来源
 *   reasoning:true  + 有 compat → role: system    / max_tokens
 *
 * 也就是说 pi 对**推理模型**的默认行为是「按现代 OpenAI 约定发 `developer` 角色」，而经
 * new-api 这类网关转发到的上游（MiniMax / Kimi / 国产模型…）只认 system/assistant/user/tool，
 * 于是直接 400：`invalid value: developer`。`max_completion_tokens` 同理。
 *
 * 目录里 `supportsDeveloperRole` 414 处**全为 false**、`maxTokensField` 93 处**全为
 * "max_tokens"** —— 这些 compat 存在的唯一意义就是替非 OpenAI 上游关掉这些约定。丢掉它
 * 等于主动把请求拼成上游不认识的形状。
 *
 * 跨协议保留是否会带错键？pi 的 compat 是一套**扁平词表**，各 api 适配器只读自己关心的键，
 * 不认识的键被忽略（目录里 `opencode` 这个 provider 自身 api 是 openai-responses、其
 * minimax-m2.7 模型却是 openai-completions 并带 compat，pi 自己就这么混用）。
 * 权衡下来：多带一个会被忽略的键，代价远小于少带一个会导致 400 的键。
 *
 * 优先取 `api` 与网关协议完全一致的候选 —— 那条的 compat 与目标协议同源，最贴切。
 *
 * 若多条候选在能力上互相矛盾（同名模型经不同 Provider 能力不同），返回 undefined →
 * 整体 unknown。宁可让用户点一次参照模型，也不能随便挑一条。
 */
function pickCandidate(
  matches: { providerId: string; model: CatalogModel }[],
  targetApi: string,
): { sourceRef: string; model: CatalogModel } | undefined {
  if (!matches.length) return undefined;

  const exact = matches.filter((m) => m.model.api === targetApi);
  const pool = exact.length ? exact : matches;

  // 能力互相矛盾 → 无法确定该用哪一份，退回 unknown。
  const signatures = new Set(pool.map((m) => capabilitySignature(m.model)));
  if (signatures.size > 1) return undefined;

  const hit = pool[0]!;
  return {
    sourceRef: `${hit.providerId}/${hit.model.id}`,
    model: { ...hit.model, api: targetApi },
  };
}

/**
 * 解析一个网关模型 id 的能力。
 *
 * `targetApi` 是**网关实际说的协议**（聚合网关一律 OpenAI 兼容 → `openai-completions`），
 * 不是目录里那条记录原本的协议 —— 请求真正要按网关的协议发出去。
 *
 * Catalog 不可用（构建产物缺失 / 校验失败）时一律 unknown：这时候「查不到」是真的查不到，
 * 让用户走参照模型补全，而不是编一份能力出来。
 */
export function resolveModelCapabilities(
  modelId: string,
  targetApi: string,
  catalog: ProviderCatalog | undefined,
): CapabilityResolution {
  if (!catalog || !modelId.trim()) return { status: "unknown" };
  for (const candidate of idCandidates(modelId)) {
    const picked = pickCandidate(collectMatches(catalog, candidate), targetApi);
    if (picked) {
      // 写回网关自己的 id（而不是目录里那条的 id）：pi 要拿它去请求网关，
      // 用目录 id 会让「openai/gpt-4o」这类带渠道前缀的网关直接 404。
      return { status: "known", sourceRef: picked.sourceRef, model: { ...picked.model, id: modelId } };
    }
  }
  return { status: "unknown" };
}

/**
 * 未识别模型的**保守兜底**能力。
 *
 * ── 为什么这不违反「不猜能力」红线 ──────────────────────────────────────────
 * 2026-07-30 事故的机制是：Cortex 猜出来的能力经 extension **替换掉了 pi 内建目录里
 * 已知为真的值**（多模态被写成 text-only → 图片被换成 `(image omitted)`）。破坏点在于
 * 「用不确定的值覆盖确定的值」。
 *
 * 而网关上一个 pi 从没收录过的模型，**没有任何既有数据会被覆盖**：目录里本来就没有它。
 * 此时「不给能力」的实际后果不是安全，而是这个模型压根不能用 —— 用户明明知道它能用。
 *
 * 下面这组值也不是凭空发明：它们逐字等于 pi 自己在 `modelFromJson` 里对缺失字段的兜底
 * （`reasoning ?? false` / `input ?? ["text"]` / `contextWindow ?? 128000` / `maxTokens ?? 16384`）。
 * Cortex 只是把 pi 的隐式默认**显式写出来并打上标记**，好让 UI 能如实告诉用户
 * 「这几个数字是保守默认、不是查到的」，用户随时可以用参照模型换成确定值。
 *
 * `compat` 取非 OpenAI 上游的保守形态：目录里 `supportsDeveloperRole` 414 处全为 false、
 * `maxTokensField` 93 处全为 "max_tokens"。**能走到这条兜底路径的模型必然不在 pi 的 OpenAI
 * 目录里**，所以它几乎不可能是 OpenAI 官方模型（那些都会被自动识别），按非 OpenAI 上游
 * 处理是有据可依的 —— 不这么做，推理链路上会立刻踩到 `role: developer` / `max_completion_tokens`
 * 被上游拒绝的 400。
 */
export function fallbackCapabilities(modelId: string, targetApi: string): CapabilityResolution {
  return {
    status: "known",
    sourceRef: FALLBACK_SOURCE_REF,
    model: {
      id: modelId,
      name: modelId,
      api: targetApi,
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    },
  };
}

/** 兜底来源的标记值。UI 据它显示「能力未知·按保守默认」，与目录命中/参照补全区分开。 */
export const FALLBACK_SOURCE_REF = "fallback";

/**
 * 「参照模型」补全：用户在目录里指定一条参照，能力整套继承给网关模型。
 *
 * 这是把「六个字段手填」压缩成「一次选择」的机制（方案 §B2）。写进 pi 的值仍然完整、确定，
 * 只是来源从「目录自动命中」变成「用户指认」—— 两者都不是猜测，区别只在谁负责。
 *
 * `compat` 与自动解析同样**整套继承**（理由见 pickCandidate 里的实测记录）：用户指认参照模型，
 * 说的就是「这个网关模型的行为跟那个一样」，而协议开关正是这句话里最实质的部分。丢掉它，
 * 推理类模型会立刻踩到 `role: developer` 那个 400。
 */
export function applyReferenceModel(
  modelId: string,
  targetApi: string,
  reference: { providerId: string; model: CatalogModel },
): CapabilityResolution {
  return {
    status: "known",
    sourceRef: `reference:${reference.providerId}/${reference.model.id}`,
    model: { ...reference.model, id: modelId, name: modelId, api: targetApi },
  };
}
