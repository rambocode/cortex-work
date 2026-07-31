// reply 生成模型解析：把 reply 专属选择 + 全局默认，按回退链解析成一个 Catalog 模型引用
// `{providerId, modelId}`。纯函数，不依赖 electron 也不读 Catalog，便于单测。
//
// ── 阶段③·4.1 收编后这里做的事变少了 ─────────────────────────────────────────
// 旧实现要在这里校验「供应商存在 + enabled + endpointFormat === chat_completions + 有可用
// model」，因为下游要拿 baseUrl/apiKey 自己拼 URL 发请求，选错了就发出一个格式不对的请求。
// 现在下游是 Pi Model Gateway：引用是否在 Catalog 里、Provider 是否已认证，由 Gateway 在**出站
// 之前**统一判定并返回 `errorKind: "config"`（计划 §5 的阻断态）。本文件因此只负责一件事——
// 按优先级挑出**用户到底选了哪个模型**，不再复制一份能力/可用性判据（两处判据必然漂移）。
//
// 回退链（严格顺序，任一候选不完整即落下一级）：
//   1. settings.providerId + settings.model（reply 专属选择）；
//   2. fallback（全局默认模型引用，由调用方从设置里取）；
//   3. 均不成立 → null（controller 据此推「未配置生成模型」气泡错误态，引导去设置）。
//
// **不做任何"取第一个模型"式的兜底**：悄悄换一个用户没选过的模型，等于把他的聊天记录发给
// 一个他没同意过的供应商。

import type { ModelRef } from "../providers/contract";

/// 解析后的生成目标。保留 providerId 与 modelId 两段，draft-generator 直接交给 Gateway。
export type ResolvedReplyModel = ModelRef;

/// reply 设置分片中与模型解析相关的最小子集（避免耦合整个 ReplySettings 形状）。
interface ReplyModelSelection {
  providerId?: string;
  model?: string;
}

/** 一级候选是否完整：两段都非空才算数（缺 model 时不猜"该供应商的第一个模型"）。 */
function toRef(providerId: string | undefined, modelId: string | undefined): ResolvedReplyModel | null {
  const p = providerId?.trim();
  const m = modelId?.trim();
  return p && m ? { providerId: p, modelId: m } : null;
}

/**
 * 按回退链解析 reply 生成模型；全部候选不成立返回 null。
 * settings 为 null（快照缺失）时跳过专属级，直接用 fallback。
 *
 * fallback 由调用方提供而不是在这里读设置：本文件是纯函数（可单测），而「全局默认模型」
 * 存在哪、叫什么名字属于设置层的事，让它渗进来会把这个文件重新绑死到某份持久化结构上。
 */
export function resolveReplyModel(
  settings: ReplyModelSelection | null | undefined,
  fallback: ModelRef | null | undefined,
): ResolvedReplyModel | null {
  return toRef(settings?.providerId, settings?.model) ?? toRef(fallback?.providerId, fallback?.modelId);
}
