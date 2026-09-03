// 会话内自动前置检索：发消息前跑一次 gather，把证据渲染成 system prompt 追加段。
//
// **失败语义照搬写作检索**（views/cortex-desktop/writing/WritingAssistantPanel 的
// retrieveContextWithTimeout）：硬超时 + 吞掉任何异常 + 静默降级。检索是锦上添花，
// 绝不能阻断或报错打断发送回合——这也是 spec §15.1 的原话：
// 「Research 失败不阻断普通会话，但必须说明未完成实时验证」。
// 后半句由 composeChatEvidenceAppend 的空结果说明兑现，不在这里。
//
// 相关文件：证据段渲染见 ./chat-evidence；检索契约见 ./quick-types；
// 调用点在 core/personal/messages.ts 的发送路径。
import type { ResearchEngineSettings } from "./settings";
import type { GatherRequest, GatherResult } from "./quick-types";
import { composeChatEvidenceAppend, composeChatRetrievalFailureNotice } from "./chat-evidence";

/// 前置检索的硬超时。
///
/// 取值依据：gather 最坏情况是 discover(8s) + prepare(20s) = 28s，而这段时间用户是在
/// **干等一条消息发出去**。15s 是「还能忍」与「至少抓得到东西」之间的折中：
/// 实测三条文档的 gather 通常 5~10s 完成，超过 15s 多半是某个站点在吊着连接。
/// 超时后照常发送，只是这一轮没有资料——比让用户盯着一个不动的输入框好。
export const CHAT_RETRIEVAL_TIMEOUT_MS = 15_000;

/// 前置检索是否该发生。
///
/// 三个条件缺一不可：总开关、**该会话的联网开关**、以及"总是先检索"这一项本身。
///
/// **chatAutoRetrieve 依赖会话级 sessionWebSearch**：会话没开「联网」时，前者即便为 true
/// 也不生效——否则用户看着输入框上灰着的「联网」，却发现每轮都在悄悄出站，那是彻底的信任崩塌。
/// 会话级开关是最终裁决者，全局那一项只决定「联网时是模型自主判断还是每轮强制先查」。
///
/// @param sessionWebSearch 该会话的 SessionMeta.webSearch。**必填而非可选**：默认值会让新的
///        调用点在漏传时静默联网，这里宁可让编译器拦下来。
export function shouldAutoRetrieve(
  settings: ResearchEngineSettings | undefined,
  sessionWebSearch: boolean,
): boolean {
  return !!settings?.enabled && sessionWebSearch && settings.chatAutoRetrieve === true;
}

export interface ChatRetrievalInput {
  /// 桥上的 gather 方法；缺失（Web 端 / 旧壳 / 主进程未提供）时直接跳过。
  gather: ((request: GatherRequest) => Promise<GatherResult>) | undefined;
  settings: ResearchEngineSettings | undefined;
  /// 该会话是否开了「联网」（SessionMeta.webSearch）。见 shouldAutoRetrieve 的说明。
  sessionWebSearch: boolean;
  /// 用户这一轮的消息文本，直接当查询词用。
  query: string;
  timeoutMs?: number;
}

/// detailed 版的结构化结论。append 的三种语义（见 retrieveChatEvidence 注释）原封不动，
/// outcome/documentCount 是给前置管线（chat-preflight）与时间线条目用的旁路信息：
///   - "disabled" = 功能没开/没有桥/空查询（append undefined）；
///   - "ok"       = 检索到至少一条（append 为证据段）；
///   - "empty"    = 检索执行了但零结果（append 为零结果说明）；
///   - "failed"   = 检索没能执行（append 为故障说明）。
export type ChatRetrievalOutcome = "disabled" | "ok" | "empty" | "failed";

export interface ChatRetrievalDetailedResult {
  append: string | undefined;
  outcome: ChatRetrievalOutcome;
  documentCount: number;
}

/// 跑一次前置检索并返回可注入的证据段；不该检索或检索不可用时返回 undefined。
///
/// 返回值有**三种**语义，不能混：
///   - undefined  = 功能没开或没有桥 → 模型完全不知道有检索这回事，行为与从前一致；
///   - 零结果说明 = 检索执行了、但一条都没搜到 → 模型据此告知"没能验证最新信息"；
///   - 故障说明   = 检索**没能执行**（超时 / 未配后端 / 主进程报错）→ 模型据此告知"没有联网核对"，
///                 且**不声称检索发生过**（见 composeChatRetrievalFailureNotice 的注释里那起事故）。
/// 把前两者混为一谈，会让关着功能的用户也收到莫名其妙的"检索失败"；
/// 把后两者混为一谈，会让模型读到与自身工具记录矛盾的系统提示，转而向用户解释系统提示的来源。
export async function retrieveChatEvidence(
  input: ChatRetrievalInput,
): Promise<string | undefined> {
  return (await retrieveChatEvidenceDetailed(input)).append;
}

/// retrieveChatEvidence 的结构化版本：行为逐字一致（旧函数已改为它的薄包装，既有测试
/// 继续守住三语义红线），只是额外报告 outcome 与命中条数——前置管线要据此更新时间线条目，
/// 而从 append 字符串反推结论是脆弱的。
export async function retrieveChatEvidenceDetailed(
  input: ChatRetrievalInput,
): Promise<ChatRetrievalDetailedResult> {
  if (!shouldAutoRetrieve(input.settings, input.sessionWebSearch)) {
    return { append: undefined, outcome: "disabled", documentCount: 0 };
  }
  if (!input.gather) return { append: undefined, outcome: "disabled", documentCount: 0 };
  const query = input.query.trim();
  if (query.length === 0) return { append: undefined, outcome: "disabled", documentCount: 0 };

  const timeoutMs = input.timeoutMs ?? CHAT_RETRIEVAL_TIMEOUT_MS;
  try {
    // 超时哨兵用独占对象而非 null：gather 理论上不会返回 null，但用 null 做哨兵会让
    // 「返回了 null」与「超时」不可区分，而这两者现在要走不同的说明段。
    const TIMEOUT = Symbol("timeout");
    const result = await Promise.race([
      input.gather({ consumer: "chat", query }),
      new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), timeoutMs)),
    ]);
    if (result === TIMEOUT) {
      return {
        append: composeChatRetrievalFailureNotice(`检索超时（${Math.round(timeoutMs / 1000)} 秒）`),
        outcome: "failed",
        documentCount: 0,
      };
    }
    const documents = result?.documents ?? [];
    return {
      append: composeChatEvidenceAppend(documents),
      outcome: documents.length > 0 ? "ok" : "empty",
      documentCount: documents.length,
    };
  } catch (error) {
    // 任何异常（未配搜索后端、密钥解不开、网络失败、主进程报错）都吞掉——检索绝不阻断发送。
    // 但要把原因带给模型：它得以此如实告诉用户这轮没联网，用户才有排查的线索。
    return {
      append: composeChatRetrievalFailureNotice(error instanceof Error ? error.message : String(error)),
      outcome: "failed",
      documentCount: 0,
    };
  }
}
