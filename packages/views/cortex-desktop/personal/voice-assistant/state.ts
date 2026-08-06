// 语音助手的可测试状态机。异步副作用(录音、转写、send、TTS)留在宿主控制器
// (VoiceAssistantController),这里只约束可见阶段的合法流转,防止热键/点击竞态
// 把管线推进到重叠状态(如录音未停又开新录音)。
//
// 与旧 voice-chat-state 的差异:多一根 active 轴(语音助手整体激活/退出,窗口层面的
// pet↔voice 互斥依赖它),且 speaking 被打断可直接回 listening(设计稿的「点击打断」)。

import type { VoiceAssistantPhase } from "@cortex-work/core/desktop/types";

export interface VoiceAssistantState {
  active: boolean;
  phase: VoiceAssistantPhase;
  error?: string;
}

export type VoiceAssistantEvent =
  | { type: "activate" }
  | { type: "listening" } // 开麦成功(idle/speaking 打断重听都收敛到这里)
  | { type: "speechEnd" } // VAD 判停/手动提交 → 转写中
  | { type: "sent" } // send 已受理 → 等回复
  | { type: "speak" } // 回合结束且有正文 → 朗读
  | { type: "speechFinished" } // TTS 播完 → idle(宿主随后按连续对话回环重听)
  | { type: "failed"; message: string } // 任意阶段失败 → idle + error(不退出)
  | { type: "deactivate" };

export const initialVoiceAssistantState: VoiceAssistantState = { active: false, phase: "idle" };

/**
 * 仅接受当前阶段允许的下一步;无效事件返回原对象,宿主可安全忽略迟到回调。
 * 失败总回 idle(active 保持),用户点球即可重新开始,不需要退出重进。
 */
export function transitionVoiceAssistant(
  state: VoiceAssistantState,
  event: VoiceAssistantEvent,
): VoiceAssistantState {
  if (event.type === "deactivate") return initialVoiceAssistantState;
  if (event.type === "activate") return { active: true, phase: "idle" };
  if (!state.active) return state; // 未激活时其余事件全部无效(迟到的 TTS/转写回调)
  if (event.type === "failed") return { active: true, phase: "idle", error: event.message };
  // listening 可从 idle、speaking(打断朗读)与 thinking(打断长时间思考,宿主会先停掉
  // 本轮 agent 运行)进入;transcribing 不许插录音——转写在途,submit 的异步链还没走完,
  // 此时开新录音会同时存在两个 MediaRecorder。
  if (event.type === "listening") {
    return state.phase === "idle" || state.phase === "speaking" || state.phase === "thinking"
      ? { active: true, phase: "listening" }
      : state;
  }
  switch (state.phase) {
    case "listening":
      return event.type === "speechEnd" ? { active: true, phase: "transcribing" } : state;
    case "transcribing":
      return event.type === "sent" ? { active: true, phase: "thinking" } : state;
    case "thinking":
      return event.type === "speak" ? { active: true, phase: "speaking" } : state;
    case "speaking":
      return event.type === "speechFinished" ? { active: true, phase: "idle" } : state;
    default:
      return state;
  }
}
