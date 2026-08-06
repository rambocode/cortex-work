// 语音助手的「回合完成」钩子：messages.ts 在一轮 agent 运行收尾处（finalizeRun /
// failPiTurn / pi 看门狗超时）广播事件，语音助手控制器据此把最终回复送去 TTS 朗读。
// 用模块级单监听器而非事件总线：全应用同时最多只有一个语音助手控制器，多监听器
// 反而会造成「谁接管朗读」的歧义（emit 的布尔返回值用于让 finalizeRun 跳过
// ttsSettings.autoSpeak 的自动朗读，防止同一轮被读两遍）。

/** 一轮 agent 运行结束的事件载荷。ok=false 时 text 可能为空（失败/超时旁路拿不到正文）。 */
export interface VoiceTurnEnd {
  sessionId: string;
  ok: boolean;
  text: string;
}

type VoiceTurnListener = (ev: VoiceTurnEnd) => boolean;

let listener: VoiceTurnListener | null = null;

/** 注册/清除语音助手的回合监听器（传 null 清除）。后注册者覆盖前者。 */
export function setVoiceTurnListener(cb: VoiceTurnListener | null): void {
  listener = cb;
}

/** 广播一轮结束。返回 true 表示语音助手接管本轮朗读，调用方（finalizeRun）应跳过
 * autoSpeak 自动朗读；监听器抛错视为未接管，不得影响会话收尾主流程。 */
export function emitVoiceTurnEnd(ev: VoiceTurnEnd): boolean {
  if (!listener) return false;
  try {
    return listener(ev);
  } catch {
    return false;
  }
}
