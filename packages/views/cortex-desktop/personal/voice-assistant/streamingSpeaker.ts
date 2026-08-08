// 句级流式朗读的接管器：把 voiceTurn 流式增量（delta/reset）装配成句子、驱动 SpeechStream
// 边生成边播，并与控制器的状态机协调首句迁移 / willRetry 回退 / 打断取消。
//
// 两级状态（关键区分）：
// - tracking：收到本轮第一个 delta 起开始装配句子，但首句尚未闭合——控制器仍在 thinking，
//   此时 turn-end 到达则丢弃装配器、走整轮朗读旧路径（短回答常见）。
// - owning（ownsRun() = true）：首句闭合、播放流已建、状态机已迁 speaking——turn-end
//   改走 finish() 补尾差，打断需要联动停掉 agent 轮。
//
// 纯 TS 对象而非 hook：控制器用 ref 持有，避免 React 闭包捕获旧状态。

import type { DesktopBridge } from "@cortex-work/core/desktop/bridge";
import type { TtsSettings } from "@cortex-work/core/desktop/types";
import { createSpeechStream, type SpeechStream } from "@cortex-work/core";
import { createSentenceAssembler, type SentenceAssembler } from "@cortex-work/core/personal/ttsSentenceStream";
import type { VoiceTurnStreamEvent } from "@cortex-work/core/personal/voiceTurn";

export interface VoiceTurnSpeaker {
  /** delta/reset 事件入口（控制器已做 active/session/开关守卫）。 */
  onStream(ev: VoiceTurnStreamEvent): void;
  /** 是否正以流式接管某轮（可选按 runId 精确判断）。 */
  ownsRun(runId?: string): boolean;
  /** turn-end 收尾：以最终文本补尾差 + flush + finalize。仅在 ownsRun() 时调用。 */
  finish(finalText: string): void;
  /** 打断/退出/换轮：废弃装配器与接管状态。不碰 TTS——stopSpeaking 由控制器按
   * 「先切状态再停声」红线自行调用。 */
  cancel(): void;
}

export interface VoiceTurnSpeakerDeps {
  getBridge(): DesktopBridge | null;
  getTtsSettings(): TtsSettings;
  /** 首句闭合：控制器 dispatch speak（thinking→speaking）+ 开 barge-in 后台麦。
   * 返回 false 表示状态机拒绝迁移（竞态下已离开 thinking），放弃接管。 */
  onFirstSentence(): boolean;
  /** willRetry：正文作废。控制器应先 dispatch rethink 再 stopSpeaking（顺序红线）。 */
  onReset(): void;
  /** 首句合成失败且从未起播：控制器回 thinking，等 turn-end 走整轮朗读旧路径。 */
  onStreamFailed(): void;
}

interface ActiveTurn {
  runId: string;
  assembler: SentenceAssembler;
  /** null = tracking（首句未闭合）；非 null = owning。 */
  stream: SpeechStream | null;
}

/** 创建流式朗读接管器（每个控制器实例一个，跨轮复用）。 */
export function createVoiceTurnSpeaker(deps: VoiceTurnSpeakerDeps): VoiceTurnSpeaker {
  let turn: ActiveTurn | null = null;

  /** 把新闭合的句子送入播放流；首批句子到达时先建流并请求状态迁移。 */
  function deliver(cur: ActiveTurn, sentences: string[]): void {
    if (sentences.length === 0) return;
    if (!cur.stream) {
      const stream = createSpeechStream(deps.getBridge(), deps.getTtsSettings());
      // 引擎不可用或状态机拒绝迁移：放弃接管，本轮回落整轮朗读旧路径。
      if (!stream || !deps.onFirstSentence()) {
        stream?.finalize();
        turn = null;
        return;
      }
      cur.stream = stream;
      // 首句失败监听：从未起播的失败（配置/网络问题）不能让语音球卡在 speaking。
      void stream.settled.then(() => {
        if (turn === cur && stream.failedBeforeStart()) {
          turn = null;
          deps.onStreamFailed();
        }
      });
    }
    for (const sentence of sentences) cur.stream.append(sentence);
  }

  function deliverTo(stream: SpeechStream, sentences: string[]): void {
    for (const sentence of sentences) stream.append(sentence);
  }

  return {
    onStream(ev: VoiceTurnStreamEvent): void {
      if (ev.type === "reset") {
        if (!turn || turn.runId !== ev.runId) return;
        const owned = !!turn.stream;
        turn = null;
        // tracking 期的 reset 只需丢装配器；owning 期还要控制器回 thinking + 停声。
        if (owned) deps.onReset();
        return;
      }
      if (turn && turn.runId !== ev.runId) {
        // 换轮的 delta：owning 期的异轮事件是迟到流，忽略；tracking 期直接换新轮。
        if (turn.stream) return;
        turn = null;
      }
      if (!turn) turn = { runId: ev.runId, assembler: createSentenceAssembler(), stream: null };
      const cur = turn;
      deliver(cur, cur.assembler.push(ev.delta));
    },
    ownsRun(runId?: string): boolean {
      return !!turn?.stream && (runId === undefined || turn.runId === runId);
    },
    finish(finalText: string): void {
      const cur = turn;
      turn = null;
      if (!cur?.stream) return;
      // 尾差补喂：delta 可能丢失或中途启用，以 turn-end 的最终文本为准，漏掉的部分补上。
      const tail = finalText.slice(cur.assembler.fedLength());
      if (tail) deliverTo(cur.stream, cur.assembler.push(tail));
      deliverTo(cur.stream, cur.assembler.flushTail());
      cur.stream.finalize();
    },
    cancel(): void {
      turn = null;
    },
  };
}
