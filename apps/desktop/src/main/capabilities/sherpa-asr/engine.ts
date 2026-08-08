// sherpa-onnx 流式 zipformer 识别引擎（主进程内）。
//
// 为什么是流式：SenseVoice 的整段推理只能在 VAD 判停后才开始算，用户能明确感到「说完还要等」。
// transducer 在喂 PCM 的同时就把 token 解出来了，finish 时只剩尾部一两个 chunk，实测收尾解码
// 约 7ms（见 docs/streaming-asr.md 的实测数据），主观上是「话音落 = 文本到」。
//
// ⚠ 版本红线：sherpa-onnx native **1.13.x 在 darwin-arm64 上是坏的** —— 流式 transducer 全程
// 只吐 blank，用官方 example + 官方模型 + 官方 test wav 可逐字复现，且不报任何错误（最隐蔽的
// 那种坏）。1.12.40 同样输入立刻正确。因此 root package.json 的 pnpm.overrides 把
// sherpa-onnx-darwin-arm64 / darwin-x64 / win-x64 全部钉死在 1.12.40：平台二进制包在
// sherpa-onnx-node 里是 `^` 范围，只钉 sherpa-onnx-node 会让原生库偷偷浮回 1.13.x。
// 升级 sherpa 前必须先跑 scripts/verify-sherpa-asr.mjs 确认识别结果非空。
//
// ⚠ Electron 红线：**不能用 sherpa.readWave / 任何返回 external buffer 的 API** —— Electron
// 禁用了 V8 external buffer，调用即抛 "External buffers are not allowed"。所以音频一律由我们
// 自己从 PCM16LE 转 Float32Array 后交给 acceptWaveform（这条路径已在 Electron 下实测通过）。

import { existsSync } from "node:fs";

import {
  streamingAsrModelById,
  type StreamingAsrModelId,
} from "@cortex-work/core/asr/streaming-models";
import { modelFilePaths } from "./models";

/** 采样率固定 16k：renderer 侧 VoiceCapture 已按 16k mono PCM16LE 推流。 */
const SAMPLE_RATE = 16_000;
/** 空闲多久回收识别器（连同 ~200MB 模型内存）。 */
const IDLE_RECLAIM_MS = 60_000;
/**
 * finish 时补的尾部静音时长。
 *
 * transducer 的最后一个 chunk 需要右侧上下文才会被吐出来，不补静音会稳定丢掉句尾一两个字。
 * 0.4s 是 sherpa 官方 example 的取值，实测足够且只增加个位数毫秒的解码量。
 */
const TAIL_PADDING_SECONDS = 0.4;

/** sherpa-onnx-node 的最小结构化签名（该包只带 JSDoc，没有 .d.ts）。 */
interface SherpaOnlineStream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}
interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream;
  isReady(stream: SherpaOnlineStream): boolean;
  decode(stream: SherpaOnlineStream): void;
  getResult(stream: SherpaOnlineStream): { text: string };
}
interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => SherpaOnlineRecognizer;
}

interface ActiveStream {
  stream: SherpaOnlineStream;
  /** 串行化解码任务链：保证 append 的顺序与解码顺序一致，且同一 stream 不并发进原生层。 */
  pending: Promise<void>;
  /** PCM16LE 分片可能在样本中间截断，落单的那个字节要留到下一片拼回去。 */
  carryByte: number | null;
  failed: Error | null;
}

/**
 * 把 PCM16LE 字节流转成 sherpa 需要的 Float32Array（归一化到 [-1, 1]）。
 *
 * 刻意不走 `new Int16Array(buf.buffer)`：IPC 过来的 Buffer 未必 2 字节对齐，
 * 直接建视图会抛 RangeError 或读到错位数据（错位的表现是「识别出乱码」而非报错）。
 */
