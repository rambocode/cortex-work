// 研究 MCP server 的注入配置构建（对照 capabilities/browser/inject.ts）。
//
// **双门控**，缺任一条都返回 null：
//   1. 研究引擎总开关 + 该 Consumer 的灰度开关都要开；
//   2. 搜索后端要真的配好了（自建 Search Server 或直连搜索二选一）。
//
// 第 2 条不能省。没有它，一个没配搜索后端的用户会拿到一个完整的 web_search 工具，
// 而每次调用都抛「搜索服务未配置」——agent 会反复重试、把这轮对话烧掉，
// 用户只看到"联网功能坏了"。不注入的话，agent 压根不知道有这个能力，行为退回到从前。
//
// 鉴权：token 经 Authorization 头（claude headers / codex http_headers），**不进 URL**
// （避免泄进日志 / 进程参数）。sessionId 经 X-Cortex-Session 头注入，供 server 查本会话的 Consumer。
import type { ResearchConsumer } from "@cortex-work/core/research/types";
import type { ResearchEngineSettings } from "@cortex-work/core/research/settings";

import type { McpServerConfig } from "../../ipc/types";
import { CONSUMER_SWITCHES } from "../../research/consumer-gate";
import { getResearchHostHandle, registerResearchSession, RESEARCH_SERVER_ID } from "./server";

/// 该 Consumer 的研究能力是否已开启（总开关 + 灰度开关）。
///
/// 与 consumer-gate 的 assertResearchEnabled 判定一致，只是这里要的是布尔而不是抛错——
/// 注入阶段不该用异常做控制流。两者共用同一张 CONSUMER_SWITCHES 表，不会漂移。
function isConsumerEnabled(settings: ResearchEngineSettings, consumer: ResearchConsumer): boolean {
  if (!settings.enabled) return false;
  const key = CONSUMER_SWITCHES[consumer];
  return key ? settings[key] === true : true;
}

/// 搜索后端是否已配置。**只看配置是否完整，不做连通性探测**：
/// 注入发生在 agent 启动路径上，为此发一次网络请求会给每次会话启动加上几百毫秒。
/// 配了但不通，由工具调用时的错误信息告知，那时用户已经在等结果、有心理预期。
function hasSearchBackend(settings: ResearchEngineSettings): boolean {
  const server = settings.searchServer;
  if (server?.baseUrl && server.workspaceId && server.encryptedToken) return true;
  return !!settings.directSearch?.encryptedApiKey;
}

/// 构建研究 MCP server 的注入配置；不满足门控时返回 null（不注入）。
///
/// @param settings 当前研究引擎设置快照
/// @param sessionId 当前 agent session id（经 X-Cortex-Session 头传给 server）
/// @param consumer  本会话属于哪个 Consumer；决定受哪个灰度开关约束与默认预算
export function buildResearchMcpServerConfig(
  settings: ResearchEngineSettings | undefined,
  sessionId: string | undefined,
  consumer: ResearchConsumer = "chat",
): McpServerConfig | null {
  if (!settings) return null;
  if (!isConsumerEnabled(settings, consumer)) return null;
  if (!hasSearchBackend(settings)) return null;

  const handle = getResearchHostHandle();
  // host 未起或不可用 → 不注入，避免给 agent 一个连不上的 url。
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;

  // 注册 per-session 状态（Consumer）。幂等：同一 session 多轮覆盖写；
  // 清理由 cli.ts 的 onExit 调 unregisterResearchSession 负责。
  if (sessionId) registerResearchSession(sessionId, consumer);

  return {
    id: RESEARCH_SERVER_ID,
    label: "研究引擎（内置）",
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      ...(sessionId ? { "X-Cortex-Session": sessionId } : {}),
    },
  };
}
