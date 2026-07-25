// Search Server 凭据的合并与连通性探测（设置页「保存令牌 / 连接测试」两个按钮的内核）。
//
// 单独成文件而不是塞进 runtime.ts：这两段是**纯逻辑**，不碰 Electron 也不碰磁盘，
// 因此能在普通 vitest 环境里完整测掉；runtime.ts 依赖 app / safeStorage，测起来要整套 mock。
// 加解密与落盘留在 runtime.ts / ipc/research.ts，本文件只做「怎么合并」与「怎么解释错误」。
import { SearchServerError } from "./clients/search-server-client";
import type { SearchBatchRequest, SearchBatchResponse } from "@cortex-work/core/research/search-api";
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

/// 把可能被服务端回显的凭据明文从对外文本里抹掉。
/// 与 client 内部的 scrubToken 同策略——探测文本会显示在设置页上，可能被截图外发。
function scrub(message: string, token: string | undefined): string {
  if (!token) return message;
  return message.split(token).join("***");
}