export function pcm16leToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = Math.floor(pcm.length / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

class SherpaStreamingAsrEngine {
  private recognizer: SherpaOnlineRecognizer | null = null;
  private loadedModelId: StreamingAsrModelId | null = null;
  private streams = new Map<string, ActiveStream>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** stt.ts 用它判断某个 requestId 属不属于本引擎，从而在 finish/cancel 时正确分流。 */
  has(requestId: string): boolean {
    return this.streams.has(requestId);
  }

  async startStream(args: { requestId: string; modelId: unknown }): Promise<void> {
    const recognizer = this.ensureRecognizer(args.modelId);
    // 同 requestId 重入时先清掉旧的，避免泄漏原生 stream。
    this.streams.delete(args.requestId);
    this.cancelIdleTimer();
    this.streams.set(args.requestId, {
      stream: recognizer.createStream(),
      pending: Promise.resolve(),
      carryByte: null,
      failed: null,
    });
  }

  /**
   * 接收一片实时 PCM 并在其后追解码。
   *
   * 解码是同步原生调用，每次 decode 约处理 320ms 音频、耗时数毫秒；如果一次性把整段循环跑完，
   * 长句会连续占用主进程事件循环。故每解一个 chunk 就 setImmediate 让一次，把「不卡 UI」
   * 变成结构性保证而不是靠 RTF 够低来赌。
   */
  async appendAudio(requestId: string, pcm: Buffer): Promise<void> {
    const active = this.streams.get(requestId);
    if (!active) throw new Error(`流式识别会话不存在: ${requestId}`);
    if (active.failed) throw active.failed;

    let chunk = pcm;
    if (active.carryByte !== null) {
      chunk = Buffer.concat([Buffer.from([active.carryByte]), pcm]);
      active.carryByte = null;
    }
    if (chunk.length % 2 === 1) {
      active.carryByte = chunk[chunk.length - 1]!;
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    if (chunk.length === 0) return;

    const samples = pcm16leToFloat32(chunk);
    active.pending = active.pending.then(async () => {
      if (active.failed) return;
      try {
        active.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        await this.drainDecode(active.stream);
      } catch (error) {
        active.failed = error instanceof Error ? error : new Error(String(error));
      }
    });
    await active.pending;
    if (active.failed) throw active.failed;
  }

  /** 收尾：补尾部静音 → input finished → 解完剩余 chunk → 取最终文本。 */
  async finishStream(requestId: string): Promise<string> {
    const active = this.streams.get(requestId);
    if (!active) throw new Error(`流式识别会话不存在: ${requestId}`);
    const recognizer = this.recognizer;
    if (!recognizer) throw new Error("流式识别引擎已被回收");
    try {
      await active.pending;
      if (active.failed) throw active.failed;
      active.stream.acceptWaveform({
        samples: new Float32Array(Math.round(SAMPLE_RATE * TAIL_PADDING_SECONDS)),
        sampleRate: SAMPLE_RATE,
      });
      active.stream.inputFinished();
      await this.drainDecode(active.stream);
      return recognizer.getResult(active.stream).text.trim();
    } finally {
      this.streams.delete(requestId);
      this.scheduleIdleReclaim();
    }
  }

  cancelStream(requestId: string): void {
    this.streams.delete(requestId);
    this.scheduleIdleReclaim();
  }

  /** 释放识别器与全部会话；删除模型文件前必须先调用（Windows 不允许删被映射的文件）。 */
  shutdown(): void {
    this.cancelIdleTimer();
    this.streams.clear();
    this.recognizer = null;
    this.loadedModelId = null;
  }

  private async drainDecode(stream: SherpaOnlineStream): Promise<void> {
    const recognizer = this.recognizer;
    if (!recognizer) return;
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * 懒加载识别器单例。
   *
   * 首次调用时才创建（实测创建约 400ms、常驻内存数百 MB），模型 id 变化时重建。
   * 模型缺失在这里显式拦截：直接把路径丢给原生层只会得到不可读的 C++ 错误。
   */
  private ensureRecognizer(modelIdInput: unknown): SherpaOnlineRecognizer {
    const model = streamingAsrModelById(modelIdInput);
    if (this.recognizer && this.loadedModelId === model.id) return this.recognizer;

    const paths = modelFilePaths(model.id);
    for (const [role, file] of Object.entries(paths)) {
      if (!existsSync(file)) {
        throw new Error(
          `本地流式 Zipformer 模型尚未就绪（缺少 ${role}: ${file}），请先在设置中下载。`,
        );
      }
    }

    const sherpa = loadSherpa();
    this.recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
        tokens: paths.tokens,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
      // 端点检测交给 renderer 侧的 Silero VAD（silenceMs 已单独调过），这里关掉，
      // 免得 sherpa 自己的 rule2 提前切段、把一句话拆成两次结果。
      enableEndpoint: 0,
    });
    this.loadedModelId = model.id;
    return this.recognizer;
  }

  private scheduleIdleReclaim(): void {
    this.cancelIdleTimer();
    if (this.streams.size > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.streams.size === 0) {
        this.recognizer = null;
        this.loadedModelId = null;
      }
    }, IDLE_RECLAIM_MS);
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * 加载原生模块。
 *
 * 用运行时 require 而非静态 import：主进程产物是 CJS（与 ipc/pty.ts 加载 node-pty 同款），
 * 且只有在用户真的启用流式 ASR 时才需要付这份加载成本（含数十 MB dylib）。
 */
function loadSherpa(): SherpaModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("sherpa-onnx-node") as SherpaModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`加载 sherpa-onnx 原生模块失败（流式识别不可用）: ${detail}`);
  }
}

export const sherpaStreamingAsr = new SherpaStreamingAsrEngine();
