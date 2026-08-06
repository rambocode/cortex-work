// pi adapter 单测：--mode json 行解析 + 图片校验（事件形状取自
// @earendil-works/pi-coding-agent 0.79.2 实测输出,已按 0.82.1 .d.ts 复核:基础 AgentEvent 九类
// 未变,新增帧见 ignoredFrameTypes 用例）。
// 引擎收敛后 buildArgs 是抛错 stub(pi 永不 spawn),参数构造用例随 binary 路径删除;
// validatePiImages 是 in-process 单发唯一的图片校验入口,坏图断言全部保留。

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";

import { piDef, PiImageArgError, validatePiImages } from "./pi";

// 图片校验读真实文件（pi 侧同样按魔数嗅探）,故用真临时文件而非 mock fs —— mock 掉魔数检测
// 等于把这条链路上唯一有价值的断言删掉。
const imgDir = mkdtempSync(join(tmpdir(), "cortex-pi-img-"));
afterAll(() => rmSync(imgDir, { recursive: true, force: true }));

// 最小合法 PNG:8 字节签名 + 长度 13 的 IHDR 块（pi utils/mime.js 的 isPng 判据）。
function writePng(name: string): string {
  const path = join(imgDir, name);
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  writeFileSync(path, buf);
  return path;
}

function writeBytes(name: string, bytes: number[] | Buffer): string {
  const path = join(imgDir, name);
  writeFileSync(path, Buffer.from(bytes as number[]));
  return path;
}

describe("piDef.buildArgs（抛错 stub）", () => {
  it("任何调用都响亮抛错——pi 已无外部二进制,走到这里即接线错误", () => {
    expect(() => piDef.buildArgs({ runId: "r1", sessionId: "s1", agent: "pi", cwd: "/tmp", prompt: "x" })).toThrow(
      /不存在外部二进制/,
    );
  });

  it("能力位保持:mcpInjection=none / imageDelivery=arg-at-path 等注册表形状不变", () => {
    expect(piDef.id).toBe("pi");
    expect(piDef.mcpInjection).toBe("none");
    expect(piDef.imageDelivery).toBe("arg-at-path");
  });
});

