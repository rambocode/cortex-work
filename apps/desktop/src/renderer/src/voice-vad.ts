// 浏览器端能量 VAD:连续对话模式下自动判定「一句话说完」。
//
// 判定形状移植自 xiaozhi-esp32-server 的 Silero 流式路径(core/utils/vad.py),把语音概率
// 换成 AnalyserNode 能量判决:「曾有过语音 + 当前静音 + 距最后一次语音 ≥ silenceMs → 结束」,
// 未听到语音前的静音不计时。参数取该仓实测值:32ms 判定窗、700ms 静音判停;最短语音 250ms
// 取 Silero 默认(原仓流式路径漏了这条,咳嗽/爆音会触发空转写,这里补上)。
// 能量阈值原仓无参考(它用神经 VAD),这里用「进入聆听后先采噪声底,阈值 = 噪声底 × 系数 +
// 绝对下限」的自适应方案,并按 Silero neg_threshold 的思路做进/出滞回,防止阈值附近抖动。

export interface VadConfig {
  /** 噪声底自校准时长(开麦后前 N ms 视为环境噪声,不做语音判定)。 */
  calibrationMs: number;
  /** 语音结束判定:距最后一次检测到语音的静音时长。 */
  silenceMs: number;
  /** 最短有效语音:短于此的「语音段」按噪声丢弃,回到等待态。 */
  minSpeechMs: number;
  /** 等待语音超时:聆听 N ms 一直无人说话则上报 idle-timeout(防连续模式无限开麦)。 */
  maxIdleMs: number;
  /** 进入语音的能量阈值 = max(噪声底 × enterFactor, enterFloor)。 */
  enterFactor: number;
  enterFloor: number;
  /** 维持语音(退出滞回)阈值 = max(噪声底 × exitFactor, exitFloor),须低于进入阈值。 */
  exitFactor: number;
  exitFloor: number;
  /** 起音确认:能量须持续 N ms 高于进入阈值才算说话开始,单帧尖峰不触发。 */
  confirmMs: number;
  /** 等待期噪声底自适应上浮速率(EMA 系数):环境持续有声(旁人聊天)时阈值随之抬高。 */
  floorAdaptRate: number;
  /** 噪声底自适应上限:防止极吵环境把阈值抬到用户正常说话也无法触发。 */
  floorCeiling: number;
}

// 阈值偏保守(近讲优先):随意环境人声通常在 enterFloor 之下;确需更灵敏时降 enterFloor。
export const DEFAULT_VAD_CONFIG: VadConfig = {
  calibrationMs: 300,
  silenceMs: 700,
  minSpeechMs: 300,
  maxIdleMs: 30_000,
  enterFactor: 3.5,
  enterFloor: 0.025,
  exitFactor: 2.2,
  exitFloor: 0.015,
  confirmMs: 160,
  floorAdaptRate: 0.05,
  floorCeiling: 0.04,
};

export type VadEvent = "speech-start" | "speech-end" | "idle-timeout" | null;

/** 纯判定核:push(rms, nowMs) 喂能量采样,返回本次触发的事件(无事件为 null)。 */
export function createVadTracker(config: VadConfig = DEFAULT_VAD_CONFIG) {
  let startAt: number | null = null;
  let noiseFloor = 0;
  let calibrated = false;
  let speaking = false;
  let hadSpeech = false;
  let speechStartAt = 0;
  let lastVoiceAt = 0;
  // 起音确认中的疑似语音起点:持续 confirmMs 高于阈值才转正,期间掉下阈值即作废。
  let candidateAt: number | null = null;
  // speech-end / idle-timeout 是一次性终态:闭锁后续帧,宿主停监视器前的残余轮询不再重复上报。
  let finished = false;

  return {
    push(rms: number, now: number): VadEvent {
      if (finished) return null;
      if (startAt === null) startAt = now;

      // 校准期:累计噪声底(取最大值,偏保守——把开麦瞬间的杂音都算进环境噪声)。
      // 只吸收窗口「内」的帧;到点的当帧直接落入下方判定,否则用户在校准结束瞬间开口,
      // 第一帧语音会被算进噪声底,阈值被抬高到永远触发不了。
      if (!calibrated) {
        if (now - startAt < config.calibrationMs) {
          noiseFloor = Math.max(noiseFloor, rms);
          return null;
        }
        calibrated = true;
      }

      const enterAt = Math.max(noiseFloor * config.enterFactor, config.enterFloor);
      const exitAt = Math.max(noiseFloor * config.exitFactor, config.exitFloor);

      if (!speaking) {
        if (rms >= enterAt) {
          // 起音确认:首帧只立疑似起点,持续 confirmMs 才转正——单帧尖峰/短促人声不触发。
          // 确认期间不走下方静音结束分支(直接 return),句间停顿的重入不会被误判成一句话结束。
          if (candidateAt === null) candidateAt = now;
          if (now - candidateAt < config.confirmMs) return null;
          speaking = true;
          if (!hadSpeech) speechStartAt = candidateAt;
          hadSpeech = true;
          lastVoiceAt = now;
          candidateAt = null;
          return "speech-start";
        }
        candidateAt = null;
        // 尚未听到有效语音时,噪声底随环境缓慢上浮(EMA、只升不降、设上限):
        // 旁边有人持续聊天 → 阈值自动抬高,不再逢声必录。
        if (!hadSpeech && rms > noiseFloor) {
          noiseFloor = Math.min(noiseFloor + (rms - noiseFloor) * config.floorAdaptRate, config.floorCeiling);
        }
        if (hadSpeech) {
          // 说完后的静音计时;句间停顿(< silenceMs)不会走到这里的结束分支。
          if (now - lastVoiceAt >= config.silenceMs) {
            if (lastVoiceAt - speechStartAt < config.minSpeechMs) {
              // 语音段过短:按噪声/爆音丢弃,回到等待态重新计 idle 超时。
              hadSpeech = false;
              startAt = now;
              return null;
            }
            finished = true;
            return "speech-end";
          }
          return null;
        }
        if (now - startAt >= config.maxIdleMs) {
          finished = true;
          return "idle-timeout";
        }
        return null;
      }

      // speaking 态:滞回退出——能量跌破 exit 阈值才开始记静音。
      if (rms >= exitAt) {
        lastVoiceAt = now;
      } else {
        speaking = false;
      }
      return null;
    },
  };
}

export type VadTracker = ReturnType<typeof createVadTracker>;

/** AnalyserNode 薄封装:按 ~32ms 周期取时域 RMS 喂纯判定核,事件经回调抛给宿主。
 * 共用录音的同一条 MediaStream(不得另起 getUserMedia,见 VoiceCapture.mediaStream 注释)。 */
export function startVadMonitor(
  stream: MediaStream,
  onEvent: (event: Exclude<VadEvent, null>) => void,
  config: VadConfig = DEFAULT_VAD_CONFIG,
): { stop: () => void } {
  const AudioContextCtor =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return { stop: () => {} }; // 环境不支持:退化为无 VAD(手动停止仍可用)

  const ctx = new AudioContextCtor();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512; // 512 样本窗,与 16kHz 下 32ms 判定窗同量级
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const tracker = createVadTracker(config);

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const event = tracker.push(rms, Date.now());
    if (event) onEvent(event);
  }, 32);

  return {
    stop: () => {
      clearInterval(timer);
      try {
        source.disconnect();
      } catch {
        /* 已断开 */
      }
      void ctx.close().catch(() => {});
    },
  };
}
