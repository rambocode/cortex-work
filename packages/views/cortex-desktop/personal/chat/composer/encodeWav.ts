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
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  // RIFF/WAVE header
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  // fmt  chunk
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // AudioFormat = PCM
  view.setUint16(22, 1, true);           // NumChannels = 1 (mono)
  view.setUint32(24, sampleRate, true);  // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate = sampleRate × 2
  view.setUint16(32, 2, true);           // BlockAlign = 2
  view.setUint16(34, 16, true);          // BitsPerSample = 16
  // data chunk
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);
  // 写 PCM 样本：Float32 → 16-bit signed LE，clamp 到 [-1, 1]
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}
