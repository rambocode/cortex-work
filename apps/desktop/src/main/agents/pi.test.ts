// pi adapter 单测：参数构造 + --mode json 行解析（事件形状取自
// @earendil-works/pi-coding-agent 0.79.2 实测输出,已按 0.82.1 .d.ts 复核:基础 AgentEvent 九类
// 未变,新增帧见 ignoredFrameTypes 用例）。
// pi-locate 依赖 electron app,这里 mock 成固定路径避免引入运行时依赖。

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("./pi-locate", () => ({
  resolvePiBinary: () => "/fake/resources/pi/pi",
}));
// pi.ts 经 ./pi-providers 引入 safeId,后者顶层 import electron app —— mock 掉避免加载真 electron。
vi.mock("electron", () => ({ app: {} }));

import { buildPiImageArgs, piDef, PiImageArgError, validatePiImages } from "./pi";
import type { CliStartRequest } from "../ipc/types";

const BIN = "/fake/resources/pi/pi";

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

const baseReq: CliStartRequest = {
  runId: "r1",
  sessionId: "s1",
  agent: "pi",
  cwd: "/tmp/proj",
  prompt: "hello",
};

describe("piDef.buildArgs", () => {
  it("首轮:二进制 cmd + --mode json + -p + --no-extensions + --no-skills,prompt 在末位", () => {
    const { cmd, args } = piDef.buildArgs(baseReq);
    expect(cmd).toBe(BIN);
    expect(args[0]).toBe("--mode");
    expect(args.join(" ")).toContain("--mode json");
    expect(args).toContain("-p");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args.at(-1)).toBe("hello");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--session");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("插件 Skill:--no-skills 随 useOwnSkills gate（=true 时省略,放开 pi 原生发现,与 claude adapter 对齐）", () => {
    // 缺省 / false → 关掉 pi 原生发现(与 claude 缺省加 --disable-slash-commands 同语义)。
    expect(piDef.buildArgs(baseReq).args).toContain("--no-skills");
    expect(piDef.buildArgs({ ...baseReq, useOwnSkills: false }).args).toContain("--no-skills");
    // true → 不加 --no-skills,pi 走自身原生 skill 发现(~/.pi/agent/skills、~/.agents/skills、
    // 项目 .pi/skills / .agents/skills),与 claude/codex「各用自家原生目录」一致。
    expect(piDef.buildArgs({ ...baseReq, useOwnSkills: true }).args).not.toContain("--no-skills");
  });

  it("插件 Skill:skillPaths 逐个 --skill 注入；缺省仅 --no-skills", () => {
    expect(piDef.buildArgs(baseReq).args).not.toContain("--skill");
    const { args } = piDef.buildArgs({ ...baseReq, skillPaths: ["/a/code-review", "/b/bug-hunt"] });
    expect(args).toContain("--no-skills");
    const joined = args.join(" ");
    expect(joined).toContain("--skill /a/code-review");
    expect(joined).toContain("--skill /b/bug-hunt");
  });

  it("插件 Skill:useOwnSkills=true 时原生发现 + --skill 注入并存（混合,与 claude 桥接同款）", () => {
    const { args } = piDef.buildArgs({ ...baseReq, useOwnSkills: true, skillPaths: ["/a/code-review"] });
    expect(args).not.toContain("--no-skills"); // 原生发现放开
    expect(args.join(" ")).toContain("--skill /a/code-review"); // Cortex 已启用集合仍附加注入
  });

  it("运行模式 plan:json 单发注入 --tools 只读白名单,prompt 仍末位;非 plan 不注入", () => {
    expect(piDef.buildArgs(baseReq).args).not.toContain("--tools"); // 缺省
    expect(piDef.buildArgs({ ...baseReq, permissionMode: "accept-edits" }).args).not.toContain("--tools");
    expect(piDef.buildArgs({ ...baseReq, permissionMode: "full-auto" }).args).not.toContain("--tools");
    const { args } = piDef.buildArgs({ ...baseReq, permissionMode: "plan" });
    expect(args.join(" ")).toContain("--tools read,grep,find,ls");
    expect(args.at(-1)).toBe("hello");
  });

  it("运行模式 plan + 委派:--tools 只读白名单保留 ask_<role> 工具", () => {
    const { args } = piDef.buildArgs({
      ...baseReq,
      permissionMode: "plan",
      delegateRoles: [
        { id: "Codex", label: "Codex", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" },
        { id: "Code Reviewer", label: "Code Reviewer", agent: "codex", systemPrompt: "", createdAt: "", updatedAt: "" },
      ],
    });
    const toolArg = args[args.indexOf("--tools") + 1];
    expect(toolArg).toContain("read,grep,find,ls");
    expect(toolArg).toContain("browser_navigate");
    expect(toolArg).toContain("ask_codex");
    expect(toolArg).toContain("ask_code-reviewer");
  });

  it("多轮:model / resumeSessionId / appendSystemPrompt 各自透传,prompt 仍在末位", () => {
    const { args } = piDef.buildArgs({
      ...baseReq,
      model: "openai/gpt-5.5",
      resumeSessionId: "019ebe91-aaaa-7775-b82f-9810d333859a",
      appendSystemPrompt: "Use concise Chinese.",
    });
    expect(args.join(" ")).toContain("--model openai/gpt-5.5");
    expect(args.join(" ")).toContain("--session 019ebe91-aaaa-7775-b82f-9810d333859a");
    expect(args.join(" ")).toContain("--append-system-prompt Use concise Chinese.");
    expect(args.at(-1)).toBe("hello");
  });

  it("自定义供应商:piExtensionPath → -e/-a,provider.id → --provider", () => {
    const { args } = piDef.buildArgs({
      ...baseReq,
      model: "deepseek-chat",
      piExtensionPath: "/data/pi-providers/deepseek.js",
      provider: { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", models: [{ id: "deepseek-chat" }] },
    });
    expect(args.join(" ")).toContain("-e /data/pi-providers/deepseek.js");
    expect(args).toContain("-a");
    expect(args.join(" ")).toContain("--provider deepseek");
    expect(args.join(" ")).toContain("--model deepseek-chat");
    expect(args.at(-1)).toBe("hello");
  });

  it("无 piExtensionPath:不加 -e/-a/--provider（pi 用自身默认 provider）", () => {
    const { args } = piDef.buildArgs(baseReq);
    expect(args).not.toContain("-e");
    expect(args).not.toContain("-a");
    expect(args).not.toContain("--provider");
  });

  it("推理强度:pi 无对应 flag,effort 被忽略", () => {
    const { args } = piDef.buildArgs({ ...baseReq, effort: "high" });
    expect(args.join(" ")).not.toContain("effort");
    expect(args.join(" ")).not.toContain("reasoning");
  });
});

describe("piDef.buildArgs 图片投递（pi 原生 @<path> 文件参数）", () => {
  it("能力位声明为 arg-at-path(不再是 none)", () => {
    expect(piDef.imageDelivery).toBe("arg-at-path");
  });

  it("无图片:参数与此前完全一致,不出现任何 @ 参数", () => {
    const { args } = piDef.buildArgs(baseReq);
    expect(args.some((a) => a.startsWith("@"))).toBe(false);
    expect(args.at(-1)).toBe("hello");
  });

  it("单图:追加一个 @<path>,且排在 prompt 之前", () => {
    const png = writePng("one.png");
    const { args } = piDef.buildArgs({ ...baseReq, images: [{ path: png, mimeType: "image/png" }] });
    expect(args.at(-2)).toBe(`@${png}`);
    expect(args.at(-1)).toBe("hello");
  });

  it("多图:数量与顺序逐一对应", () => {
    const a = writePng("a.png");
    const b = writeBytes("b.gif", [...Buffer.from("GIF89a"), 0, 0]);
    const c = writeBytes("c.jpg", [0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const { args } = piDef.buildArgs({
      ...baseReq,
      images: [
        { path: a, mimeType: "image/png" },
        { path: b, mimeType: "image/gif" },
        { path: c, mimeType: "image/jpeg" },
      ],
    });
    expect(args.filter((x) => x.startsWith("@"))).toEqual([`@${a}`, `@${b}`, `@${c}`]);
  });

  it("WebP 与 image/jpg 别名都能通过（别名归一后与魔数一致）", () => {
    const webp = writeBytes("d.webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
    const jpg = writeBytes("e.jpg", [0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const { args } = piDef.buildArgs({
      ...baseReq,
      images: [
        { path: webp, mimeType: "image/webp" },
        { path: jpg, mimeType: "image/jpg" },
      ],
    });
    expect(args.filter((x) => x.startsWith("@"))).toEqual([`@${webp}`, `@${jpg}`]);
  });

  it("@<path> 不会紧跟在值型 flag 之后（pi 的 --append-system-prompt 会无条件吃掉下一个 arg）", () => {
    const png = writePng("after-flag.png");
    const { args } = piDef.buildArgs({
      ...baseReq,
      appendSystemPrompt: "S",
      images: [{ path: png, mimeType: "image/png" }],
    });
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("S");
    expect(args.at(-2)).toBe(`@${png}`);
  });

  it("路径含空格/特殊字符:原样带 @ 前缀（spawn 传数组不过 shell,无需转义）", () => {
    const png = writePng("with space & 中文.png");
    const { args } = piDef.buildArgs({ ...baseReq, images: [{ path: png, mimeType: "image/png" }] });
    expect(args.at(-2)).toBe(`@${png}`);
  });

  it("路径不存在 → 结构化错误,不静默丢图", () => {
    expect(() =>
      piDef.buildArgs({ ...baseReq, images: [{ path: join(imgDir, "nope.png"), mimeType: "image/png" }] }),
    ).toThrow(PiImageArgError);
  });

  it("空文件 → 报错（pi 侧会静默跳过空文件,那正是要避免的静默丢图）", () => {
    const empty = writeBytes("empty.png", []);
    try {
      piDef.buildArgs({ ...baseReq, images: [{ path: empty, mimeType: "image/png" }] });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as PiImageArgError).code).toBe("empty");
    }
  });

  it("内容不是受支持的图片 → unsupported（否则 pi 会当文本文件读进 prompt）", () => {
    const bad = writeBytes("bad.png", [...Buffer.from("not an image at all")]);
    try {
      piDef.buildArgs({ ...baseReq, images: [{ path: bad, mimeType: "image/png" }] });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as PiImageArgError).code).toBe("unsupported");
    }
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
    try {
      piDef.buildArgs({ ...baseReq, images: [{ path: apng, mimeType: "image/png" }] });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as PiImageArgError).code).toBe("unsupported");
    }
  });

  it("声明 MIME 与实际内容不符 → mime-mismatch", () => {
    const png = writePng("mismatch.png");
    try {
      piDef.buildArgs({ ...baseReq, images: [{ path: png, mimeType: "image/webp" }] });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as PiImageArgError).code).toBe("mime-mismatch");
    }
  });

  it("以 @ 开头的 prompt 被加前导空格,避免被 pi 当成文件参数吞掉（实测会 exit 1 且无任何输出）", () => {
    expect(piDef.buildArgs({ ...baseReq, prompt: "@张三 帮我看看" }).args.at(-1)).toBe(" @张三 帮我看看");
    // 非 @ 开头一律原样,不引入任何多余空白。
    expect(piDef.buildArgs({ ...baseReq, prompt: "看看 @张三 的意见" }).args.at(-1)).toBe("看看 @张三 的意见");
  });

  it("超过 6 张 → too-many,整体拒绝", () => {
    const images = Array.from({ length: 7 }, (_, i) => ({
      path: writePng(`many-${i}.png`),
      mimeType: "image/png",
    }));
    try {
      piDef.buildArgs({ ...baseReq, images });
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as PiImageArgError).code).toBe("too-many");
    }
  });
});

