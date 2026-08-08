// openWakeWord 三级 ONNX 推理编排（onnxruntime-web wasm）。
//
// 管线（对齐上游 python AudioFeatures 的流式实现）：
//   16kHz PCM 1280 samples/步 → melspectrogram.onnx（带 480 样本前文，取末 8 帧 mel，
//   值域变换 x/10+2）→ mel 滑窗攒到 76 帧 → embedding_model.onnx → 96 维向量 →
//   embedding 滑窗攒到 16 个 → <word>.onnx classifier → sigmoid 概率。
// 判定策略在 main.ts（阈值 + 连续 2 帧确认 + 冷却）；本模块只输出每步概率。
// 能量前置门也在这里：静音帧跳过 embedding/classifier（大头），melspec 照跑保持
// 滑窗连续性（melspec 很小，静音房间整体 CPU 趋近于 0）。

import * as ort from "onnxruntime-web";

const MEL_FRAMES_PER_CHUNK = 8; // 1280 samples / 160 hop
const MEL_CONTEXT_SAMPLES = 480; // 上游实现的前文长度(3×hop),保证分帧连续
const MEL_WINDOW = 76; // embedding 输入的 mel 帧数
const EMB_WINDOW = 16; // classifier 输入的 embedding 数
const MEL_BINS = 32;
const EMB_DIM = 96;
// 能量门：int16 归一化 RMS 低于该值视为静音；命中过语音后保留 1.5s 惯性继续推理，
// 避免词中途音量下探被硬切。
const GATE_RMS = 0.0012;
const GATE_HANGOVER_CHUNKS = 19; // ≈1.5s / 80ms

export interface OpenWakeWordPipeline {
  /** 喂入一帧 1280 samples；返回本帧的唤醒概率（未到滑窗填满/被能量门跳过时为 null）。 */
  push(chunk: Float32Array): Promise<number | null>;
  /** 清空全部滑窗（suspend/resume 与命中后调用，防旧上下文串入下一轮）。 */
  reset(): void;
}

/** 加载三级模型并构建流水线。assetBase 形如 "/kws/" 或 "cortex-kws://assets/"。 */
export async function createOpenWakeWordPipeline(
  assetBase: string,
  wordModelFile: string,
): Promise<OpenWakeWordPipeline> {
  const load = async (file: string): Promise<ort.InferenceSession> =>
    ort.InferenceSession.create(`${assetBase}${file}`, { executionProviders: ["wasm"] });
  const [mel, emb, cls] = await Promise.all([
    load("melspectrogram.onnx"),
    load("embedding_model.onnx"),
    load(wordModelFile),
  ]);

  // 原始样本环形缓存：只需保留 melspec 前文(480) + 当前块。
  let rawTail = new Float32Array(MEL_CONTEXT_SAMPLES);
  const melFrames: Float32Array[] = [];
  const embeddings: Float32Array[] = [];
  let hangover = 0;

  async function runMel(chunk: Float32Array): Promise<void> {
    const input = new Float32Array(rawTail.length + chunk.length);
    input.set(rawTail, 0);
    input.set(chunk, rawTail.length);
    rawTail = input.slice(input.length - MEL_CONTEXT_SAMPLES);
    const feeds: Record<string, ort.Tensor> = {
      [mel.inputNames[0]!]: new ort.Tensor("float32", input, [1, input.length]),
    };
    const out = await mel.run(feeds);
    const data = out[mel.outputNames[0]!]!.data as Float32Array;
    const frames = data.length / MEL_BINS;
    // 只取末 8 帧（与流式步进对齐），并做上游同款值域变换。
    for (let f = Math.max(0, frames - MEL_FRAMES_PER_CHUNK); f < frames; f += 1) {
      const frame = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b += 1) frame[b] = data[f * MEL_BINS + b]! / 10 + 2;
      melFrames.push(frame);
    }
    // 滑窗只需保留 MEL_WINDOW 帧。
    while (melFrames.length > MEL_WINDOW) melFrames.shift();
  }

  async function runEmbedding(): Promise<void> {
    const input = new Float32Array(MEL_WINDOW * MEL_BINS);
    for (let f = 0; f < MEL_WINDOW; f += 1) input.set(melFrames[f]!, f * MEL_BINS);
    const feeds: Record<string, ort.Tensor> = {
      [emb.inputNames[0]!]: new ort.Tensor("float32", input, [1, MEL_WINDOW, MEL_BINS, 1]),
    };
    const out = await emb.run(feeds);
    embeddings.push((out[emb.outputNames[0]!]!.data as Float32Array).slice(0, EMB_DIM));
    while (embeddings.length > EMB_WINDOW) embeddings.shift();
  }

  async function runClassifier(): Promise<number> {
    const input = new Float32Array(EMB_WINDOW * EMB_DIM);
    for (let i = 0; i < EMB_WINDOW; i += 1) input.set(embeddings[i]!, i * EMB_DIM);
    const feeds: Record<string, ort.Tensor> = {
      [cls.inputNames[0]!]: new ort.Tensor("float32", input, [1, EMB_WINDOW, EMB_DIM]),
    };
    const out = await cls.run(feeds);
    return (out[cls.outputNames[0]!]!.data as Float32Array)[0] ?? 0;
  }

  return {
    async push(chunk: Float32Array): Promise<number | null> {
      // 能量门先行：整帧 RMS 判静音；带 hangover 防词中音量下探。
      let sum = 0;
      for (let i = 0; i < chunk.length; i += 1) sum += chunk[i]! * chunk[i]!;
      const rms = Math.sqrt(sum / chunk.length);
      if (rms >= GATE_RMS) hangover = GATE_HANGOVER_CHUNKS;
      else if (hangover > 0) hangover -= 1;

      await runMel(chunk);
      if (hangover <= 0) return null; // 静音：melspec 保持连续，跳过大头推理
      if (melFrames.length < MEL_WINDOW) return null;
      await runEmbedding();
      if (embeddings.length < EMB_WINDOW) return null;
      return runClassifier();
    },
    reset(): void {
      melFrames.length = 0;
      embeddings.length = 0;
      rawTail = new Float32Array(MEL_CONTEXT_SAMPLES);
      hangover = 0;
    },
  };
}
