// 麦克风 Float32 帧 → 16 kHz PCM16LE 的增量重采样与 320 ms 批量。
// 跨帧保留最后一个源采样点和小数相位，避免每个 AudioProcessor 回调各自重采样造成接缝
// 丢样或累计时钟漂移。

export const PCM_TARGET_SAMPLE_RATE = 16_000;
export const PCM_BATCH_SAMPLES = 5_120; // 320 ms @ 16 kHz

export class StreamingPcm16Resampler {
  private readonly step: number;
  private readonly onChunk: (chunk: ArrayBuffer) => void;
  private source: number[] = [];
  private nextSourcePosition = 0;
  private output: number[] = [];

  constructor(sourceSampleRate: number, onChunk: (chunk: ArrayBuffer) => void) {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate < PCM_TARGET_SAMPLE_RATE) {
      throw new Error(`不支持的麦克风采样率: ${sourceSampleRate}`);
    }
    this.step = sourceSampleRate / PCM_TARGET_SAMPLE_RATE;
    this.onChunk = onChunk;
  }

  push(frame: Float32Array): void {
    for (let index = 0; index < frame.length; index += 1) this.source.push(frame[index] ?? 0);
    this.resample(false);
  }

  flush(): void {
    this.resample(true);
    this.emitOutput();
    this.source = [];
    this.nextSourcePosition = 0;
  }

  private resample(flush: boolean): void {
    const limit = flush ? this.source.length : Math.max(0, this.source.length - 1);
    while (this.nextSourcePosition < limit) {
      const leftIndex = Math.floor(this.nextSourcePosition);
      const rightIndex = Math.min(leftIndex + 1, this.source.length - 1);
      const fraction = this.nextSourcePosition - leftIndex;
      const left = this.source[leftIndex] ?? 0;
      const right = this.source[rightIndex] ?? left;
      this.output.push(left + (right - left) * fraction);
      if (this.output.length >= PCM_BATCH_SAMPLES) this.emitOutput(PCM_BATCH_SAMPLES);
      this.nextSourcePosition += this.step;
    }

    // 非 flush 时保留一个边界采样点，下一帧才能做线性插值。
    if (!flush && this.source.length > 1) {
      const drop = Math.min(Math.floor(this.nextSourcePosition), this.source.length - 1);
      if (drop > 0) {
        this.source = this.source.slice(drop);
        this.nextSourcePosition -= drop;
      }
    }
  }

  private emitOutput(count = this.output.length): void {
    if (count <= 0) return;
    const samples = this.output.splice(0, count);
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
      view.setInt16(index * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
    }
    this.onChunk(buffer);
  }
}
