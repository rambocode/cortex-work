/**
 * 音频 Blob → 单声道 16kHz 16-bit PCM WAV 编码工具。
 *
 * 背景：
 * - MediaRecorder 输出 webm/opus 或 mp4，本地 SenseVoice sidecar 与多数在线 ASR 接受 WAV。
 * - 统一重采样为 16kHz 单声道 PCM16，避免跨进程后再次解码或重采样。
 *
 * 移植自 Kun use-voice-dictation.ts 的 encodeBlobAsWav/encodeWavPcm16，
 * 去掉 base64 步骤直接返回 ArrayBuffer（cortex AsrTranscribeRequest.audio 接收 ArrayBuffer）。
 */

/** SenseVoiceSmall 与大多数在线 ASR 的通用采样率。 */
const TRANSCRIPTION_SAMPLE_RATE = 16_000;

/** 建立单声道 PCM16 WAV 容器并写入 44 字节 header。调用方负责填充 data 区。 */
function createPcm16WavBuffer(dataLength: number, sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(dataLength) || dataLength < 0 || dataLength % 2 !== 0) {
    throw new Error("PCM16 数据必须是非负偶数字节");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("WAV 采样率必须是正整数");
  if (dataLength > 0xffff_ffff - 36) throw new Error("PCM16 数据过大，无法封装为 WAV");
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);
  return buffer;
}

/** 把已经重采样好的单声道 PCM16LE 分片无损封装为 WAV。播放期插话走这条路径，
 * 因而只包含 VAD 前滚和用户语音，不需要裁剪可能缺文件头的 WebM/MP4 分片。 */
export function encodePcm16LeAsWav(
  chunks: readonly ArrayBuffer[],
  sampleRate = TRANSCRIPTION_SAMPLE_RATE,
): ArrayBuffer {
  let dataLength = 0;
  for (const chunk of chunks) {
    if (chunk.byteLength % 2 !== 0) throw new Error("PCM16 分片必须包含偶数字节");
    dataLength += chunk.byteLength;
  }
  const buffer = createPcm16WavBuffer(dataLength, sampleRate);
  const output = new Uint8Array(buffer, 44);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

/**
 * 把任意音频 Blob（webm/opus、mp4 等）解码并重采样为单声道 16kHz 16-bit PCM WAV。
 * 返回 ArrayBuffer，可直接传给 AsrTranscribeRequest.audio。
 *
 * @throws 如果 AudioContext.decodeAudioData 或 OfflineAudioContext.startRendering 失败
 */
export async function encodeBlobAsWav(blob: Blob): Promise<ArrayBuffer> {
  const compressed = await blob.arrayBuffer();

  // 步骤 1：用 AudioContext 解码压缩格式（webm/mp4 → Float32 PCM）
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(compressed);
  } finally {
    void decodeCtx.close();
  }

  // 步骤 2：OfflineAudioContext 重采样到 16kHz 单声道
  const frameCount = Math.max(1, Math.ceil(decoded.duration * TRANSCRIPTION_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1 /* 单声道 */, frameCount, TRANSCRIPTION_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  // 步骤 3：写标准 WAV header + 16-bit 小端 PCM 样本
  return encodeWavPcm16(rendered.getChannelData(0), TRANSCRIPTION_SAMPLE_RATE);
}

/** 把 Float32 PCM 样本序列编码为 WAV ArrayBuffer（44 字节 header + PCM data）。 */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2; // 每样本 2 字节（16-bit）
  const buffer = createPcm16WavBuffer(dataLength, sampleRate);
  const view = new DataView(buffer);
  // 写 PCM 样本：Float32 → 16-bit signed LE，clamp 到 [-1, 1]
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}
