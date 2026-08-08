// 语音助手本地意图理解。
//
// 架构参考 xiaozhi-server：精确控制命令先在本地匹配；function_call 模式不增加前置
// LLM 调用，普通文本继续交给已有 Agent 工具链；intent_llm 模式才用短超时模型把整句
// 分类为有限的本地动作。所有异常都 fail-open 为 continue_chat，绝不能吞掉用户原话。

import { postChatCompletion } from "../../ipc/openai-chat";
import { getPersistedState } from "../../ipc/store";
import { getDefaultModelRef } from "../../providers/default-model";
import { DIRECT_COMMANDS, FAST_PATH_MAX_CHARS, isFastPathVetoed, normalizeCommand } from "./commands";
import { matchCommandFuzzy } from "./fuzzy";
import type {
  VoiceAssistantIntentName,
  VoiceAssistantIntentResult,
  VoiceIntentMode,
} from "../../ipc/types";

export interface VoiceIntentOptions {
  mode: VoiceIntentMode;
  modelRef?: { providerId: string; modelId: string } | null;
  /** 拼音模糊 fast-path 开关（voiceSettings.commandFuzzyMatch，默认开）。 */
  fuzzyMatch?: boolean;
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
    commandFuzzyMatch?: unknown;
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

// 精确命令注册表与归一化已迁至 ./commands.ts（模板本体在 core/personal/voice-commands.ts，
// 与 renderer 共享单一事实源）；拼音模糊匹配见 ./fuzzy.ts。

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
  // 拼音模糊 fast-path（P0，参考 xiaozhi「简单指令离线」）：只对短句启用，疑问句硬否决，
  // 与精确匹配一样先于三模式分流执行（nointent 下精确命令本就生效，容错版同理）。
  if (
    (options.fuzzyMatch ?? true) &&
    normalized.length <= FAST_PATH_MAX_CHARS &&
    !isFastPathVetoed(text)
  ) {
    const fuzzy = matchCommandFuzzy(normalized);
    if (fuzzy) return { name: fuzzy, source: "direct_fuzzy" };
  }
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
  // 旧存档缺键 = 默认开启；显式 false 才关闭（与 renderer 侧 ?? true 口径一致）。
  const fuzzyMatch = settings?.commandFuzzyMatch !== false;
  return understandVoiceIntent(text, { mode, modelRef, fuzzyMatch }, deps);
}
