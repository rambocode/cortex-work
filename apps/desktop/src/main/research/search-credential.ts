// Search Server 凭据的合并与连通性探测（设置页「保存令牌 / 连接测试」两个按钮的内核）。
//
// 单独成文件而不是塞进 runtime.ts：这两段是**纯逻辑**，不碰 Electron 也不碰磁盘，
// 因此能在普通 vitest 环境里完整测掉；runtime.ts 依赖 app / safeStorage，测起来要整套 mock。
// 加解密与落盘留在 runtime.ts / ipc/research.ts，本文件只做「怎么合并」与「怎么解释错误」。
import { SearchServerError } from "./clients/search-server-client";
import type { SearchBatchRequest, SearchBatchResponse } from "@cortex-work/core/research/search-api";
import {
  DIRECT_SEARCH_PROVIDERS,
  type DirectSearchProviderId,
} from "@cortex-work/core/research/direct-search";
import type { ResearchDirectSearchSettings } from "@cortex-work/core/research/settings";
import type { ResearchSearchServerSettings } from "../ipc/types-research";

/// 合并 Search Server 设置的入参。encryptedToken 省略 = 只改地址/工作区，保留已存密文。
export interface SearchServerMergeInput {
  baseUrl: string;
  workspaceId: string;
  /// safeStorage 加密后的 base64 密文。**永远不是明文**——明文在调用方就已加密完毕。
  encryptedToken?: string;
}

/// 合并出新的 searchServer 设置切片。
///
/// 两条容易踩的边界，都由测试锁住：
///   1. **只改地址时不得抹掉已存密文** —— 用户改端口后不该被迫重新粘贴 PAT；
///   2. 新旧密文都没有时**不产生 encryptedToken 字段**，而不是留一个 undefined ——
///      settings 归一化会把非字符串的 encryptedToken 丢掉，留着只会让 JSON 里多一个空洞。
export function mergeSearchServerSettings(
  current: ResearchSearchServerSettings | undefined,
  input: SearchServerMergeInput,
): ResearchSearchServerSettings {
  const merged: ResearchSearchServerSettings = {
    baseUrl: input.baseUrl.trim(),
    workspaceId: input.workspaceId.trim(),
  };
  const token = input.encryptedToken ?? current?.encryptedToken;
  if (token) merged.encryptedToken = token;
  return merged;
}

/// 合并直连搜索设置的入参。encryptedApiKey 省略 = 只改供应商，语义见下。
export interface DirectSearchMergeInput {
  provider: DirectSearchProviderId;
  /// safeStorage 加密后的 base64 密文。**永远不是明文**。
  encryptedApiKey?: string;
}

/// 合并出新的 directSearch 设置切片。
///
/// 与 mergeSearchServerSettings 的关键差异：**换供应商时不保留旧密文**。
/// Search Server 那边改的是同一个后端的地址，令牌仍然有效；这边 brave 的 key 拿去打 tavily
/// 必然 401，留着它只会让设置页显示「已配置」而实际每次搜索都失败——那种失败最难查，
/// 因为用户记得自己确实填过 key。
export function mergeDirectSearchSettings(
  current: ResearchDirectSearchSettings | undefined,
  input: DirectSearchMergeInput,
): ResearchDirectSearchSettings {
  const merged: ResearchDirectSearchSettings = { provider: input.provider };
  const sameProvider = current?.provider === input.provider;
  const key = input.encryptedApiKey ?? (sameProvider ? current?.encryptedApiKey : undefined);
  if (key) merged.encryptedApiKey = key;
  return merged;
}

/// 探测所需的最小客户端能力（便于测试注入替身，不必构造真 SearchServerClient）。
export interface ProbeClientLike {
  searchBatch(request: SearchBatchRequest, signal?: AbortSignal): Promise<SearchBatchResponse>;
}

/// 连通性探测结果（与 core 的 ResearchSearchServerProbe 同形）。
export interface SearchServerProbeResult {
  ok: boolean;
  message: string;
}

/// 探测用的固定查询文本。
///
/// 刻意用一句无意义的中性英文而非用户数据：探测请求会真的打到搜索后端并被审计，
/// 不该把任何用户意图带出去。
const PROBE_QUERY_TEXT = "cortex research connectivity probe";

/// 对 Search Server 做一次连通性探测。
///
/// **为什么是发一条真实搜索而不是打健康检查端点**：服务端没有 research 专属的健康端点，
/// 而我们真正要回答的问题是「这套 baseUrl + workspaceId + PAT 组合能不能搜出东西」——
/// 只有真发一次批量搜索才同时验到鉴权、工作区成员资格与 provider 可用性三件事。
/// 代价是消耗一次 provider 调用，所以刻意压到 **1 条查询 + limit 1**。
///
/// plainToken 只用于把可能被服务端回显的凭据从错误文本里擦掉；本函数不发送它
/// （发送由 client 内部完成），也不记录它。
export async function probeSearchServer(
  client: ProbeClientLike,
  plainToken?: string,
): Promise<SearchServerProbeResult> {
  const request: SearchBatchRequest = {
    request_id: "probe",
    research_session_id: "probe",
    queries: [{ query_id: "probe", text: PROBE_QUERY_TEXT, limit: 1 }],
  };

  try {
    const response = await client.searchBatch(request);
    const count = response.results.reduce((sum, r) => sum + r.items.length, 0);
    // 0 条结果**不算失败**：那是「搜索后端此刻没搜到东西」，连接本身是通的。
    // 把两者混为一谈会让用户去改一个根本没问题的配置。
    return count > 0
      ? { ok: true, message: `连接正常，试搜返回 ${count} 条结果。` }
      : { ok: true, message: "连接正常，但本次试搜未搜到内容（搜索后端可能暂时无可用引擎）。" };
  } catch (err) {
    return { ok: false, message: scrub(explain(err), plainToken) };
  }
}

