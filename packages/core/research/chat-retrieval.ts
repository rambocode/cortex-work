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
import { composeChatEvidenceAppend } from "./chat-evidence";

/// 前置检索的硬超时。
///
/// 取值依据：gather 最坏情况是 discover(8s) + prepare(20s) = 28s，而这段时间用户是在
/// **干等一条消息发出去**。15s 是「还能忍」与「至少抓得到东西」之间的折中：
/// 实测三条文档的 gather 通常 5~10s 完成，超过 15s 多半是某个站点在吊着连接。
/// 超时后照常发送，只是这一轮没有资料——比让用户盯着一个不动的输入框好。
export const CHAT_RETRIEVAL_TIMEOUT_MS = 15_000;

/// 前置检索是否该发生。
///
/// 三个条件缺一不可：总开关、会话内检索开关、以及"总是先检索"这一项本身。
/// **chatAutoRetrieve 依赖 chatEnabled**：后者关掉时前者即便为 true 也不生效——
/// 否则用户在 UI 上关掉了「会话内检索」，却发现每轮还在联网，那是彻底的信任崩塌。
export function shouldAutoRetrieve(settings: ResearchEngineSettings | undefined): boolean {
  return !!settings?.enabled && settings.chatEnabled === true && settings.chatAutoRetrieve === true;
}

export interface ChatRetrievalInput {
  /// 桥上的 gather 方法；缺失（Web 端 / 旧壳 / 主进程未提供）时直接跳过。
  gather: ((request: GatherRequest) => Promise<GatherResult>) | undefined;
  settings: ResearchEngineSettings | undefined;
  /// 用户这一轮的消息文本，直接当查询词用。
  query: string;
  timeoutMs?: number;
}

/// 跑一次前置检索并返回可注入的证据段；不该检索或检索不可用时返回 undefined。
///
/// 返回 undefined 与返回"没搜到"的说明段是**两件事**：
///   - undefined = 功能没开或没有桥 → 模型完全不知道有检索这回事，行为与从前一致；
///   - 说明段    = 功能开了但这次没拿到 → 模型必须据此告诉用户"没能验证最新信息"。
/// 把两者混为一谈，会让关着功能的用户也收到一句莫名其妙的"检索失败"。
export async function retrieveChatEvidence(
  input: ChatRetrievalInput,
): Promise<string | undefined> {
  if (!shouldAutoRetrieve(input.settings)) return undefined;
  if (!input.gather) return undefined;
  const query = input.query.trim();
  if (query.length === 0) return undefined;

  const timeoutMs = input.timeoutMs ?? CHAT_RETRIEVAL_TIMEOUT_MS;
  try {
    const result = await Promise.race([
      input.gather({ consumer: "chat", query }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    // 超时（null）与"搜到 0 条"都走同一个空结果说明：对用户而言两者是同一件事
    // ——这一轮没有拿到可核对的资料。
    return composeChatEvidenceAppend(result?.documents ?? []);
  } catch {
    // 任何异常（未配搜索后端、网络失败、主进程报错）都吞掉。
    // 仍然回一段说明而不是 undefined：功能是开着的，模型必须知道这轮没验证成功。
    return composeChatEvidenceAppend([]);
  }
}
