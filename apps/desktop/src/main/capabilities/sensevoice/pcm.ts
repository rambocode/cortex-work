// 本地 sidecar 的输入只接受 16 kHz / 单声道 / PCM16LE；这里严格解析 renderer 生成的 WAV，
// 不依赖扩展名，也不把压缩音频或格式不匹配的数据误当裸 PCM 交给原生边界。

export function extractPcm16FromWav(input: Buffer): Buffer {
  if (input.length < 12 || input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("SenseVoice 需要有效的 RIFF/WAVE 音频");
  }

  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let pcm: Buffer | null = null;
  while (offset + 8 <= input.length) {
    const id = input.toString("ascii", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > input.length) throw new Error("WAV chunk 已截断");
    if (id === "fmt ") {
      if (size < 16) throw new Error("WAV fmt chunk 非法");
      format = {
        audioFormat: input.readUInt16LE(start),
        channels: input.readUInt16LE(start + 2),
        sampleRate: input.readUInt32LE(start + 4),
        bitsPerSample: input.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      pcm = Buffer.from(input.subarray(start, end));
    }
    offset = end + (size % 2);
  }

  if (!format || !pcm) throw new Error("WAV 缺少 fmt 或 data chunk");
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) throw new Error("SenseVoice 只接受 PCM16 WAV");
  if (format.channels !== 1) throw new Error("SenseVoice 只接受单声道 WAV");
  if (format.sampleRate !== 16_000) throw new Error("SenseVoice 只接受 16000 Hz WAV");
  if (pcm.length % 2 !== 0) throw new Error("PCM16 data chunk 长度必须为偶数");
  return pcm;
}
