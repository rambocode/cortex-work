// 语音助手本地意图理解。
//
// 架构参考 xiaozhi-server：精确控制命令先在本地匹配；function_call 模式不增加前置
// LLM 调用，普通文本继续交给已有 Agent 工具链；intent_llm 模式才用短超时模型把整句
// 分类为有限的本地动作。所有异常都 fail-open 为 continue_chat，绝不能吞掉用户原话。

import { postChatCompletion } from "../../ipc/openai-chat";
import { getPersistedState } from "../../ipc/store";
import { getDefaultModelRef } from "../../providers/default-model";
import type {
  VoiceAssistantIntentName,
  VoiceAssistantIntentResult,
  VoiceIntentMode,
} from "../../ipc/types";

export interface VoiceIntentOptions {
  mode: VoiceIntentMode;
  modelRef?: { providerId: string; modelId: string } | null;
}

interface VoiceIntentDeps {
  complete(params: {
    providerId: string;
    modelId: string;
    messages: Array<{ role: "system" | "user"; content: string }>;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  }): Promise<string>;
}

interface VoiceIntentSettingsDeps extends VoiceIntentDeps {
  loadSettings(): Promise<{
    intentMode?: unknown;
    intentProviderId?: unknown;
    intentModelId?: unknown;
  } | undefined>;
  defaultRef(): Promise<{ providerId: string; modelId: string } | null>;
}

const REAL_DEPS: VoiceIntentDeps = {
  complete: (params) => postChatCompletion(params),
};

const REAL_SETTINGS_DEPS: VoiceIntentSettingsDeps = {
  ...REAL_DEPS,
  loadSettings: async () => (await getPersistedState()).voiceSettings,
  defaultRef: getDefaultModelRef,
};

const INTENT_TIMEOUT_MS = 5_000;
const ALLOWED_INTENTS = new Set<VoiceAssistantIntentName>([
  "continue_chat",
  "exit_assistant",
  "new_conversation",
  "enable_screen_context",
  "disable_screen_context",
]);

// 与 xiaozhi 的 cmd_exit 一样只做“整句相等”判断。疑问、引用或带任务正文的句子不应
// 被包含匹配误杀，例如“怎么退出语音助手”必须继续进入聊天。
const DIRECT_COMMANDS = new Map<string, Exclude<VoiceAssistantIntentName, "continue_chat">>([
  ...[
    "退出",
    "关闭",
    "再见",
    "不聊了",
    "退下",
    "退下吧",
    "你退下吧",
    "可以退下了",
    "退出语音助手",
    "关闭语音助手",
    "结束对话",
    "结束语音助手",
  ].map((command) => [command, "exit_assistant"] as const),
  ...[
    "新建对话",
    "开始新对话",
    "新开一个对话",
    "换个新对话",
  ].map((command) => [command, "new_conversation"] as const),
  ...[
    "开启屏幕上下文",
    "打开屏幕上下文",
    "带上屏幕",
  ].map((command) => [command, "enable_screen_context"] as const),
  ...[
    "关闭屏幕上下文",
    "不要看屏幕",
    "不带屏幕",
  ].map((command) => [command, "disable_screen_context"] as const),
]);

const SYSTEM_PROMPT = `你是语音助手的意图分类器。只能输出一个 JSON 对象，禁止输出解释或 Markdown。
可用函数：
- continue_chat：普通聊天、提问、执行任务，或者句子同时包含控制命令与任务正文。
- exit_assistant：用户明确要求退出或关闭语音助手。
- new_conversation：用户明确要求新建、开始或切换到一段空白对话。
- enable_screen_context：用户明确要求后续语音消息附带当前屏幕截图。
- disable_screen_context：用户明确要求停止附带当前屏幕截图。

返回格式：{"function_call":{"name":"函数名"}}
边界规则：
1. “怎么退出了”“为什么关闭”等疑问不是退出，返回 continue_chat。
2. 只有整句话的主要目的就是控制语音助手时才返回本地函数。
3. 不确定、复合任务或不在函数列表中的意图一律返回 continue_chat。`;

function normalizeCommand(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase("zh-Hans")
    .replace(/[\s，。！？、,.!?；;：:“”‘’"']/gu, "");
}

/** 解析模型的严格函数 JSON；兼容供应商偶尔包一层 Markdown code fence。 */
export function parseIntentResponse(raw: string): VoiceAssistantIntentResult {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1] ?? trimmed;
  try {
    const parsed = JSON.parse(fenced) as { function_call?: { name?: unknown } };
    const name = parsed?.function_call?.name;
    if (typeof name === "string" && ALLOWED_INTENTS.has(name as VoiceAssistantIntentName)) {
      return { name: name as VoiceAssistantIntentName, source: "intent_llm" };
    }
  } catch {
    // 非 JSON、截断或供应商附加自然语言都按普通聊天处理。
  }
  return { name: "continue_chat", source: "fallback" };
}

/**
 * 理解一条已完成纠错的语音转写。
 *
 * 输入：完整转写文本与意图模式；intent_llm 还需要由主进程解析出的模型引用。
 * 输出：白名单本地动作或 continue_chat。该函数不执行动作，也不记录原始语音文本。
 * 失败：模型不可用、超时、非法输出均收敛为 continue_chat，不向调用方抛出。
 */
export async function understandVoiceIntent(
  text: string,
  options: VoiceIntentOptions,
  deps: VoiceIntentDeps = REAL_DEPS,
): Promise<VoiceAssistantIntentResult> {
  const normalized = normalizeCommand(text);
  const direct = DIRECT_COMMANDS.get(normalized);
  if (direct) return { name: direct, source: "direct" };
  if (options.mode === "nointent") return { name: "continue_chat", source: "disabled" };
  if (options.mode === "function_call") return { name: "continue_chat", source: "function_call" };
  const ref = options.modelRef;
  if (!ref?.providerId || !ref.modelId) return { name: "continue_chat", source: "fallback" };

  try {
    const response = await deps.complete({
      providerId: ref.providerId,
      modelId: ref.modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text.trim() },
      ],
      temperature: 0,
      maxTokens: 80,
      timeoutMs: INTENT_TIMEOUT_MS,
    });
    return parseIntentResponse(response);
  } catch {
    return { name: "continue_chat", source: "fallback" };
  }
}

/** 从主进程持久化设置解析模式和模型；renderer 只传转写文本，模型密钥永不过桥。 */
export async function understandVoiceIntentFromSettings(
  text: string,
  deps: VoiceIntentSettingsDeps = REAL_SETTINGS_DEPS,
): Promise<VoiceAssistantIntentResult> {
  const settings = await deps.loadSettings();
  const rawMode = settings?.intentMode;
  const mode: VoiceIntentMode =
    rawMode === "intent_llm" || rawMode === "nointent" || rawMode === "function_call"
      ? rawMode
      : "function_call";
  let modelRef: { providerId: string; modelId: string } | null = null;
  if (mode === "intent_llm") {
    const providerId = typeof settings?.intentProviderId === "string" ? settings.intentProviderId.trim() : "";
    const modelId = typeof settings?.intentModelId === "string" ? settings.intentModelId.trim() : "";
    modelRef = providerId && modelId ? { providerId, modelId } : await deps.defaultRef();
  }
  return understandVoiceIntent(text, { mode, modelRef }, deps);
}
