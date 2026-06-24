// 本地 Whisper 转写（主进程）。
// 通过 spawn whisper-cli 执行本地语音识别，不走网络。
//
// 流程：
//   1. 把音频 Buffer 写入临时 WAV 文件（whisper-cli 只接受文件输入）
//   2. spawn whisper-cli，-otxt 输出纯文本，-of 指定输出基名
//   3. 读取 <outBase>.txt，trim 后返回
//   4. 无论成功失败，清理临时文件
//
// 关于 language=auto/'' 省略 -l 的原因：
//   whisper-cli 的 -l auto 语义随版本有细微差异；
//   不传 -l 时 whisper 自动检测语言，效果与 auto 等同且兼容性更好（与 Kun 对齐）。

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { resolveWhisperRunner } from "./locate";

// ── 超时常量 ──────────────────────────────────────────────────────────────────
// 与 KTD8（timeoutMs < 300s）对齐；转写单段通常 < 60s，给 large 模型留余量。
const TRANSCRIBE_TIMEOUT_MS = 180_000;

// ── 参数类型 ──────────────────────────────────────────────────────────────────

export interface TranscribeLocalOptions {
  /** 音频 Buffer（已在调用方做 MAX_BYTES 检查）。*/
  audio: ArrayBuffer;
  /** MIME 类型（用于写临时文件扩展名嗅探）。*/
  mimeType: string;
  /** BCP-47 语言代码（如 "zh"/"en"）；空串或 "auto" → 省略 -l，让 whisper 自动检测。*/
  language: string;
  /** GGML 模型文件绝对路径。*/
  modelPath: string;
}

export interface TranscribeLocalResult {
  text: string;
}

// ── 辅助：从 MIME 类型推断扩展名 ─────────────────────────────────────────────
function extFromMime(mimeType: string): string {
  const m = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (m === "audio/wav" || m === "audio/wave" || m === "audio/x-wav") return "wav";
  if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
  if (m === "audio/ogg") return "ogg";
  if (m === "audio/flac") return "flac";
  if (m === "audio/webm") return "webm";
  if (m === "audio/mp4" || m === "audio/m4a") return "m4a";
  return "wav"; // 兜底，whisper-cli 会尝试自动解码
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 调用本地 whisper-cli 转写音频。
 *
 * 临时文件统一写到 os.tmpdir()/cortex-whisper-<id>/，
 * 函数返回前（无论成功/失败）均清理该目录。
 */
export async function transcribeLocal(opts: TranscribeLocalOptions): Promise<TranscribeLocalResult> {
  const { audio, mimeType, language, modelPath } = opts;

  // 临时工作目录（隔离多并发调用）
  const tmpId = randomBytes(6).toString("hex");
  const tmpDir = join(tmpdir(), `cortex-whisper-${tmpId}`);
  const inExt = extFromMime(mimeType);
  const inFile = join(tmpDir, `input.${inExt}`);
  // -of 指定输出基名（不含扩展名）；whisper-cli 追加 .txt
  const outBase = join(tmpDir, "output");
  const outFile = `${outBase}.txt`;

  await mkdir(tmpDir, { recursive: true });

  try {
    // ── 写入音频临时文件 ────────────────────────────────────────────────────
    await writeFile(inFile, Buffer.from(audio));

    // ── 构造 whisper-cli 参数 ───────────────────────────────────────────────
    // 参数设计（与 Kun 对齐）：
    //   -m <model>  指定 GGML 模型路径
    //   -f <input>  输入音频文件
    //   -otxt       输出纯文本（.txt），不要 vtt/srt/json 等格式
    //   -of <base>  输出文件基名
    //   -nt         不输出时间戳（纯转写文本，与 UI 期望一致）
    //   -l <lang>   指定语言；"" / "auto" 时省略，让 whisper 自动检测
    const spawnArgs = [
      "-m", modelPath,
      "-f", inFile,
      "-otxt",
      "-of", outBase,
      "-nt",
    ];
    const needLang = language && language.trim() !== "" && language.trim() !== "auto";
    if (needLang) {
      spawnArgs.push("-l", language.trim());
    }

    // ── spawn whisper-cli ────────────────────────────────────────────────────
    const runner = resolveWhisperRunner();
    const text = await spawnWhisperCli(runner.command, spawnArgs, runner.cwd, runner.env);

    // ── 读取输出 .txt ────────────────────────────────────────────────────────
    // 若 spawn 未报错但文件不存在，表示 whisper-cli 未产出，视为转写失败。
    let rawText: string;
    try {
      rawText = await readFile(outFile, "utf-8");
    } catch {
      throw new Error(
        `whisper-cli 退出正常但未产出 ${outFile}。` +
        `可能原因：模型路径错误、音频格式不支持、或 whisper-cli 版本问题。\n` +
        `stdout: ${text.stdout.slice(0, 500)}`,
      );
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
      throw new Error("whisper-cli 转写结果为空（无语音内容或语言检测失败）。");
    }
    return { text: trimmed };
  } finally {
    // ── 清理临时目录（无论成功/失败） ───────────────────────────────────────
    rm(tmpDir, { recursive: true, force: true }).catch(() => {
      // 清理失败不影响转写结果，忽略
    });
  }
}

// ── whisper-cli spawn 辅助 ────────────────────────────────────────────────────

interface SpawnOutput {
  stdout: string;
}

/**
 * spawn whisper-cli，等待退出。
 * 退出码非 0 → 抛出含 stderr 的 Error。
 * 超时 TRANSCRIBE_TIMEOUT_MS → 强制 kill + 抛出。
 */
function spawnWhisperCli(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<SpawnOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      // stdio: pipe 以便捕获 stderr（whisper-cli 把日志写 stderr）
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // ── 超时看门狗 ───────────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`whisper-cli 转写超时（${TRANSCRIBE_TIMEOUT_MS / 1000}s）`));
    }, TRANSCRIBE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`whisper-cli 启动失败: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code !== 0) {
        reject(
          new Error(
            `whisper-cli 退出码 ${code}。\nstderr: ${stderr.slice(0, 1000)}`,
          ),
        );
      } else {
        resolve({ stdout });
      }
    });
  });
}
