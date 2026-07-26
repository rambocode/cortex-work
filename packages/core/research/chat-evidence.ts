// 会话内自动前置检索的证据段渲染（纯函数）。
//
// 用途：用户打开「总是先检索再回答」后，发消息前会先跑一次 discover + prepare，
// 把抓到的正文渲染成一段注入 CliStartRequest.appendSystemPrompt 的文本。
//
// **为什么不复用记忆的 composeMemoryAppend**：两者的预算语义相反。记忆是「跨会话常驻、
// 每轮都注入」的固定开销，所以 MEMORY_APPEND_BUDGET 定得很紧（1500 字符）；证据是
// 「本轮问题的一次性资料」，紧到 1500 就等于没抓。两者必须各有预算，且证据**不得挤占记忆**——
// 用户画像被一篇网页顶掉，是比"资料少一点"严重得多的退化。
//
// 引用形态：锚在 **URL** 上而不是 chunkId。窄面不落库（见 ./quick-types 的文件头），
// chunkId 无处可查；给模型一个查不回去的 id，比不给引用更糟。
//
// 相关文件：检索结果类型见 ./quick-types；记忆注入见 ../memory/inject。
import type { PreparedDocument } from "./quick-types";

/// 证据段的字符预算。
///
/// 取值依据：与 MODE_BUDGETS.quick 的 maxEvidenceCharsToModel（20k）同量级但更保守——
/// 那是「用户主动发起一次快速研究」的额度，这里是「每轮对话都可能发生」的额度，
/// 后者乘以对话轮数才是真实开销。12k 字符约合 3k token，在主流模型的上下文里是可接受的常驻占用。
export const CHAT_EVIDENCE_BUDGET = 12_000;

const HEADER =
  "以下是刚刚为本轮问题联网检索到的资料。回答时若用到其中内容，请在句末以 Markdown 链接标注来源；" +
  "资料未覆盖到的部分要说明是你自己的判断，不要把推测写成来自这些来源的事实：";

/// 检索确实执行了、但一条资料都没搜到时的说明段。
///
/// **不是返回 undefined**：用户明确开了「总是先检索再回答」，模型却完全不知道检索发生过，
/// 会像平时一样凭训练数据回答时效性问题。给它一句明确的"这次没搜到"，
/// 它才会主动说明信息可能过时（spec §15.1「必须说明未完成实时验证」）。
///
/// 末句的防编造约束不能省：模型手里没有任何来源时，"据某网站"这种顺嘴的措辞比不给资料更糟。
const EMPTY_NOTICE =
  "本轮已执行联网检索，但没有取到可用资料。回答时请明确告知用户：这次没能验证最新信息，" +
  "以下内容基于你已有的知识，可能已过时。不要声称你查阅过任何网络资料，也不要编造来源链接。";

/// 故障原因在注入段里的长度上限。原因来自底层异常，可能很长甚至带栈；
/// 模型只需要一句能转述给用户的话，栈对它毫无用处，还会挤占证据预算。
const FAILURE_REASON_LIMIT = 120;

/// 前置检索**没能执行成功**时的说明段（与"执行了但没搜到"是两件事）。
///
/// 为什么必须分开：曾经两者共用 EMPTY_NOTICE 的「本轮已尝试联网检索」，而故障场景下
/// 模型的工具调用记录里没有任何检索动作——它读到一句声称检索发生过的系统提示、却找不到对应
/// 事实，下一轮就会转而向用户解释「之前的声明是系统预设的提示，实际上我没有尝试过联网」。
/// 让模型跟用户讨论系统提示的来源，是文案与事实脱节的直接后果。
///
/// 所以这段话：① 不声称检索已执行；② 带上原因供模型如实转述（也给用户排查线索）；
/// ③ 明确禁止编造来源。
export function composeChatRetrievalFailureNotice(reason?: string): string {
  const trimmed = reason?.trim();
  const detail =
    trimmed && trimmed.length > 0
      ? `（原因：${trimmed.length > FAILURE_REASON_LIMIT ? `${trimmed.slice(0, FAILURE_REASON_LIMIT)}…` : trimmed}）`
      : "";
  return (
    `本轮的联网检索没有执行成功${detail}。回答时请明确告知用户：这次没有联网核对，` +
    "以下内容基于你已有的知识，可能已过时。不要声称你查阅过任何网络资料，也不要编造来源链接。"
  );
}

/// 把抓到的文档渲染成注入段。
///
/// 预算用法与记忆一致：**整篇放不下就整篇弃**，不做段内截断——半截的网页正文会产生残句，
/// 模型据此作答比少一篇来源更危险。例外是第一篇：预算再小也至少给一篇（否则开了功能却
/// 永远注入空内容），此时按预算硬截并标注。
export function composeChatEvidenceAppend(
  documents: readonly PreparedDocument[],
  budget: number = CHAT_EVIDENCE_BUDGET,
): string {
  const sections: string[] = [];
  let used = 0;

  for (const document of documents) {
    if (document.text.trim().length === 0) continue;
    const title = document.title?.trim() || document.url;
    const body = document.truncated ? `${document.text}\n（正文过长，以上为节选）` : document.text;
    const section = `【${title}】\n来源：${document.url}\n\n${body}`;

    if (used + section.length > budget) {
      // 第一篇的兜底：硬截到剩余预算，保证功能开着就一定有内容进去。
      if (sections.length === 0) {
        const head = `【${title}】\n来源：${document.url}\n\n`;
        const room = Math.max(0, budget - head.length);
        if (room > 0) {
          sections.push(`${head}${[...document.text].slice(0, room).join("")}\n（正文过长，以上为节选）`);
        }
      }
      break;
    }
    sections.push(section);
    used += section.length;
  }

  if (sections.length === 0) return EMPTY_NOTICE;
  return `${HEADER}\n\n${sections.join("\n\n---\n\n")}`;
}
