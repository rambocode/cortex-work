// KWS 窗口的麦克风采集：getUserMedia（AEC/NS/AGC 强制开，口径与主窗口 voiceRecorder 一致，
// AEC 是防 TTS 播报自唤醒的第一道防线）→ ScriptProcessor 抽帧 → 线性插值重采样到 16kHz
// → 按 1280 samples(80ms) 一帧回调（openWakeWord 的标准步进）。
// 不依赖 views 的 pcmStream(那是 views 包内部模块)；这里的重采样器保持跨帧相位连续。

export const KWS_SAMPLE_RATE = 16_000;
export const KWS_CHUNK_SAMPLES = 1_280; // 80ms @16k

export interface KwsCapture {
  stop(): void;
}

/** 打开麦克风并持续回调 16kHz float32 帧。失败向上抛（调用方上报 degraded）。 */
export async function startKwsCapture(onChunk: (chunk: Float32Array) => void): Promise<KwsCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ latencyHint: "playback" });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor 已弃用但仍是零依赖抽 PCM 最稳妥的通路（与主窗口 voiceRecorder 同款取舍）。
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // 静音 gain 接 destination：不接输出节点的 ScriptProcessor 在部分 Chromium 版本不触发回调。
  const silent = ctx.createGain();
  silent.gain.value = 0;

  const ratio = ctx.sampleRate / KWS_SAMPLE_RATE;
  // 跨帧重采样相位与半成品块缓存。
  let readPos = 0;
  let carry = new Float32Array(0);
  let pending = new Float32Array(KWS_CHUNK_SAMPLES);
  let pendingLen = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    // 拼上一帧余样保持相位连续，线性插值降采样。
    const merged = new Float32Array(carry.length + input.length);
    merged.set(carry, 0);
    merged.set(input, carry.length);
    let pos = readPos;
    while (pos + 1 < merged.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const sample = merged[i]! * (1 - frac) + merged[i + 1]! * frac;
      pending[pendingLen] = sample;
      pendingLen += 1;
      if (pendingLen === KWS_CHUNK_SAMPLES) {
        onChunk(pending);
        pending = new Float32Array(KWS_CHUNK_SAMPLES);
        pendingLen = 0;
      }
      pos += ratio;
    }
    const consumed = Math.floor(pos);
    readPos = pos - consumed;
    carry = merged.slice(consumed);
  };

  source.connect(processor);
  processor.connect(silent);
  silent.connect(ctx.destination);

  return {
    stop(): void {
      processor.disconnect();
      source.disconnect();
      silent.disconnect();
      void ctx.close().catch(() => {});
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
