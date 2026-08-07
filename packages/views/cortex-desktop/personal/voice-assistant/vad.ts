// 浏览器端能量 VAD:连续对话模式下自动判定「一句话说完」。
//
// 判定形状移植自 xiaozhi-esp32-server 的 Silero 流式路径(core/utils/vad.py),把语音概率
// 换成 AnalyserNode 能量判决:「曾有过语音 + 当前静音 + 距最后一次语音 ≥ silenceMs → 结束」,
// 未听到语音前的静音不计时。32ms 判定窗;静音判停原仓取 700ms,实测语音助手场景下句中
// 思考停顿常到 1s,700ms 会「还没说完就发送」,放宽到 1100ms。最短语音 250ms
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
  /** 噪声底自适应上浮速率(EMA 系数):环境持续有声(旁人聊天/AGC 抬底噪)时阈值随之抬高。
   * 全程生效(不限于首段语音前),下探用 3 倍速率——环境变安静时阈值要更快回落。 */
  floorAdaptRate: number;
  /** 噪声底自适应上限:防止极吵环境把阈值抬到用户正常说话也无法触发。 */
  floorCeiling: number;
  /** 强峰维持窗(可选,默认 1500ms):speaking 态下能量落在退出~进入阈值之间的「弱能量带」
   * 只在距最近一次强峰(≥进入阈值)不超过本窗时才算语音在继续。真实说话的音节峰值会
   * 频繁越过进入阈值;AGC 抬起的环境声/呼吸声只会平稳地贴在弱能量带——没有这条规则,
   * 它们会无限刷新静音计时,「停顿自动发送」永不触发(实测卡死在聆听态的主因)。 */
  strongHangoverMs?: number;
}

// 阈值按「语音频带滤波(120Hz–4kHz 带通)后的 RMS 量级」标定:滤波把空调/风扇等
// 频带外噪声滤掉后,同一环境的 RMS 显著低于原始信号,沿用旧值(enterFloor 0.025)
// 会出现「正常说话够不到进入阈值 → 永远停在聆听」的实测回归。近讲语音滤波后
// RMS 约 0.04–0.12,安静房间底噪约 0.001–0.005,取 0.012/0.007 留足两侧余量。
export const DEFAULT_VAD_CONFIG: VadConfig = {
  calibrationMs: 300,
  // 句中思考停顿(~1s)不算说完;要更快发送用热键/🎙 手动提交。
  silenceMs: 1100,
  minSpeechMs: 300,
  maxIdleMs: 30_000,
  enterFactor: 3.5,
  enterFloor: 0.012,
  exitFactor: 2.2,
  exitFloor: 0.007,
  confirmMs: 160,
  floorAdaptRate: 0.05,
  floorCeiling: 0.03,
  // 取值权衡:太短会把「轻声/渐弱的收尾段」提前归为环境声截断(还没说完就发送);
  // 太长则 AGC 底噪场景的判停变慢(最坏 strongHangoverMs + silenceMs 后仍必判停,
  // 卡死修复只依赖有限性,不依赖具体数值)。
  strongHangoverMs: 1500,
};

export type VadEvent = "speech-start" | "speech-end" | "idle-timeout" | null;

/**
 * 判断 ASR 文本是否只是声学噪声造成的无效短转写。
 *
 * 这是 VAD 后的第二道防线：Silero 能过滤多数风扇/键盘声，但极少数稳定噪声仍可能被
 * ASR 解码成标点。这里只过滤确定没有词汇内容的形状，不能按字符长度或语气词表一刀切，
 * 因为“啊”“嗯”也可能是用户真实发声，“停”“不”“好”等单字也可能是有效指令。
 */
export function isIgnorableVoiceTranscript(text: string): boolean {
  const lexical = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return !lexical;
}

/** 纯判定核:push(rms, nowMs) 喂能量采样,返回本次触发的事件(无事件为 null)。 */
export function createVadTracker(config: VadConfig = DEFAULT_VAD_CONFIG) {
  let startAt: number | null = null;
  let noiseFloor = 0;
  let calibrated = false;
  let speaking = false;
  let hadSpeech = false;
  let speechStartAt = 0;
  let lastVoiceAt = 0;
  // 最近一次强峰(能量 ≥ 进入阈值)时刻,配合 strongHangoverMs 识别「贴在弱能量带的环境声」。
  let lastStrongAt = 0;
  const strongHangoverMs = config.strongHangoverMs ?? 1500;
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
          lastStrongAt = now;
          candidateAt = null;
          return "speech-start";
        }
        candidateAt = null;
        // 噪声底连续自适应(全程生效,升慢降快、设上限)。此前只在「首段语音前」生效,
        // 说过话之后就冻结——autoGainControl 在安静段抬增益后,呼吸声/底噪会持续越过
        // 按旧噪声底算出的退出阈值,静音计时被不断重置,「停顿自动发送」就此失灵
        // (实测卡死在聆听态)。改为对所有低于进入阈值的非语音帧持续跟踪:环境变吵/AGC
        // 抬底噪 → 阈值跟着抬;环境变安静 → 以 3 倍速率回落,不牺牲灵敏度。
        if (rms > noiseFloor) {
          noiseFloor = Math.min(noiseFloor + (rms - noiseFloor) * config.floorAdaptRate, config.floorCeiling);
        } else {
          noiseFloor += (rms - noiseFloor) * Math.min(1, config.floorAdaptRate * 3);
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
      // 弱能量带([exit, enter) 区间)的维持有时限:距最近强峰超过 strongHangoverMs 仍
      // 没有新强峰,说明这不是语音的音节间隙而是环境声,强制退出 speaking,把计时权
      // 交还给静音判停(否则 AGC 抬底噪时 lastVoiceAt 被无限刷新,永远发不出去)。
      if (rms >= enterAt) {
        lastStrongAt = now;
        lastVoiceAt = now;
      } else if (rms >= exitAt && now - lastStrongAt <= strongHangoverMs) {
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
 * 共用录音的同一条 MediaStream(不得另起 getUserMedia,见 VoiceCapture.mediaStream 注释)。
 * onLevel 每个采样周期回调原始 RMS(语音助手据此驱动语音球电平动画,节流由调用方做)。 */
export function startVadMonitor(
  stream: MediaStream,
  onEvent: (event: Exclude<VadEvent, null>) => void,
  config: VadConfig = DEFAULT_VAD_CONFIG,
  onLevel?: (rms: number) => void,
): { stop: () => void } {
  const AudioContextCtor =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return { stop: () => {} }; // 环境不支持:退化为无 VAD(手动停止仍可用)

  const ctx = new AudioContextCtor();
  // 无用户手势创建的 AudioContext 可能落在 suspended 态:AnalyserNode 会恒读零,
  // VAD 便永远检测不到语音(表现同样是卡死在聆听态)。resume 幂等且失败无害。
  void ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  // 语音频带滤波(降噪判定链):人声能量集中在 ~100Hz–4kHz。先高通 120Hz 滤掉空调/风扇/
  // 桌面震动等低频隆隆声,再低通 4kHz 滤掉宽带嘶声,AnalyserNode 只看语音频带的能量——
  // 环境噪声对 RMS 的贡献大幅下降,自适应阈值不再被非语音噪声抬高或误触发。
  // 注意这条链只影响 VAD 判定,不触碰 MediaRecorder 的录音信号(录音走原始流,由
  // getUserMedia 的 noiseSuppression 约束负责降噪)。
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 120;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 4000;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512; // 512 样本窗,与 16kHz 下 32ms 判定窗同量级
  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const tracker = createVadTracker(config);

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const v = buf[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    onLevel?.(rms);
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
