// Electron 主进程与原生 SenseVoice sidecar 的 stdio 二进制帧协议。
//
// 4 字节大端长度覆盖「1 字节类型 + payload」。长度前缀可正确处理 pipe 的拆包与粘包；
// JSON 只承载低频控制信息，连续 PCM 不做 base64，避免额外复制和约 33% 体积膨胀。

export const PCM_SAMPLE_RATE = 16_000;
export const MAX_AUDIO_SECONDS = 30;
export const MAX_AUDIO_BYTES = PCM_SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS;
const MAX_CONTROL_BYTES = 64 * 1024;
const HEADER_BYTES = 5;

export enum SenseVoiceFrameType {
  Begin = 1,
  Audio = 2,
  End = 3,
  Cancel = 4,
  Shutdown = 5,
}

export interface SenseVoiceFrame {
  type: SenseVoiceFrameType;
  payload: Buffer;
}

function isFrameType(value: number): value is SenseVoiceFrameType {
  return value >= SenseVoiceFrameType.Begin && value <= SenseVoiceFrameType.Shutdown;
}

function encodeFrame(type: SenseVoiceFrameType, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32BE(payload.length + 1, 0);
  frame[4] = type;
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export function encodeControlFrame(
  type: Exclude<SenseVoiceFrameType, SenseVoiceFrameType.Audio>,
  payload: Record<string, unknown> = {},
): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_CONTROL_BYTES) throw new Error("SenseVoice 控制帧超过 64 KB 上限");
  return encodeFrame(type, body);
}

export function encodeAudioFrame(pcm16le: Buffer): Buffer {
  if (pcm16le.length > MAX_AUDIO_BYTES) {
    throw new Error("SenseVoice AUDIO 帧超过 30 秒 PCM16 上限");
  }
  if (pcm16le.length % 2 !== 0) throw new Error("SenseVoice PCM16 字节数必须为偶数");
  return encodeFrame(SenseVoiceFrameType.Audio, pcm16le);
}

export class SenseVoiceFrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): SenseVoiceFrame[] {
    if (chunk.length > 0) this.pending = Buffer.concat([this.pending, chunk]);
    const frames: SenseVoiceFrame[] = [];
    while (this.pending.length >= 4) {
      const bodyLength = this.pending.readUInt32BE(0);
      if (bodyLength < 1) throw new Error("SenseVoice 帧长度非法");
      if (bodyLength > MAX_AUDIO_BYTES + 1) throw new Error("SenseVoice 帧超过协议上限");
      if (this.pending.length < bodyLength + 4) break;
      const typeValue = this.pending[4]!;
      if (!isFrameType(typeValue)) throw new Error(`SenseVoice 未知帧类型: ${typeValue}`);
      const payload = Buffer.from(this.pending.subarray(HEADER_BYTES, bodyLength + 4));
      frames.push({ type: typeValue, payload });
      this.pending = this.pending.subarray(bodyLength + 4);
    }
    return frames;
  }
}
