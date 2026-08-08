// 拼音模糊匹配：意图 fast-path 的 P0 实现（零模型、<1ms）。
//
// 背景：短指令的 ASR 主要错误形态是同音/近音错字（「退下」→「腿下」、「对话」→「对画」），
// 字符级精确匹配对此束手无策，但拼音归一后它们完全相同。参考 xiaozhi「简单指令离线」
// 思想，在主进程本地消化这类指令，免走一次云端 LLM 往返。
//
// 匹配从严不从宽（误执行「退出」的代价远高于漏匹配一次）：
// ① 拼音串精确相等（覆盖纯同音错字，绝大多数场景）；
// ② 音节数相同且恰有一个音节替换、且被替换的音节声母或韵母相同（近音容错）。
// 刻意不允许音节插入/删除：允许的话「推一下」(tui yi xia) 与「退下」(tui xia) 的
// 编辑距离恰为 1，会被误判成退出——这是单测固化的负例红线。

import { pinyin } from "pinyin-pro";
import { VOICE_COMMAND_TEMPLATES } from "@cortex-work/core/personal/voice-commands";
import type { VoiceAssistantIntentName } from "../../ipc/types";
import { normalizeCommand } from "./commands";

type CommandIntent = Exclude<VoiceAssistantIntentName, "continue_chat">;

/** 无声调全拼音节序列；非中文片段按连续块原样保留（与模板同口径，比较仍成立）。 */
function toSyllables(normalized: string): string[] {
  if (!normalized) return [];
  return pinyin(normalized, { toneType: "none", type: "array", nonZh: "consecutive" });
}

// 声母表按长度降序做最长前缀匹配（zh/ch/sh 必须先于 z/c/s 尝试）。
const INITIALS = [
  "zh", "ch", "sh",
  "b", "p", "m", "f", "d", "t", "n", "l",
  "g", "k", "h", "j", "q", "x", "r",
  "z", "c", "s", "y", "w",
];

/** 拆音节为声母/韵母；零声母音节（如 "an"）声母为空串。 */
function splitSyllable(syllable: string): { initial: string; final: string } {
  const initial = INITIALS.find((prefix) => syllable.startsWith(prefix)) ?? "";
  return { initial, final: syllable.slice(initial.length) };
}

/** 近音判定：声母或韵母任一相同即认为「听感相邻」，允许作为唯一的替换位。 */
function isNearHomophone(a: string, b: string): boolean {
  const sa = splitSyllable(a);
  const sb = splitSyllable(b);
  return (sa.initial !== "" && sa.initial === sb.initial) || sa.final === sb.final;
}

interface CompiledPhrase {
  intent: CommandIntent;
  syllables: string[];
  joined: string;
}

// 模板音节缓存：模块加载时一次性编译（几十条短语，成本可忽略）。
const COMPILED: readonly CompiledPhrase[] = VOICE_COMMAND_TEMPLATES.flatMap((template) =>
  template.phrases.map((phrase) => {
    const syllables = toSyllables(normalizeCommand(phrase));
    return { intent: template.intent, syllables, joined: syllables.join(" ") };
  }),
);

/**
 * 对归一化后的转写文本做拼音模糊匹配。
 *
 * 输入必须已过 normalizeCommand，且调用方需先做短句门与疑问句否决（见 understand.ts）。
 * 返回命中的本地动作；任何不满足从严规则的情况返回 null（fail-open 交回原链路）。
 */
export function matchCommandFuzzy(normalizedText: string): CommandIntent | null {
  const syllables = toSyllables(normalizedText);
  if (syllables.length === 0) return null;
  const joined = syllables.join(" ");

  for (const phrase of COMPILED) {
    // 规则①：拼音串精确相等（同音错字）。
    if (phrase.joined === joined) return phrase.intent;
    // 规则②：等长 + 恰一个近音替换。
    if (phrase.syllables.length !== syllables.length) continue;
    let mismatch = -1;
    let tooMany = false;
    for (let i = 0; i < syllables.length; i += 1) {
      if (syllables[i] === phrase.syllables[i]) continue;
      if (mismatch >= 0) {
        tooMany = true;
        break;
      }
      mismatch = i;
    }
    if (tooMany || mismatch < 0) continue;
    if (isNearHomophone(syllables[mismatch], phrase.syllables[mismatch])) return phrase.intent;
  }
  return null;
}