// 两条投递通道（二进制 `@<path>` 与 in-process 的 SDK `images` 入参）共用同一套校验,
// 故校验器单独有一组断言:它返回的是**魔数嗅探出的真实 MIME**,不是调用方声明的那个。
describe("validatePiImages（两条投递通道共用的校验器,U5）", () => {
  it("返回真实 MIME 而非声明值（image/jpg 别名归一为 image/jpeg）", () => {
    const jpg = writeBytes("v-alias.jpg", [0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(validatePiImages([{ path: jpg, mimeType: "image/jpg" }])).toEqual([
      { path: jpg, mimeType: "image/jpeg" },
    ]);
  });

  it("与 buildPiImageArgs 同源:后者只是把前者的 path 拼成 @<path>", () => {
    const png = writePng("v-same.png");
    const images = [{ path: png, mimeType: "image/png" }];
    expect(buildPiImageArgs(images)).toEqual(validatePiImages(images).map((i) => `@${i.path}`));
  });

  it("坏图的错误码与 buildPiImageArgs 逐字相同（切开关不改变用户看到的提示）", () => {
    const bad = writeBytes("v-bad.png", [1, 2, 3, 4]);
    const images = [{ path: bad, mimeType: "image/png" }];
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
        return undefined;
      } catch (e) {
        return (e as PiImageArgError).code;
      }
    };
    expect(codeOf(() => validatePiImages(images))).toBe("unsupported");
    expect(codeOf(() => buildPiImageArgs(images))).toBe("unsupported");
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
