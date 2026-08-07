// ASR 转写文本的 LLM 修正：本地/在线引擎都可能出现同音字、专有名词或标点错误。
// 定位是「修正器」而非「助手」——严禁增删内容或回答文本里的问题。
//
// 模型解析链:voiceSettings 的纠错专用模型(建议选响应快的小模型)→ 全局默认模型 → 无则跳过。
// prompt:voiceSettings.polishPrompt(用户可改)→ 空则内置 DEFAULT_POLISH_PROMPT;
// 词典参考与转写文本由程序追加在指令之后(静态指令在前、变量在后,保证供应商前缀缓存命中)。
//
// 失败策略(务必保持):任何环节不可用(无模型/超时/网络错/输出可疑)都**静默回退原文**,
// 修正只能是锦上添花,绝不能把「能用的转写」变成「卡住或空白」。

import { getPersistedState } from "../../ipc/store";
import { postChatCompletion } from "../../ipc/openai-chat";
import { getDefaultModelRef } from "../../providers/default-model";
import { DEFAULT_POLISH_PROMPT } from "../../ipc/types";

const POLISH_TIMEOUT_MS = 8_000;
// 超过此长度的转写不送修正:长文修正延迟高且 LLM 更易「顺手改写」,收益反转为风险。
const POLISH_MAX_CHARS = 500;

export interface PolishOptions {
  /** 听写词典条目:作为专有名词参考注入。 */
  dictionary?: string[];
  /** 自定义纠错指令;空/缺省用 DEFAULT_POLISH_PROMPT。 */
  prompt?: string;
  /** 纠错专用模型;缺省回落全局默认模型。 */
  ref?: { providerId: string; modelId: string } | null;
}

interface PolishDeps {
  complete(params: {
    providerId: string;
    modelId: string;
    messages: { role: "user"; content: string }[];
    timeoutMs: number;
  }): Promise<string>;
  defaultRef(): Promise<{ providerId: string; modelId: string } | null>;
}

const REAL_DEPS: PolishDeps = {
  complete: (params) => postChatCompletion(params),
  defaultRef: getDefaultModelRef,
};

/** 修正一段转写文本;deps 可注入以便单测。 */
export async function polishTranscript(
  text: string,
  opts: PolishOptions = {},
  deps: PolishDeps = REAL_DEPS,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > POLISH_MAX_CHARS) return text;
  const ref = opts.ref ?? (await deps.defaultRef());
  if (!ref) return text; // 无可用模型:静默跳过,不打断听写/语音聊天
  const instruction = opts.prompt?.trim() || DEFAULT_POLISH_PROMPT;
  const glossary = opts.dictionary?.length
    ? `\n专有名词参考(转写中出现相近发音时,优先修正为下列写法):${opts.dictionary.join("、")}`
    : "";
  try {
    const out = await deps.complete({
      providerId: ref.providerId,
      modelId: ref.modelId,
      messages: [{ role: "user", content: `${instruction}${glossary}\n\n转写文本:\n${trimmed}` }],
      timeoutMs: POLISH_TIMEOUT_MS,
    });
    const polished = out.trim();
    // 防御 LLM 跑偏:输出为空、或长度与原文悬殊(疑似解释/改写/答题)时一律回退原文。
    if (!polished || polished.length > trimmed.length * 2 + 20 || polished.length * 3 < trimmed.length) {
      return text;
    }
    return polished;
  } catch {
    return text;
  }
}

/** 按 voiceSettings 组装纠错调用;主进程消费方(听写 paste 前 / stt:polish handler)统一走这里。
 * 主进程读的是磁盘原始快照(未经 renderer hydrate),旧档缺 transcriptPolish 视为「默认开」,
 * 与工厂默认一致。 */
export async function polishTranscriptIfEnabled(text: string): Promise<string> {
  const settings = (await getPersistedState()).voiceSettings;
  if ((settings?.transcriptPolish ?? true) === false) return text;
  const providerId = settings?.polishProviderId?.trim();
  const modelId = settings?.polishModelId?.trim();
  return polishTranscript(text, {
    dictionary: settings?.dictationDictionary,
    prompt: settings?.polishPrompt,
    // 两段必须成套才算「用户指定了纠错模型」,缺一段不猜、落回全局默认(与 default-model 同则)。
    ref: providerId && modelId ? { providerId, modelId } : null,
  });
}
