// 做梦蒸馏 prompt 的纯逻辑层：把「近期会话情景 + 分区已有记忆」组装成单发 LLM prompt，
// 并清洗模型输出。核心语义模仿人类睡眠记忆固化——
//   提炼（稳定事实/偏好，忽略一次性任务内容）、合并（与已有记忆去重）、
//   遗忘（删除被新证据推翻或明显过时的旧条目）。
// 形状对齐 reply 的 buildDistillPrompt/cleanDistilledRules（system+user 两段，输出仅要点行）。

import type { EpisodeSample } from "./episodic";
import { userMemoryDreamTarget, type UserMemoryScope } from "./memory";

/// 每分区 auto 区最多保留的要点条数（写进 prompt 约束，clean 侧再硬截断兜底）。
export const DREAM_MAX_FACTS = 12;

/// 做梦 prompt 的输出形态（system/user 两段），交主进程 LLM 直连单发执行。
export interface DreamPrompt {
  system: string;
  user: string;
}

/// 构造「从近期会话蒸馏某分区语义记忆」的 prompt。
/// existingAuto 为该分区当前 auto 区内容——合并/遗忘语义都体现在对它的改写上。
export function buildDreamPrompt(
  scope: UserMemoryScope,
  episodes: EpisodeSample[],
  existingAuto: string,
): DreamPrompt {
  const system = `你是一个用户记忆整理器（模仿人类睡眠中的记忆固化）。根据用户与 AI 助手的近期会话记录，提炼${userMemoryDreamTarget(scope)}。
要求：
- 只输出要点列表，每行一条，以「- 」开头，不超过 ${DREAM_MAX_FACTS} 条
- 只提炼**长期稳定**的信息；一次性任务细节、临时讨论内容、单次会话的具体操作一律忽略
- 与「已有记忆」合并：仍然成立的保留；重复的去重；被新会话推翻或明显过时的删除（遗忘）；矛盾时以新会话为准
- 每条一句话，具体、可直接被 AI 助手用来了解用户；不确定的猜测不要写
- 会话中没有该类信息且已有记忆为空时，输出空内容
- 不要输出任何解释、标题或多余文字`;

  const sections: string[] = [];
  const trimmedAuto = existingAuto.trim();
  if (trimmedAuto.length > 0) {
    sections.push(`已有记忆：\n${trimmedAuto}`);
  }
  const rendered = episodes
    .map((episode, index) => {
      const label = episode.title?.trim() ? `会话 ${index + 1}（${episode.title.trim()}）` : `会话 ${index + 1}`;
      return `${label}：\n${episode.lines.join("\n")}`;
    })
    .join("\n\n");
  sections.push(`近期会话记录：\n${rendered}`);
  return { system, user: sections.join("\n\n") };
}

/// 清洗模型输出：只保留要点行（`- ` 或 `• ` 开头），并硬截断到 DREAM_MAX_FACTS 条，
/// 防止小模型夹带解释文字或超长列表污染记忆。
export function cleanDreamedFacts(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("• "))
    .slice(0, DREAM_MAX_FACTS)
    .join("\n");
}
