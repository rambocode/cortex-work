// 研究 MCP server 的注入配置构建（对照 capabilities/browser/inject.ts）。
//
// **三门控**，缺任一条都返回 null：
//   1. 研究引擎总开关要开；
//   2. 本 Consumer 的准入要过 —— chat / slides 看会话级 sessionOptIn（用户在该会话输入框
//      上按下的「联网」），其余 Consumer 看各自的全局灰度开关；
//   3. 搜索后端要真的配好了（自建 Search Server 或直连搜索二选一）。
//
// 第 3 条不能省。没有它，一个没配搜索后端的用户会拿到一个完整的 web_search 工具，
// 而每次调用都抛「搜索服务未配置」——agent 会反复重试、把这轮对话烧掉，
// 用户只看到"联网功能坏了"。不注入的话，agent 压根不知道有这个能力，行为退回到从前。
//
// 鉴权：token 经 Authorization 头（claude headers / codex http_headers），**不进 URL**
// （避免泄进日志 / 进程参数）。sessionId 经 X-Cortex-Session 头注入，供 server 查本会话的 Consumer。
import type { ResearchConsumer } from "@cortex-work/core/research/types";
import {
  hasSearchBackend,
  normalizeResearchEngineSettings,
  type ResearchEngineSettings,
} from "@cortex-work/core/research/settings";

import { createLogger } from "../../log";
import type { McpServerConfig } from "../../ipc/types";
import { CONSUMER_SWITCHES } from "../../research/consumer-gate";
import { getResearchHostHandle, registerResearchSession, RESEARCH_SERVER_ID } from "./server";

const log = createLogger("research-inject");

/// 该 Consumer 的研究能力是否已开启。
///
/// 与 consumer-gate 的 assertResearchEnabled 判定一致，只是这里要的是布尔而不是抛错——
/// 注入阶段不该用异常做控制流。非会话级的 Consumer 共用同一张 CONSUMER_SWITCHES 表，不会漂移。
///
/// chat / slides 单独一条分支：它们已无全局灰度开关（见 consumer-gate 的注释），准入完全
/// 由调用方传入的会话级选择决定。**这里不能回落到「表里没有该 key 就放行」的通用分支**——
/// 那会让会话只要总开关开着就注入，正是本次要消灭的行为。
function isConsumerEnabled(
  settings: ResearchEngineSettings,
  consumer: ResearchConsumer,
  sessionOptIn: boolean,
): boolean {
  if (!settings.enabled) return false;
  if (consumer === "chat" || consumer === "slides") return sessionOptIn;
  const key = CONSUMER_SWITCHES[consumer];
  return key ? settings[key] === true : true;
}

/// 构建研究 MCP server 的注入配置；不满足门控时返回 null（不注入）。
///
/// @param settings 当前研究引擎设置快照
/// @param sessionId 当前 agent session id（经 X-Cortex-Session 头传给 server）
/// @param consumer  本会话属于哪个 Consumer；决定受哪个开关约束与默认预算
/// @param sessionOptIn 仅 chat / slides 生效：用户在该会话栏是否开了「联网」。
///        **缺省 false**——出站能力的默认必须落在保守那一侧，漏传的调用点应退化为
///        「没有联网」而不是「悄悄联网」。
export function buildResearchMcpServerConfig(
  settings: ResearchEngineSettings | undefined,
  sessionId: string | undefined,
  consumer: ResearchConsumer = "chat",
  sessionOptIn = false,
): McpServerConfig | null {
  if (!settings) return null;
  // **入参按「磁盘原始切片」对待，在此归一化**。调用方（cli.ts / pi-session.ts）传的是
  // getPersistedState() 的原始值，其中 searchBackend 这个键在所有升级上来的配置里都不存在——
  // 不归一化的话 `raw.searchBackend === "server"` 恒为 false，判定会掉进直连分支，
  // 而执行侧 createSearchClient 用的是归一化快照、走的是 Search Server。两侧认定的后端不一致，
  // 就会出现「配好了却没有工具」或「有工具但一调用就报未配置」这类查不出原因的状态。
  // 归一化同时兜住手改配置文件带来的脏值。
  const normalized = normalizeResearchEngineSettings(settings);

  if (!isConsumerEnabled(normalized, consumer, sessionOptIn)) {
    // 这条日志是刻意留的：四道门都在主进程静默返回 null，用户那侧只看到「开了联网但 agent
    // 没有搜索工具」，没有任何线索可循（本功能上线首日就是这样排查了很久）。
    log.debug(
      `不注入：${consumer} 未启用（总开关=${normalized.enabled} sessionOptIn=${sessionOptIn}）`,
    );
    return null;
  }
  if (!hasSearchBackend(normalized)) {
    log.debug(`不注入：搜索后端未配置（backend=${normalized.searchBackend}）`);
    return null;
  }

  const handle = getResearchHostHandle();
  // host 未起或不可用 → 不注入，避免给 agent 一个连不上的 url。
  if (!handle || !handle.serverAvailable || handle.port <= 0) {
    log.warn(
      `不注入：研究 MCP host 不可用（handle=${handle ? `port=${handle.port} available=${handle.serverAvailable}` : "null"}）`,
    );
    return null;
  }
  log.debug(`注入研究 MCP：consumer=${consumer} backend=${normalized.searchBackend} port=${handle.port}`);

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
