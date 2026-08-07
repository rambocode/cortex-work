// SenseVoice 原生 sidecar 的常驻客户端。
//
// 主进程是唯一 owner：一个进程加载一个模型、一个实时会话独占 stdin。当前语句 PCM 保留
// 在内存中，sidecar 意外退出时最多重启并重放一次；第二次失败直接回报，绝不无限重试或
// 静默改走云端。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { resolveSenseVoiceSidecar, type SenseVoiceSidecarLocation } from "./locate";
import {
  MAX_AUDIO_BYTES,
  SenseVoiceFrameType,
  encodeAudioFrame,
  encodeControlFrame,
} from "./protocol";

export type SidecarEvent =
  | { type: "ready"; protocol: number }
  | { type: "final"; requestId: string; text: string }
  | { type: "error"; requestId?: string; code: string; message: string }
  | { type: "cancelled"; requestId: string };

export function parseSidecarEvent(line: string): SidecarEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("SenseVoice sidecar 输出了非法 JSON");
  }
  if (!value || typeof value !== "object") throw new Error("SenseVoice sidecar 事件必须是对象");
  const event = value as Record<string, unknown>;
  if (event.type === "ready" && typeof event.protocol === "number") {
    return { type: "ready", protocol: event.protocol };
  }
  if (event.type === "final") {
    if (typeof event.requestId !== "string") throw new Error("SenseVoice final 缺少 requestId");
    if (typeof event.text !== "string") throw new Error("SenseVoice final 缺少 text");
    return { type: "final", requestId: event.requestId, text: event.text };
  }
  if (event.type === "error") {
    if (typeof event.code !== "string" || typeof event.message !== "string") {
      throw new Error("SenseVoice error 缺少 code/message");
    }
    return {
      type: "error",
      requestId: typeof event.requestId === "string" ? event.requestId : undefined,
      code: event.code,
      message: event.message,
    };
  }
  if (event.type === "cancelled") {
    if (typeof event.requestId !== "string") throw new Error("SenseVoice cancelled 缺少 requestId");
    return { type: "cancelled", requestId: event.requestId };
  }
  throw new Error(`SenseVoice sidecar 未知事件: ${String(event.type)}`);
}

