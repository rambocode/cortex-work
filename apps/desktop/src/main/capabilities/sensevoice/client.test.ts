import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { SenseVoiceClient, parseSidecarEvent } from "./client";
import { SenseVoiceFrameDecoder, SenseVoiceFrameType } from "./protocol";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function emitJson(child: FakeChild, event: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

describe("parseSidecarEvent", () => {
  it("解析 ready/final/error，拒绝未知或缺字段事件", () => {
    expect(parseSidecarEvent('{"type":"ready","protocol":1}')).toEqual({ type: "ready", protocol: 1 });
    expect(parseSidecarEvent('{"type":"final","requestId":"a","text":"你好"}')).toEqual({
      type: "final", requestId: "a", text: "你好",
    });
    expect(() => parseSidecarEvent('{"type":"future"}')).toThrow(/未知/);
    expect(() => parseSidecarEvent('{"type":"final","text":"x"}')).toThrow(/requestId/);
  });
});

describe("SenseVoiceClient", () => {
  it("常驻进程只启动一次，并按 BEGIN/AUDIO/END 完成整句", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as never);
    const client = new SenseVoiceClient({
      spawn,
      locate: () => ({ command: "/sidecar", cwd: "/", env: {} }),
      readyTimeoutMs: 100,
      idleTimeoutMs: 60_000,
    });
    const written: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));

    const started = client.startStream({ requestId: "req-1", modelPath: "/model.gguf", language: "zh" });
    emitJson(child, { type: "ready", protocol: 1 });
    await started;
    await client.appendAudio("req-1", Buffer.from([1, 0, 2, 0]));
    const final = client.finishStream("req-1");
    emitJson(child, { type: "final", requestId: "req-1", text: "你好" });
    await expect(final).resolves.toBe("你好");

    const frames = new SenseVoiceFrameDecoder().push(Buffer.concat(written));
    expect(frames.map((frame) => frame.type)).toEqual([
      SenseVoiceFrameType.Begin,
      SenseVoiceFrameType.Audio,
      SenseVoiceFrameType.End,
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    client.shutdown();
  });

  it("实时会话未结束时拒绝第二个会话", async () => {
    const child = new FakeChild();
    const client = new SenseVoiceClient({
      spawn: () => child as never,
      locate: () => ({ command: "/sidecar", cwd: "/", env: {} }),
      readyTimeoutMs: 100,
      idleTimeoutMs: 60_000,
    });
    const first = client.startStream({ requestId: "a", modelPath: "/model.gguf", language: "auto" });
    emitJson(child, { type: "ready", protocol: 1 });
    await first;
    await expect(client.startStream({ requestId: "b", modelPath: "/model.gguf", language: "auto" }))
      .rejects.toThrow(/已有.*会话/);
    client.shutdown();
  });

  it("sidecar 崩溃后重启并重放一次已缓存 PCM", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    const spawn = vi.fn(() => children.shift() as never);
    const client = new SenseVoiceClient({
      spawn,
      locate: () => ({ command: "/sidecar", cwd: "/", env: {} }),
      readyTimeoutMs: 100,
      idleTimeoutMs: 60_000,
    });
    const replayed: Buffer[] = [];
    second.stdin.on("data", (chunk: Buffer) => replayed.push(Buffer.from(chunk)));

    const started = client.startStream({ requestId: "req", modelPath: "/model.gguf", language: "zh" });
    emitJson(first, { type: "ready", protocol: 1 });
    await started;
    await client.appendAudio("req", Buffer.from([7, 0, 8, 0]));
    first.emit("exit", 9, null);
    await Promise.resolve();
    emitJson(second, { type: "ready", protocol: 1 });
    await client.waitForRecovery();

    const frames = new SenseVoiceFrameDecoder().push(Buffer.concat(replayed));
    expect(frames.map((frame) => frame.type)).toEqual([
      SenseVoiceFrameType.Begin,
      SenseVoiceFrameType.Audio,
    ]);
    expect(frames[1]?.payload).toEqual(Buffer.from([7, 0, 8, 0]));
    client.shutdown();
  });

  it("整段 PCM 串行执行且队列最多容纳两条", async () => {
    const child = new FakeChild();
    const client = new SenseVoiceClient({
      spawn: () => child as never,
      locate: () => ({ command: "/sidecar", cwd: "/", env: {} }),
      readyTimeoutMs: 100,
      idleTimeoutMs: 60_000,
    });
    const frames: Array<{ type: SenseVoiceFrameType; payload: Buffer }> = [];
    const decoder = new SenseVoiceFrameDecoder();
    child.stdin.on("data", (chunk: Buffer) => frames.push(...decoder.push(Buffer.from(chunk))));

    const first = client.transcribePcm({ modelPath: "/model.gguf", language: "zh", pcm16le: Buffer.from([1, 0]) });
    const second = client.transcribePcm({ modelPath: "/model.gguf", language: "zh", pcm16le: Buffer.from([2, 0]) });
    await expect(client.transcribePcm({ modelPath: "/model.gguf", language: "zh", pcm16le: Buffer.alloc(2) }))
      .rejects.toThrow(/队列已满/);
    await Promise.resolve();
    emitJson(child, { type: "ready", protocol: 1 });
    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === SenseVoiceFrameType.End)).toHaveLength(1));
    const firstBegin = frames.find((frame) => frame.type === SenseVoiceFrameType.Begin)!;
    const firstId = JSON.parse(firstBegin.payload.toString("utf8")).requestId;
    emitJson(child, { type: "final", requestId: firstId, text: "一" });
    await expect(first).resolves.toBe("一");

    await vi.waitFor(() => expect(frames.filter((frame) => frame.type === SenseVoiceFrameType.End)).toHaveLength(2));
    const begins = frames.filter((frame) => frame.type === SenseVoiceFrameType.Begin);
    const secondId = JSON.parse(begins[1]!.payload.toString("utf8")).requestId;
    emitJson(child, { type: "final", requestId: secondId, text: "二" });
    await expect(second).resolves.toBe("二");
    client.shutdown();
  });
});
