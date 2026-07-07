// 写作「快捷指令」数据模型(对齐 Kun selectionAssist.quickActions,附加 enabled 支持内置禁用):
//   - 内置集:Kun 的 7 个(polish/explain/reformat/distill/bolder/quieter/critique)+ cortex 附加 2 个
//     (summarize/outline —— Kun 内置集没有,是 cortex 助手空态原有的「总结当前文档/拟一个大纲」,保留为附加内置)。
//   - 内置 label/prompt 留空 = 用 i18n 内置默认(跟随界面语言);内置可禁用(enabled=false)不可删。
//   - 自定义 ≤12 条,{label, prompt, mode} 用户填,可增删改。
// 存储在 WritingUiState.quickActions 分片(spaces store),跨空间共享。渲染前经 resolveWritingQuickActions
// 把内置留空项按 i18n 解析出 label/prompt,并过滤掉「禁用」与「无法解析(缺 label/prompt)」的项。
import type { WritingQuickAction, WritingQuickActionMode } from "../desktop/writing-types";
// 便于 views 经本子路径直接取用类型(core 主入口未导出 writing-types)。
export type { WritingQuickAction, WritingQuickActionMode } from "../desktop/writing-types";

// 自定义指令上限(对齐 Kun WRITE_QUICK_ACTION_MAX_COUNT 语义;cortex 按「自定义 ≤12」计,内置不占额)。
export const WRITING_QUICK_ACTION_MAX_CUSTOM = 12;
export const WRITING_QUICK_ACTION_LABEL_MAX = 64;
export const WRITING_QUICK_ACTION_PROMPT_MAX = 4_000;

// 内置指令集(id + 默认 mode)。前两个是 cortex 附加(对齐旧助手空态三卡),其余为 Kun 内置集。
// mode 与 Kun 一致:reformat 走就地改写(edit),其余走助手对话(chat)。
export const WRITING_QUICK_ACTION_BUILTINS: { id: string; mode: WritingQuickActionMode }[] = [
  { id: "summarize", mode: "chat" }, // cortex 附加:总结当前文档
  { id: "outline", mode: "chat" }, // cortex 附加:拟一个大纲
  { id: "polish", mode: "chat" },
  { id: "explain", mode: "chat" },
  { id: "reformat", mode: "edit" },
  { id: "distill", mode: "chat" },
  { id: "bolder", mode: "chat" },
  { id: "quieter", mode: "chat" },
  { id: "critique", mode: "chat" },
];

const BUILTIN_MODE = new Map(WRITING_QUICK_ACTION_BUILTINS.map((b) => [b.id, b.mode]));
export const WRITING_QUICK_ACTION_BUILTIN_IDS = WRITING_QUICK_ACTION_BUILTINS.map((b) => b.id);

// 内置指令默认文案(zh-Hans)。Kun 侧走 i18n;cortex 写作面板文本本就 zh 硬编码,故内置文案共置于此
// 作单一真源(与面板风格一致),不铺 18×2 语言的 i18n 键。summarize/outline 为 cortex 附加,其余取自 Kun zh。
export const WRITING_QUICK_ACTION_BUILTIN_TEXT: Record<string, { label: string; prompt: string }> = {
  summarize: { label: "总结当前文档", prompt: "请总结当前文档的主要内容与结构。" },
  outline: { label: "拟一个大纲", prompt: "请为当前文档拟一个结构清晰的大纲。" },
  polish: {
    label: "润色",
    prompt: "润色这段文字，让表达更自然流畅、更有节奏感，并保持原意和原本的语言。",
  },
  explain: {
    label: "解释",
    prompt: "请用简洁易懂的语言解释我引用的选中文本，包括其中的关键概念和必要的背景信息。",
  },
  reformat: {
    label: "重新格式化",
    prompt: "整理这段文字的排版与结构：合理分段、统一标点与空格、规范列表和标题层级，不改变原意。",
  },
  distill: {
    label: "精简",
    prompt:
      "把这段文字精简到核心：去掉冗余、套话、不必要的修饰和重复，只保留真正有信息量的表达，保持原意与原本的语言。",
  },
  bolder: {
    label: "大胆",
    prompt:
      "让这段文字更有观点、更有力量：用主动、具体、有节奏的表达替换平淡、模棱两可和被动的措辞，敢于下判断，但不夸大事实，保持原意与原本的语言。",
  },
  quieter: {
    label: "收敛",
    prompt:
      "让这段文字更克制：去掉夸张、感叹、营销腔和过度修饰，用平实、准确、冷静的表达，保持原意与原本的语言。",
  },
  critique: {
    label: "评审",
    prompt:
      "作为资深编辑评审这段内容：指出在清晰度、结构、说服力、语气和冗余上的具体问题，按重要性排序并给出可执行的修改建议。只给评审意见，不要直接改写。",
  },
};

