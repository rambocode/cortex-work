// auto 档解析:把「应用自动选档」按当轮 prompt 派生成具体档(KTD1/KTD7)。
// 纯函数、可测;后续可换 LLM 级意图分类而不影响 adapter。
// 规则(简单关键词版,故意保守):
//   1. 非 auto → 原样返回。
//   2. auto + 「疑问引导词 + 动作词」(如「如何修复」)→ 视为只读提问 → plan。
//   3. auto + 裸祈使动作词(如「修复 X」)→ accept-edits。
//   4. 其余(纯问答/规划/空)→ plan(安全默认)。
//   危险命令永不自动升 full-auto(KTD4 安全底线)——本函数返回值域只含 plan/accept-edits。

import type { ConcretePermissionMode, PermissionMode } from "../desktop/types";

// 写/改类动作词(中英)。命中即「想动手」,但须先排除疑问引导(见下)。
const ACTION_KEYWORDS = [
  "修复",
  "修改",
  "实现",
  "重构",
  "新增",
  "删除",
  "替换",
  "添加",
  "fix",
  "implement",
  "edit",
  "refactor",
  "add",
  "remove",
  "rewrite",
  "change",
];

// 疑问/规划引导词:出现则把整句视为「关于动作的提问」而非祈使命令 → plan。
// 覆盖中文疑问引导与英文 how/should/whether 等。
const INTERROGATIVE_MARKERS = [
  "如何",
  "怎么",
  "怎样",
  "是否",
  "能不能",
  "可不可以",
  "为什么",
  "为何",
  "解释",
  "说明",
  "分析",
  "规划",
  "how ",
  "should i",
  "should we",
  "whether",
  "why ",
  "explain",
];

export function resolveEffectiveMode(
  mode: PermissionMode | undefined,
  prompt: string,
): ConcretePermissionMode {
  // 非 auto(含 undefined 兜底为 full-auto 由调用方处理;这里只解析 auto)直接透传具体档。
  if (mode !== "auto") {
    // mode 为 undefined 时返回 full-auto(与 DEFAULT_PERMISSION_MODE 一致),其余原样。
    return (mode ?? "full-auto") as ConcretePermissionMode;
  }
  const text = prompt.toLowerCase().trim();
  if (!text) return "plan";
  // 疑问/规划引导 → 只读提问。
  if (INTERROGATIVE_MARKERS.some((m) => text.includes(m))) return "plan";
  // 裸祈使动作词 → 自动改文件。
  if (ACTION_KEYWORDS.some((k) => text.includes(k))) return "accept-edits";
  return "plan";
}
