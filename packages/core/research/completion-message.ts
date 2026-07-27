// 研究结束后回传给聊天会话的那条消息的文案生成（纯函数,无 IO）。
//
// **为什么研究结果一定要回流到会话**：/skill:research 的活由 CRE 引擎在主进程干，
// 会话里没有任何 agent 轮次。若只在右栏面板展示，用户切走会话再回来，聊天流里
// 就只剩自己问的那句话，看不出研究到底出没出结果、报告文件落在哪——等于结果丢了。
//
// 文案刻意只放「结论指针」而不是报告全文：报告可能几万字，塞进聊天流会把会话撑爆，
// 也会重复占一份磁盘（会话历史与 SQLite 各存一份）。正文在右栏面板与归档文件里。
import type { ResearchSessionStatus } from "./types";

/// 生成完成消息所需的事实。全部来自 CRE 侧，调用方不做加工。
export interface ResearchCompletionFacts {
  objective: string;
  status: ResearchSessionStatus;
  /// 归档后的报告文件绝对路径；未归档（失败/无项目写盘失败）时缺省。
  archivedPath?: string;
  roundCount?: number;
  documentCount?: number;
  citationCount?: number;
  /// 失败原因（人类可读）。仅 failed 时有意义。
  errorMessage?: string;
}

/// 终态 → 首行标题。cancelled 与 failed 都要如实说，不能一律写「完成」——
/// 用户据此判断要不要重跑，含糊其辞会让他以为报告只是还没生成。
function headline(status: ResearchSessionStatus): string {
  if (status === "completed") return "深度研究已完成";
  if (status === "failed") return "深度研究失败";
  if (status === "cancelled") return "深度研究已取消";
  // 其余终态（如 interrupted）统一按「已结束」处理,避免出现空标题。
  return "深度研究已结束";
}

/// 把「跑了多少轮、看了多少来源、引了多少条」拼成一行统计。
/// 三项都缺时返回 null——宁可不显示，也不要出现「0 轮 · 0 篇 · 0 条」这种像出错的行。
function statsLine(facts: ResearchCompletionFacts): string | null {
  const parts: string[] = [];
  if (facts.roundCount) parts.push(`${facts.roundCount} 轮检索`);
  if (facts.documentCount) parts.push(`${facts.documentCount} 篇来源`);
  if (facts.citationCount) parts.push(`${facts.citationCount} 条引用`);
  return parts.length ? parts.join(" · ") : null;
}

/// 生成回传聊天会话的完成消息（Markdown）。
///
/// 结构固定为：标题 → 研究目标 → 统计 → 报告文件路径 → 失败原因。
/// 顺序按「用户最关心什么」排：先知道成没成，再知道结果在哪，最后才是为什么没成。
export function buildResearchCompletionMessage(facts: ResearchCompletionFacts): string {
  const lines: string[] = [`**${headline(facts.status)}**`, "", `研究目标：${facts.objective}`];

  const stats = statsLine(facts);
  if (stats) lines.push("", stats);

  // 路径用行内代码包起来：报告文件名来自研究目标，常含空格与中文标点，
  // 不包会被 Markdown 渲染器吃掉部分字符，用户复制出来的路径就是错的。
  if (facts.archivedPath) lines.push("", `报告已保存到：\`${facts.archivedPath}\``);

  if (facts.status === "failed" && facts.errorMessage) lines.push("", `失败原因：${facts.errorMessage}`);

  // 完成但没归档路径时明确告知去哪看，别让用户以为报告没生成。
  if (facts.status === "completed" && !facts.archivedPath) {
    lines.push("", "报告已生成，可在右侧「深度研究」面板查看或导出。");
  }

  return lines.join("\n");
}