// 取内置指令的默认文案(供 resolveWritingQuickActions 作 getBuiltinDefault)。
export function builtinQuickActionText(id: string): { label: string; prompt: string } | null {
  return WRITING_QUICK_ACTION_BUILTIN_TEXT[id] ?? null;
}

export function isBuiltinQuickAction(id: string): boolean {
  return BUILTIN_MODE.has(id);
}

export function builtinQuickActionMode(id: string): WritingQuickActionMode {
  return BUILTIN_MODE.get(id) ?? "chat";
}

// 默认配置:全部内置、留空 label/prompt(用 i18n)、启用。
export function defaultWritingQuickActions(): WritingQuickAction[] {
  return WRITING_QUICK_ACTION_BUILTINS.map((b) => ({
    id: b.id,
    label: "",
    prompt: "",
    mode: b.mode,
    enabled: true,
  }));
}

// 生成自定义指令 id(时间戳 base36,避免依赖 crypto.randomUUID)。
let customSeq = 0;
export function newCustomQuickActionId(): string {
  return `custom-${Date.now().toString(36)}-${(customSeq++).toString(36)}`;
}

// 归一化(hydrate / setQuickActions 时跑):
//   - 内置:确保 9 个内置都在(缺失的按默认补齐、置于原顺序),mode 强制回内置默认 mode,enabled 保留(缺省 true),
//     label/prompt 夹长度(允许用户覆盖内置文案)。
//   - 自定义:去重 id、夹长度、mode 仅接受 chat/edit(默认 chat)、enabled 恒 true,超出 12 条截断。
//   顺序:内置按固定顺序在前,自定义按输入顺序在后。
export function normalizeWritingQuickActions(
  input: WritingQuickAction[] | undefined,
): WritingQuickAction[] {
  const list = Array.isArray(input) ? input : [];
  const byId = new Map(list.map((a) => [typeof a?.id === "string" ? a.id : "", a]));

  const builtins: WritingQuickAction[] = WRITING_QUICK_ACTION_BUILTINS.map((b) => {
    const stored = byId.get(b.id);
    return {
      id: b.id,
      label: typeof stored?.label === "string" ? stored.label.slice(0, WRITING_QUICK_ACTION_LABEL_MAX) : "",
      prompt: typeof stored?.prompt === "string" ? stored.prompt.slice(0, WRITING_QUICK_ACTION_PROMPT_MAX) : "",
      mode: b.mode, // 内置 mode 固定,不受存档篡改
      enabled: stored?.enabled !== false, // 缺省启用;仅显式 false 视为禁用
    };
  });

  const seen = new Set(WRITING_QUICK_ACTION_BUILTIN_IDS);
  const custom: WritingQuickAction[] = [];
  for (const a of list) {
    const id = typeof a?.id === "string" ? a.id.trim() : "";
    if (!id || seen.has(id) || isBuiltinQuickAction(id)) continue;
    seen.add(id);
    custom.push({
      id,
      label: typeof a.label === "string" ? a.label.slice(0, WRITING_QUICK_ACTION_LABEL_MAX) : "",
      prompt: typeof a.prompt === "string" ? a.prompt.slice(0, WRITING_QUICK_ACTION_PROMPT_MAX) : "",
      mode: a.mode === "edit" ? "edit" : "chat",
      enabled: true, // 自定义恒启用(不需要禁用,直接删)
    });
    if (custom.length >= WRITING_QUICK_ACTION_MAX_CUSTOM) break;
  }
  return [...builtins, ...custom];
}

// 当前自定义指令条数(用于 UI 上限判断)。
export function countCustomQuickActions(actions: WritingQuickAction[]): number {
  return actions.filter((a) => !isBuiltinQuickAction(a.id)).length;
}

// 渲染用的解析结果:内置留空项按 i18n 补出 label/prompt。
export interface ResolvedWritingQuickAction {
  id: string;
  label: string;
  prompt: string;
  mode: WritingQuickActionMode;
}

// 把存储态解析为可渲染/派发的列表:过滤禁用项;内置留空 label/prompt 用 getBuiltinDefault(i18n)补;
// 补后仍缺 label 或 prompt 的项丢弃(无法渲染/派发)。顺序沿用存储顺序(内置在前、自定义在后)。
export function resolveWritingQuickActions(
  actions: WritingQuickAction[],
  getBuiltinDefault: (id: string) => { label: string; prompt: string } | null,
): ResolvedWritingQuickAction[] {
  const out: ResolvedWritingQuickAction[] = [];
  for (const a of actions) {
    if (!a.enabled) continue;
    const def = isBuiltinQuickAction(a.id) ? getBuiltinDefault(a.id) : null;
    const label = a.label.trim() || def?.label || "";
    const prompt = a.prompt.trim() || def?.prompt || "";
    if (!label || !prompt) continue;
    out.push({ id: a.id, label, prompt, mode: a.mode });
  }
  return out;
}
