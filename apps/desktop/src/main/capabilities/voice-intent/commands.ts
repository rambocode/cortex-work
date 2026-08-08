// 本地指令注册表：把 core 侧共享模板编译成「归一化整句 → 动作」的精确匹配 Map。
// 模板本体在 packages/core/personal/voice-commands.ts（单一事实源，renderer 未来的
// 语义匹配复用同一份），这里只做主进程消费侧的归一化与索引。

import {
  FAST_PATH_MAX_CHARS,
  INTENT_VETO_PATTERNS,
  VOICE_COMMAND_TEMPLATES,
} from "@cortex-work/core/personal/voice-commands";
import type { VoiceAssistantIntentName } from "../../ipc/types";

export { FAST_PATH_MAX_CHARS };

/** 归一化口径：去空白、去常见中英标点、按 zh-Hans 小写。与 xiaozhi 的 cmd_exit 一样
 * 只支撑「整句相等」判断，绝不用于包含匹配。 */
export function normalizeCommand(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase("zh-Hans")
    .replace(/[\s，。！？、,.!?；;：:“”‘’"']/gu, "");
}

/** 归一化整句 → 本地动作 的精确匹配索引（模块加载时一次性构建）。 */
export const DIRECT_COMMANDS: ReadonlyMap<
  string,
  Exclude<VoiceAssistantIntentName, "continue_chat">
> = new Map(
  VOICE_COMMAND_TEMPLATES.flatMap((template) =>
    template.phrases.map((phrase) => [normalizeCommand(phrase), template.intent] as const),
  ),
);

/** 疑问/求助句硬否决：命中即禁止 fast-path 模糊匹配（「怎么退出」必须进聊天）。
 * 用原文（未归一化）判断——归一化会剥掉「吗？」的问号，削弱句尾疑问词检测。 */
export function isFastPathVetoed(text: string): boolean {
  return INTENT_VETO_PATTERNS.some((pattern) => pattern.test(text.trim()));
}