/// 错误 → 一句能指导下一步动作的人话。
///
/// 按 `code` 而非 message 文本分支：message 是给人看的，措辞随时可能改，
/// 拿它做判定会在某次文案调整后静默失效。
function explain(err: unknown): string {
  if (!(err instanceof SearchServerError)) {
    return `测试失败：${err instanceof Error ? err.name : "未知错误"}`;
  }
  switch (err.code) {
    case "unauthorized":
      return "令牌无效或已过期，请在服务端重新生成 PAT 后重填。";
    case "forbidden":
      return "该令牌无权访问这个工作区，请确认工作区 ID 与令牌所属账号。";
    case "http_error":
      // 404 在服务端是「非成员」与「不存在」的共同回复（刻意不区分，避免探测工作区是否存在），
      // 所以提示必须把两种可能都说出来，否则用户会只去查 ID 拼错没有。
      if (err.httpStatus === 404) {
        return "工作区不存在，或当前令牌无权访问它（服务端对非成员统一回 404）。";
      }
      return `服务端返回了意外状态码 ${err.httpStatus ?? "未知"}，请检查服务地址是否指向正确的后端。`;
    case "unavailable":
      return "服务端的搜索后端全部失败（如未配置 SEARXNG_BASE_URL 或引擎不可用），请检查服务端配置。";
    case "network_error":
      return "连不上服务地址，请确认后端已启动且地址、端口可达。";
    case "cancelled":
      return "测试超时，服务端未在预期时间内响应。";
    case "too_large":
      return "服务端响应体过大，可能不是预期的后端。";
    case "request_mismatch":
      return "服务端响应与请求不匹配，可能中间有代理改写了内容。";
    case "invalid_response":
      return "服务端响应不是预期格式，请确认服务地址指向的是 Cortex 后端而非其它服务。";
  }
}

/// 对直连商业搜索做一次连通性探测（设置页「连接测试」的直连分支）。
///
/// **为什么不能复用 probeSearchServer**：DirectSearchClient 刻意不抛错——除调用方取消外，
/// 所有失败都收敛进响应体的 `results[].errors`（理由见该文件头「局部失败不整批失败」）。
/// 拿 probeSearchServer 那套「没抛错就算通」的判定套上去，一个无效的 API key 会被报成
/// 「连接正常，但本次试搜未搜到内容」，把用户引向完全错误的排查方向。
export async function probeDirectSearch(
  client: ProbeClientLike,
  provider: DirectSearchProviderId,
  plainApiKey?: string,
): Promise<SearchServerProbeResult> {
  const request: SearchBatchRequest = {
    request_id: "probe",
    research_session_id: "probe",
    queries: [{ query_id: "probe", text: PROBE_QUERY_TEXT, limit: 1 }],
  };

  const label = DIRECT_SEARCH_PROVIDERS[provider].label;

  let response: SearchBatchResponse;
  try {
    response = await client.searchBatch(request);
  } catch (err) {
    // 走到这里只可能是取消或意外异常；错误详情刻意不外泄（可能夹带凭据或上游正文）。
    return {
      ok: false,
      message: scrub(`测试失败：${err instanceof Error ? err.name : "未知错误"}`, plainApiKey),
    };
  }

  // 错误优先于结果数判定：有错误就是配置或额度问题，必须直说。
  const firstError = response.results.flatMap((result) => result.errors)[0];
  if (firstError) {
    return { ok: false, message: scrub(explainDirect(firstError.code, label), plainApiKey) };
  }

  const count = response.results.reduce((sum, result) => sum + result.items.length, 0);
  return count > 0
    ? { ok: true, message: `连接正常，${label} 试搜返回 ${count} 条结果。` }
    : { ok: true, message: `连接正常，但本次试搜未搜到内容（${label} 这次没有命中）。` };
}

/// 直连错误码 → 一句能指导下一步动作的人话。
/// 与 explain 一样按 code 分支，不看 message 文本。
function explainDirect(code: string, label: string): string {
  switch (code) {
    case "unauthorized":
      return `${label} 拒绝了这个密钥（无效或已撤销），请重新申请后重填。`;
    case "forbidden":
      return `${label} 拒绝访问：多为免费额度已耗尽或该密钥未开通搜索套餐。`;
    case "rate_limited":
      return `${label} 触发了限流，请稍后重试；若频繁出现，说明当前套餐的 QPS 不够用。`;
    case "unavailable":
      return `${label} 服务暂时不可用，请稍后重试。`;
    case "timeout":
      return `请求 ${label} 超时（未在预期时间内响应），请检查本机到该服务的网络（可能需要代理）。`;
    case "network_error":
      return `连不上 ${label}，请确认本机网络可直达该服务（可能需要代理）。`;
    case "too_large":
      return `${label} 返回的响应体过大，可能不是预期的服务。`;
    case "invalid_response":
      return `${label} 返回的不是合法 JSON，可能被中间网络设备改写了内容。`;
    default:
      return `${label} 返回了未知错误（${code}）。`;
  }
}

/// 把可能被服务端回显的凭据明文从对外文本里抹掉。
/// 与 client 内部的 scrubToken 同策略——探测文本会显示在设置页上，可能被截图外发。
function scrub(message: string, token: string | undefined): string {
  if (!token) return message;
  return message.split(token).join("***");
}
