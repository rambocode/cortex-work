// 句级流式 TTS 的句子装配器：把 LLM 增量文本流装配成一条条"闭合即可朗读"的句子。
//
// 为什么要有它：旧路径等 Agent 整轮生成结束才开始朗读，长回答首声延迟 = 整轮生成时长。
// 借鉴 xiaozhi「LLM→TTS 按标点切句、首段最小化」的策略，句子一闭合就可送 TTS 起播。
// 纯逻辑、零平台依赖，可单测。

import { MAX_SPEECH_CHARS, sanitizeSpeechInline } from "./tts";

/** 强句终止符：任何时候都闭合句子。 */
const STRONG_BOUNDARY = /[。！？!?；;\n]/u;
/** 首句 eager 边界：尚未产出任何句子时，逗号/冒号也算边界（配合最短字数），
 * 让首包尽早出声；后续句子只认强终止符，避免把长句剁得太碎（播放层还会按
 * 30 字二次切块兜底）。 */
const EAGER_BOUNDARY = /[，,：:]/u;
const EAGER_MIN_CHARS = 8;

export interface SentenceAssembler {
  /** 喂入一段增量文本，返回本次新闭合的句子（已清洗，可能为空数组）。 */
  push(delta: string): string[];
  /** 收尾：把未闭合的尾部作为最后一句返回（含超限省略提示）。 */
  flushTail(): string[];
  /** 已喂入的原始字符总数：turn-end 时与最终文本做尾差对齐（slice 起点）。 */
  fedLength(): number;
  reset(): void;
}

/** 创建句子装配器。工厂函数而非 class 导出：调用方只依赖接口，便于测试替身。 */
export function createSentenceAssembler(): SentenceAssembler {
  // buf: 未扫描的原始流（可能以不完整的 ``` 前缀结尾）；pending: 已扫描、未闭合成句的正文。
  let buf = "";
  let pending = "";
  let inFence = false;
  let fed = 0;
  let emittedAny = false;
  let spokenChars = 0;
  let capped = false;
  let cappedNotified = false;

  /** 闭合 pending 为一句：清洗、去空、累计字数超限后整句丢弃（capped 置位）。 */
  function takePending(): string | null {
    const sentence = sanitizeSpeechInline(pending);
    pending = "";
    if (!sentence || capped) return null;
    if (spokenChars + sentence.length > MAX_SPEECH_CHARS) {
      capped = true;
      return null;
    }
    spokenChars += sentence.length;
    emittedAny = true;
    return sentence;
  }

  function isBoundary(ch: string): boolean {
    if (STRONG_BOUNDARY.test(ch)) return true;
    // 首句 eager：只有在积累了最短可读长度后才提前闭合，防止"好，""嗯，"这类碎句。
    return !emittedAny && EAGER_BOUNDARY.test(ch) && pending.trim().length >= EAGER_MIN_CHARS;
  }

  /** 扫描 buf：处理代码围栏状态机与句边界。final=true 表示流已结束，不再保留部分标记。 */
  function drain(final: boolean): string[] {
    const out: string[] = [];
    while (true) {
      if (inFence) {
        const close = buf.indexOf("```");
        if (close < 0) {
          if (final) {
            // 流结束仍未闭合的围栏：按代码整体略过，不把半截代码读出来。
            buf = "";
            inFence = false;
            pending += "（代码略）";
          } else {
            // 只保留可能构成关闭标记前缀的尾部反引号，其余围栏内内容吞掉。
            buf = /`{1,2}$/u.exec(buf)?.[0] ?? "";
          }
          return out;
        }
        buf = buf.slice(close + 3);
        inFence = false;
        // 围栏整体替换为占位，闭合时机交给后续边界（与 clipSpeechText 的替换语义一致）。
        pending += "（代码略）";
        continue;
      }
      const open = buf.indexOf("```");
      let limit = open >= 0 ? open : buf.length;
      if (open < 0 && !final) {
        // 尾部 1-2 个反引号可能是跨 delta 的 ``` 前缀，留到下一次 push 再判定。
        limit -= /`{1,2}$/u.exec(buf)?.[0]?.length ?? 0;
      }
      let consumed = 0;
      for (; consumed < limit; consumed += 1) {
        const ch = buf[consumed]!;
        pending += ch;
        if (isBoundary(ch)) {
          const sentence = takePending();
          if (sentence) out.push(sentence);
        }
      }
      buf = buf.slice(consumed + (open >= 0 ? 3 : 0));
      if (open >= 0) {
        inFence = true;
        continue;
      }
      return out;
    }
  }

  return {
    push(delta: string): string[] {
      // fed 必须无条件累计：turn-end 的尾差对齐按原始流长度 slice，capped 后也不能漂移。
      fed += delta.length;
      if (capped) return [];
      buf += delta;
      return drain(false);
    },
    flushTail(): string[] {
      const out = drain(true);
      const tail = takePending();
      if (tail) out.push(tail);
      if (capped && !cappedNotified) {
        cappedNotified = true;
        out.push("……以下省略");
      }
      return out;
    },
    fedLength(): number {
      return fed;
    },
    reset(): void {
      buf = "";
      pending = "";
      inFence = false;
      fed = 0;
      emittedAny = false;
      spokenChars = 0;
      capped = false;
      cappedNotified = false;
    },
  };
}