describe("validatePiImages（in-process 单发的图片校验入口）", () => {
  it("单图:校验通过并返回魔数嗅探出的真实 MIME", () => {
    const png = writePng("one.png");
    expect(validatePiImages([{ path: png, mimeType: "image/png" }])).toEqual([
      { path: png, mimeType: "image/png" },
    ]);
  });

  it("多图:数量与顺序逐一对应", () => {
    const a = writePng("a.png");
    const b = writeBytes("b.gif", [...Buffer.from("GIF89a"), 0, 0]);
    const c = writeBytes("c.jpg", [0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(
      validatePiImages([
        { path: a, mimeType: "image/png" },
        { path: b, mimeType: "image/gif" },
        { path: c, mimeType: "image/jpeg" },
      ]).map((i) => i.path),
    ).toEqual([a, b, c]);
  });

  it("WebP 与 image/jpg 别名都能通过（别名归一后与魔数一致,image/jpg → image/jpeg）", () => {
    const webp = writeBytes("d.webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
    const jpg = writeBytes("e.jpg", [0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(
      validatePiImages([
        { path: webp, mimeType: "image/webp" },
        { path: jpg, mimeType: "image/jpg" },
      ]),
    ).toEqual([
      { path: webp, mimeType: "image/webp" },
      { path: jpg, mimeType: "image/jpeg" },
    ]);
  });

  it("路径不存在 → 结构化错误,不静默丢图", () => {
    expect(() =>
      validatePiImages([{ path: join(imgDir, "nope.png"), mimeType: "image/png" }]),
    ).toThrow(PiImageArgError);
  });

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return (e as PiImageArgError).code;
    }
  };

  it("空文件 → empty（pi 侧会静默跳过空文件,那正是要避免的静默丢图）", () => {
    const empty = writeBytes("empty.png", []);
    expect(codeOf(() => validatePiImages([{ path: empty, mimeType: "image/png" }]))).toBe("empty");
  });

  it("内容不是受支持的图片 → unsupported（否则 pi 会当文本读进 prompt）", () => {
    const bad = writeBytes("bad.png", [...Buffer.from("not an image at all")]);
    expect(codeOf(() => validatePiImages([{ path: bad, mimeType: "image/png" }]))).toBe("unsupported");
  });

  it("动图 PNG(APNG) → unsupported（pi 判定其非图片,会退化成文本读取）", () => {
    const buf = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12, "ascii");
    // IHDR 块之后紧跟 acTL(动图控制块) → APNG。
    buf.writeUInt32BE(8, 8 + 8 + 13 + 4);
    buf.write("acTL", 8 + 8 + 13 + 4 + 4, "ascii");
    const apng = writeBytes("anim.png", buf);
    expect(codeOf(() => validatePiImages([{ path: apng, mimeType: "image/png" }]))).toBe("unsupported");
  });

  it("声明 MIME 与实际内容不符 → mime-mismatch", () => {
    const png = writePng("mismatch.png");
    expect(codeOf(() => validatePiImages([{ path: png, mimeType: "image/webp" }]))).toBe("mime-mismatch");
  });

  it("超过 6 张 → too-many,整体拒绝", () => {
    const images = Array.from({ length: 7 }, (_, i) => ({
      path: writePng(`many-${i}.png`),
      mimeType: "image/png",
    }));
    expect(codeOf(() => validatePiImages(images))).toBe("too-many");
  });
});

describe("piDef.parseLine", () => {
  it("session → init 事件(捕获 id)", () => {
    const line = JSON.stringify({
      type: "session",
      version: 3,
      id: "019ebe91-aaaa-7775-b82f-9810d333859a",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/private/tmp/x",
    });
    expect(piDef.parseLine(line)).toEqual({
      type: "init",
      sessionId: "019ebe91-aaaa-7775-b82f-9810d333859a",
    });
  });

  it("message_update text_delta → text 增量", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} },
      message: {},
    });
    expect(piDef.parseLine(line)).toEqual({ type: "text", delta: "Hello" });
  });

  it("message_update thinking_delta → thinking 增量(reasoning 模型,与 claude adapter 对齐)", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "The user", partial: {} },
      message: {},
    });
    expect(piDef.parseLine(line)).toEqual({ type: "thinking", delta: "The user" });
  });

  it("tool_execution_start → tool 事件(detail 取 command)", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    expect(piDef.parseLine(line)).toEqual({
      type: "tool",
      name: "bash",
      detail: "ls -la",
      input: { command: "ls -la" },
      phase: "start",
      toolCallId: "call_1",
    });
  });

  it("tool_execution_end → 可配对的 tool end 事件,透传失败与输出", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "set_deck_doc",
      result: {
        content: [{ type: "text", text: 'Validation failed: doc must be object' }],
      },
      isError: true,
    });
    expect(piDef.parseLine(line)).toEqual({
      type: "tool",
      name: "set_deck_doc",
      output: "Validation failed: doc must be object",
      isError: true,
      phase: "end",
      toolCallId: "call_1",
    });
  });

  it("tool_execution_start todo_write → todo 整表快照事件(不产 tool);空清单丢弃", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_t",
      toolName: "todo_write",
      args: { todos: [{ text: "拆分模块", status: "in_progress" }, { text: "补测试", status: "pending" }] },
    });
    expect(piDef.parseLine(line)).toEqual({
      type: "todo",
      todos: [
        { text: "拆分模块", status: "in_progress" },
        { text: "补测试", status: "pending" },
      ],
    });
    const empty = JSON.stringify({ type: "tool_execution_start", toolCallId: "call_e", toolName: "todo_write", args: { todos: [] } });
    expect(piDef.parseLine(empty)).toBeNull();
  });

  it("message_end stopReason=stop → ok result 带拼接文本", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "PING" }],
        stopReason: "stop",
        usage: { input: 8, output: 2, cacheRead: 5 },
      },
    });
    expect(piDef.parseLine(line)).toEqual([
      { type: "usage", inputTokens: 8, outputTokens: 2 },
      { type: "result", ok: true, text: "PING" },
    ]);
  });

  it("message_end stopReason=error → ok=false 带 diagnostics 错误", () => {
    // 陷阱样例：provider 失败时进程仍 exit 0,错误只在这条事件里。
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "provider failed",
        diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket error" } }],
      },
    });
    expect(piDef.parseLine(line)).toEqual({ type: "result", ok: false, error: "provider failed" });
  });

  it("message_end stopReason=error 无 errorMessage → 回退到 diagnostics", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket error" } }],
      },
    });
    expect(piDef.parseLine(line)).toEqual({ type: "result", ok: false, error: "WebSocket error" });
  });

  it("message_end stopReason=aborted → ok=false(无错误信息时回退 stopReason 文本)", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });
    expect(piDef.parseLine(line)).toEqual({ type: "result", ok: false, error: "aborted" });
  });

  it("message_end stopReason=toolUse → 只产 usage(中间轮不发 result)", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "toolUse",
        usage: { input: 21, output: 6, cacheRead: 11 },
      },
    });
    expect(piDef.parseLine(line)).toEqual({ type: "usage", inputTokens: 21, outputTokens: 6 });
  });

  it("agent_end / 其它事件 → null", () => {
    expect(piDef.parseLine(JSON.stringify({ type: "agent_end" }))).toBeNull();
    expect(piDef.parseLine(JSON.stringify({ type: "turn_start" }))).toBeNull();
    expect(piDef.parseLine(JSON.stringify({ type: "message_start" }))).toBeNull();
  });

  it("已知故意忽略的帧 type 都声明进 ignoredFrameTypes(不算 parseLineEvents 盲区)", () => {
    for (const t of ["agent_start", "turn_start", "turn_end", "agent_end", "message_start"]) {
      expect(piDef.ignoredFrameTypes?.has(t)).toBe(true);
    }
  });

  it("非 JSON / 形状不符 → null 且不抛", () => {
    expect(piDef.parseLine("not json")).toBeNull();
    expect(piDef.parseLine(JSON.stringify({ type: "session" }))).toBeNull();
  });
});

