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

// ── 句级流式通道 ──
// 与 turn-end 同款「模块级单监听器」范式：messages.ts 在正文 delta 落点各加一行埋点，
// 语音助手激活时订阅、把增量装配成句子边生成边朗读。无监听时 emit 只付一次空判断，
// 对非语音场景零开销。

/** 一轮 agent 正文的流式增量；reset 表示重试（willRetry）导致正文作废、将从头重来。 */
export type VoiceTurnStreamEvent =
  | { type: "delta"; sessionId: string; runId: string; delta: string }
  | { type: "reset"; sessionId: string; runId: string };

type VoiceTurnStreamListener = (ev: VoiceTurnStreamEvent) => void;

let streamListener: VoiceTurnStreamListener | null = null;

/** 注册/清除句级流式监听器（传 null 清除）。后注册者覆盖前者。 */
export function setVoiceTurnStreamListener(cb: VoiceTurnStreamListener | null): void {
  streamListener = cb;
}

/** 广播一段正文增量。监听器抛错吞掉——朗读故障绝不能影响会话主流程。 */
export function emitVoiceTurnStream(ev: VoiceTurnStreamEvent): void {
  if (!streamListener) return;
  try {
    streamListener(ev);
  } catch {
    // 静默：语音层异常不上抛。
  }
}
