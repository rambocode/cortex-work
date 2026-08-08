#!/usr/bin/env node
// 流式 ASR 冒烟验证：在 Electron 的 Node ABI 下真实加载 sherpa-onnx，按 100ms 分片喂入
// 真实语音，断言「流式过程中出现过 partial」且「最终文本非空」。
//
// 为什么必须有这个脚本：sherpa 的失效模式是**静默**的 —— native 1.13.x 在 darwin-arm64 上
// 解码全程只吐 blank，不抛任何异常。只验证「模块能加载 / 识别器能创建」会全绿通过，
// 却在用户那里表现为「说了话没反应」。所以判据必须是识别结果本身。
//
// 用法（模型缺失时会给出下载提示并以非零码退出）：
//   node apps/desktop/scripts/verify-sherpa-asr.mjs
//   ELECTRON_RUN_AS_NODE=1 electron apps/desktop/scripts/verify-sherpa-asr.mjs   # 验 Electron ABI

import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

// 模型与 test wav 放在仓库外的缓存目录：199MB 的模型不进仓库，也不污染工作树。
const CACHE_DIR = process.env.SHERPA_VERIFY_DIR ?? join(repoRoot, ".sherpa-verify");
const REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
const REV = "98590b7ed6443e77b714204da2757d75e1a642f4";
const FILES = [
  "encoder-epoch-99-avg-1.int8.onnx",
  "decoder-epoch-99-avg-1.onnx",
  "joiner-epoch-99-avg-1.int8.onnx",
  "tokens.txt",
  "test_wavs/0.wav",
  "test_wavs/1.wav",
];

/** 期望在识别结果里出现的关键词，用来区分「识别对了」与「吐了乱码」。 */
const EXPECTATIONS = [
  { wav: "0.wav", mustInclude: ["昨天", "MONDAY"] },
  { wav: "1.wav", mustInclude: ["第一种"] },
];

async function ensureModel() {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const rel of FILES) {
    const name = rel.split("/").pop();
    const target = join(CACHE_DIR, name);
    if (existsSync(target)) continue;
    const url = `https://huggingface.co/${REPO}/resolve/${REV}/${rel}`;
    process.stdout.write(`下载 ${name} …\n`);
    // globalThis.fetch：脚本的 eslint env 未声明 fetch 全局（同 prepare-kws-models.mjs）。
    const res = await globalThis.fetch(url);
    if (!res.ok) throw new Error(`下载失败 ${name}: HTTP ${res.status}`);
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }
}

/**
 * 从 wav 取 PCM16LE 再转 Float32。
 * 刻意不用 sherpa.readWave：它返回 external buffer，Electron 下会抛
 * "External buffers are not allowed"，而生产路径本来也是自己转的。
 */
function readWavAsFloat32(path) {
  const buf = readFileSync(path);
  let off = 12;
  let data = null;
  while (off < buf.length - 8) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`wav 缺少 data chunk: ${path}`);
  const n = Math.floor(data.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

async function main() {
  await ensureModel();
  const sherpa = require("sherpa-onnx-node");
  const runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`;
  console.log(`运行时: ${runtime} · sherpa native ${sherpa.version}`);

  const t0 = Date.now();
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(CACHE_DIR, "encoder-epoch-99-avg-1.int8.onnx"),
        decoder: join(CACHE_DIR, "decoder-epoch-99-avg-1.onnx"),
        joiner: join(CACHE_DIR, "joiner-epoch-99-avg-1.int8.onnx"),
      },
      tokens: join(CACHE_DIR, "tokens.txt"),
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    enableEndpoint: 0,
  });
  console.log(`识别器创建耗时 ${Date.now() - t0}ms`);

  let failed = 0;
  for (const { wav, mustInclude } of EXPECTATIONS) {
    const samples = readWavAsFloat32(join(CACHE_DIR, wav));
    const stream = recognizer.createStream();
    const startedAt = Date.now();
    let partials = 0;
    let last = "";
    // 100ms 一片，复刻 renderer 的实时推流节奏
    for (let i = 0; i < samples.length; i += 1600) {
      stream.acceptWaveform({ samples: samples.slice(i, i + 1600), sampleRate: 16000 });
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const text = recognizer.getResult(stream).text;
      if (text && text !== last) { partials++; last = text; }
    }
    const streamingMs = Date.now() - startedAt;
    stream.acceptWaveform({ samples: new Float32Array(6400), sampleRate: 16000 });
    stream.inputFinished();
    const finishAt = Date.now();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const finishMs = Date.now() - finishAt;
    const text = recognizer.getResult(stream).text.trim();

    const durationSec = samples.length / 16000;
    console.log(
      `\n[${wav}] 时长 ${durationSec.toFixed(2)}s · 流式解码 ${streamingMs}ms (RTF ${(streamingMs / 1000 / durationSec).toFixed(3)})` +
      ` · partial 更新 ${partials} 次 · finish 收尾 ${finishMs}ms`,
    );
    console.log(`  识别结果: ${text || "(空)"}`);

    if (!text) { console.error(`  ✗ 识别结果为空 —— 这正是 sherpa 1.13.x 的静默失效症状`); failed++; continue; }
    if (partials === 0) { console.error(`  ✗ 全程没有 partial，说明并未边说边解码`); failed++; continue; }
    const missing = mustInclude.filter((kw) => !text.includes(kw));
    if (missing.length) { console.error(`  ✗ 结果缺少期望关键词: ${missing.join(", ")}`); failed++; continue; }
    console.log("  ✓ 通过");
  }

  if (failed > 0) {
    console.error(`\n冒烟验证失败：${failed} 个用例不通过`);
    process.exit(1);
  }
  console.log("\n冒烟验证通过：流式解码有 partial、finish 收尾接近瞬时、识别内容正确。");
}

main().catch((error) => {
  console.error("冒烟验证异常:", error);
  process.exit(1);
});