describe("piDef.isIgnoredFrame(细粒度已知忽略,防止盲区补点刷屏)", () => {
  // reasoning 模型(deepseek 等)每个 token 都发 thinking/text 生命周期子帧,若不声明为
  // 已知忽略,dev 启动时 parse 日志会被「未映射的 pi 输出帧」刷屏(实测复现)。
  it("message_update 的生命周期/toolcall 子帧 → 已知忽略", () => {
    for (const sub of ["text_start", "text_end", "thinking_start", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"]) {
      expect(piDef.isIgnoredFrame?.({ type: "message_update", assistantMessageEvent: { type: sub } })).toBe(true);
    }
  });

  it("message_update 未知子帧 → 不忽略(保留协议漂移告警)", () => {
    expect(piDef.isIgnoredFrame?.({ type: "message_update", assistantMessageEvent: { type: "brand_new_sub" } })).toBe(false);
    expect(piDef.isIgnoredFrame?.({ type: "message_update" })).toBe(false);
  });

  it("message_end:user 回显 / assistant toolUse 中间轮 → 已知忽略", () => {
    expect(piDef.isIgnoredFrame?.({ type: "message_end", message: { role: "user", content: [] } })).toBe(true);
    expect(piDef.isIgnoredFrame?.({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } })).toBe(true);
  });

  it("message_end:assistant 未知 stopReason → 不忽略(终态卡死类漂移必须可观测)", () => {
    expect(piDef.isIgnoredFrame?.({ type: "message_end", message: { role: "assistant", stopReason: "mystery" } })).toBe(false);
  });

  it("其它顶层 type → 不忽略(交由 ignoredFrameTypes 集合判定)", () => {
    expect(piDef.isIgnoredFrame?.({ type: "agent_end" })).toBe(false);
  });

  // pi 0.82.1 新增帧。单发路径不消费它们,但必须在 ignoredFrameTypes 里——否则每轮都会打
  // 「未映射的 pi 输出帧」,把真正的协议漂移信号淹没掉（本次升级 diff 的直接产物）。
  it("0.82.1 新增帧 → 已在 ignoredFrameTypes(不污染盲区补点)", () => {
    for (const type of [
      "agent_settled",
      "entry_appended",
      "bash_execution_update",
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
    ]) {
      expect(piDef.ignoredFrameTypes?.has(type)).toBe(true);
    }
  });

  it("未来版本的新帧仍会告警(忽略清单不是通配)", () => {
    expect(piDef.ignoredFrameTypes?.has("some_future_event")).toBe(false);
  });
});
