// 语音意图裁决（U8）：把气泡渲染端回传的转写结果归一化为 controller 下一步动作。
//
// 纯逻辑（不 import electron / helper / 气泡），故可单测。controller 据裁决结果执行副作用：
// draft → 以口述文本触发起草；empty/failed → 气泡提示后回 idle（R1：不允许静默回 idle）。

import type { ReplyBubbleVoiceResult } from "../ipc/reply-types";

/** 提示态自动回 idle 的停留时长（ms）：让用户看清「没听清 / 失败」再收起气泡。 */
export const VOICE_PROMPT_DISMISS_MS = 2200;

/** 转写结果的三类裁决：起草 / 空识别 / 失败。 */
export type VoiceIntentDecision =
  | { action: "draft"; text: string }
  | { action: "empty" }
  | { action: "failed"; reason: string };

/**
 * 依转写结果裁决动作：
 * - ok 且文本去空白后非空 → draft（口述意图，交 startDraftSession）；
 * - ok 但文本空/纯空白 → empty（识别到静音 / 无语音）；
 * - !ok → failed（录音或转写异常，reason 供气泡提示）。
 */
export function decideVoiceIntent(result: ReplyBubbleVoiceResult): VoiceIntentDecision {
  if (result.ok) {
    const text = (result.text ?? "").trim();
    return text.length > 0 ? { action: "draft", text } : { action: "empty" };
  }
  return { action: "failed", reason: result.reason?.trim() || "转写失败" };
}