interface ActiveSession {
  requestId: string;
  modelPath: string;
  language: string;
  chunks: Buffer[];
  audioBytes: number;
  ended: boolean;
  retries: number;
  result: Promise<string>;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

interface SenseVoiceClientDeps {
  spawn?: typeof spawn;
  locate?: () => SenseVoiceSidecarLocation;
  readyTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class SenseVoiceClient {
  private readonly spawnImpl: typeof spawn;
  private readonly locate: () => SenseVoiceSidecarLocation;
  private readonly readyTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private loadedModelPath: string | null = null;
  private stdoutPending = "";
  private active: ActiveSession | null = null;
  private recovery: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private oneShotTail: Promise<void> = Promise.resolve();
  private pendingOneShots = 0;
  private idleWaiters: Array<() => void> = [];
  private queueGeneration = 0;

  constructor(deps: SenseVoiceClientDeps = {}) {
    this.spawnImpl = deps.spawn ?? spawn;
    this.locate = deps.locate ?? resolveSenseVoiceSidecar;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 30_000;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 60_000;
  }

  async startStream(args: { requestId: string; modelPath: string; language: string }): Promise<void> {
    if (!args.requestId.trim()) throw new Error("SenseVoice requestId 不能为空");
    if (this.active) throw new Error(`已有 SenseVoice 会话正在运行: ${this.active.requestId}`);
    this.clearIdleTimer();
    let resolveResult!: (text: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // 防止调用方在 finish 前取消/崩溃时，result reject 形成未处理 rejection；真正的调用方
    // 仍会通过 finishStream 收到同一个 rejection。
    void result.catch(() => undefined);
    this.active = {
      requestId: args.requestId,
      modelPath: args.modelPath,
      language: args.language || "auto",
      chunks: [],
      audioBytes: 0,
      ended: false,
      retries: 0,
      result,
      resolve: resolveResult,
      reject: rejectResult,
    };
    try {
      await this.ensureProcess(args.modelPath);
      await this.writeControl(SenseVoiceFrameType.Begin, {
        requestId: args.requestId,
        language: args.language || "auto",
      });
    } catch (error) {
      this.failActive(asError(error));
      throw error;
    }
  }

  async appendAudio(requestId: string, pcm16le: Buffer): Promise<void> {
    await this.waitForRecovery();
    const session = this.requireSession(requestId);
    if (session.ended) throw new Error("SenseVoice 会话已经结束接收音频");
    if (session.audioBytes + pcm16le.length > MAX_AUDIO_BYTES) {
      throw new Error("SenseVoice 单句音频超过 30 秒上限");
    }
    const copy = Buffer.from(pcm16le);
    session.chunks.push(copy);
    session.audioBytes += copy.length;
    await this.write(encodeAudioFrame(copy));
  }

  /**
   * 将完整 PCM 排入单 sidecar 队列。队列最多容纳两个任务；若实时会话正在使用进程，
   * 则等待它结束后继续，避免整段 WAV 入口与实时入口争抢 stdin。
   */
  transcribePcm(args: { modelPath: string; language: string; pcm16le: Buffer }): Promise<string> {
    if (this.pendingOneShots >= 2) return Promise.reject(new Error("SenseVoice 转写队列已满（最多 2 条）"));
    this.pendingOneShots += 1;
    const generation = this.queueGeneration;
    let resolveText!: (text: string) => void;
    let rejectText!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveText = resolve;
      rejectText = reject;
    });
    const run = async (): Promise<void> => {
      try {
        await this.waitUntilIdle();
        if (generation !== this.queueGeneration) throw new Error("SenseVoice 转写队列已取消");
        const requestId = randomUUID();
        await this.startStream({ requestId, modelPath: args.modelPath, language: args.language });
        await this.appendAudio(requestId, args.pcm16le);
        resolveText(await this.finishStream(requestId));
      } catch (error) {
        rejectText(asError(error));
      } finally {
        this.pendingOneShots -= 1;
      }
    };
    this.oneShotTail = this.oneShotTail.catch(() => undefined).then(run);
    return result;
  }

  async finishStream(requestId: string): Promise<string> {
    // 先捕获 result，再让出微任务；原生 final 可能紧跟 END 返回并清空 active。
    const session = this.requireSession(requestId);
    await this.waitForRecovery();
    if (!session.ended) {
      session.ended = true;
      await this.writeControl(SenseVoiceFrameType.End, { requestId });
    }
    return session.result;
  }

  async cancelStream(requestId: string): Promise<void> {
    await this.waitForRecovery();
    const session = this.requireSession(requestId);
    await this.writeControl(SenseVoiceFrameType.Cancel, { requestId }).catch(() => undefined);
    this.failActive(new Error("SenseVoice 会话已取消"));
    session.chunks.length = 0;
  }

  waitForRecovery(): Promise<void> {
    return this.recovery ?? Promise.resolve();
  }

  shutdown(): void {
    // 使已经排队但尚未启动的整段任务失效；下一次新请求仍可按新的 generation 启动进程。
    this.queueGeneration += 1;
    this.clearIdleTimer();
    this.intentionalStop = true;
    const child = this.child;
    this.child = null;
    this.loadedModelPath = null;
    this.readyWaiter?.reject(new Error("SenseVoice sidecar 已关闭"));
    this.readyWaiter = null;
    this.failActive(new Error("SenseVoice sidecar 已关闭"));
    if (child) {
      try {
        child.stdin.write(encodeControlFrame(SenseVoiceFrameType.Shutdown));
        child.stdin.end();
      } catch {
        // pipe 已断时直接 kill，关闭流程不再抛出。
      }
      child.kill();
    }
  }

  private async ensureProcess(modelPath: string): Promise<void> {
    if (this.child && this.loadedModelPath === modelPath) return;
    if (this.child) this.stopProcessOnly();
    const location = this.locate();
    this.intentionalStop = false;
    const child = this.spawnImpl(location.command, ["--model", modelPath], {
      cwd: location.cwd,
      env: { ...process.env, ...location.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.loadedModelPath = modelPath;
    this.stdoutPending = "";
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", () => {
      // 原生日志只用于诊断，不混进 renderer 错误；进程 exit 会给出稳定错误。
    });
    child.on("error", (error) => this.onProcessFailure(child, error));
    child.on("exit", (code, signal) => {
      this.onProcessFailure(child, new Error(`SenseVoice sidecar 退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.readyWaiter) this.readyWaiter = null;
          reject(new Error(`SenseVoice sidecar 启动超时（${this.readyTimeoutMs}ms）`));
        }, this.readyTimeoutMs);
        this.readyWaiter = {
          resolve: () => {
            clearTimeout(timer);
            this.readyWaiter = null;
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            this.readyWaiter = null;
            reject(error);
          },
        };
      });
    } catch (error) {
      // 超时或协议不兼容的进程不能留作“已加载”复用；否则下一次请求会跳过 ready
      // 握手，直接向状态未知的 stdin 写 BEGIN。仅清理由本次 ensureProcess 创建的实例。
      if (this.child === child) this.stopProcessOnly();
      throw error;
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutPending += chunk.toString("utf8");
    while (true) {
      const newline = this.stdoutPending.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutPending.slice(0, newline).trim();
      this.stdoutPending = this.stdoutPending.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleEvent(parseSidecarEvent(line));
      } catch (error) {
        this.failActive(asError(error));
      }
    }
  }

  private handleEvent(event: SidecarEvent): void {
    if (event.type === "ready") {
      if (event.protocol !== 1) {
        this.readyWaiter?.reject(new Error(`SenseVoice 协议版本不兼容: ${event.protocol}`));
      } else {
        this.readyWaiter?.resolve();
      }
      return;
    }
    const session = this.active;
    if (!session || event.requestId !== session.requestId) return;
    if (event.type === "final") {
      this.active = null;
      session.chunks.length = 0;
      session.resolve(event.text);
      this.notifyIdle();
      this.armIdleTimer();
    } else if (event.type === "error") {
      this.failActive(new Error(`${event.code}: ${event.message}`));
    } else {
      this.failActive(new Error("SenseVoice 会话已取消"));
    }
  }

  private onProcessFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.loadedModelPath = null;
    this.readyWaiter?.reject(error);
    this.readyWaiter = null;
    if (this.intentionalStop || !this.active) return;
    if (this.active.retries >= 1) {
      this.failActive(error);
      return;
    }
    this.active.retries += 1;
    this.recovery = this.recoverActive().finally(() => {
      this.recovery = null;
    });
    void this.recovery.catch((recoveryError) => this.failActive(asError(recoveryError)));
  }

  private async recoverActive(): Promise<void> {
    const session = this.active;
    if (!session) return;
    await this.ensureProcess(session.modelPath);
    await this.writeControl(SenseVoiceFrameType.Begin, {
      requestId: session.requestId,
      language: session.language,
    });
    for (const chunk of session.chunks) await this.write(encodeAudioFrame(chunk));
    if (session.ended) await this.writeControl(SenseVoiceFrameType.End, { requestId: session.requestId });
  }

  private requireSession(requestId: string): ActiveSession {
    if (!this.active || this.active.requestId !== requestId) {
      throw new Error(`SenseVoice 会话不存在或已过期: ${requestId}`);
    }
    return this.active;
  }

  private failActive(error: Error): void {
    const session = this.active;
    if (!session) return;
    this.active = null;
    session.chunks.length = 0;
    session.reject(error);
    this.notifyIdle();
    this.armIdleTimer();
  }

  private waitUntilIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (this.active) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private async writeControl(
    type: Exclude<SenseVoiceFrameType, SenseVoiceFrameType.Audio>,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.write(encodeControlFrame(type, payload));
  }

  private async write(frame: Buffer): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("SenseVoice sidecar stdin 不可用");
    if (!stdin.write(frame)) await once(stdin, "drain");
  }

  private stopProcessOnly(): void {
    const child = this.child;
    if (!child) return;
    this.intentionalStop = true;
    this.child = null;
    this.loadedModelPath = null;
    try {
      child.stdin.end(encodeControlFrame(SenseVoiceFrameType.Shutdown));
    } catch {
      // 已断开的 pipe 无需重复处理。
    }
    child.kill();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.stopProcessOnly(), this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export const senseVoiceClient = new SenseVoiceClient();
