// pi 单发 in-process 引擎单测（迁移计划 U5）。用 pi 模块替身（不加载真 ESM 包）覆盖五类：
//   1. **契约不变**——垫层吐出的 stdout 行经 `piDef.parseLine` 解析后，与二进制路径产出
//      同一串 `CliStreamEvent`；尤其是那条 ⚠️ 陷阱：provider 失败仍 exit 0，result 只来自
//      最后一条 assistant `message_end`（KTD5）。这是本阶段唯一真正要守住的东西。
//   2. `buildArgs` 每个 flag 的 in-process 对应物是否真的被下发；
//   3. **安全**——单发绝不接审批 UI（bindExtensions 不传 uiContext）、绝不注入 Computer Use、
//      扩展路径只放行主进程自写的目录；
//   4. **异常边界**——加载失败走 onError（等价 spawn 失败）、运行中失败走 stderr + 非零码、
//      取消走 code=null；任何一条都不得变成主进程未捕获异常；
//   5. 开关关闭时**不选路**（返回 null），保证行为与迁移前逐字节一致。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => false }));
vi.mock("../pi-locate", () => ({ resolvePiBinary: () => "/fake/pi" }));
vi.mock("electron", () => ({ app: { getPath: () => "/fake/userData" } }));

const providerMocks = vi.hoisted(() => ({
  runtime: { kind: "model-runtime" },
  resolve: vi.fn(),
}));
vi.mock("../../providers/pi-inproc-models", () => ({
  getPiInprocModelRuntime: async () => providerMocks.runtime,
  resolvePiInprocModel: providerMocks.resolve,
}));

import { filterOneShotExtensionPaths, maybeStartPiInProcOneShot } from "./oneshot";
import { __resetPiFeatureFlagForTests, __setPiInProcEnabledForTests } from "./feature-flag";
import { __resetPiRuntimeCacheForTests, __setPiRuntimeImporterForTests } from "./runtime";
import { piDef } from "../pi";
import { parseLineEvents } from "../index";
import type { AgentProcess } from "../../ipc/cli";
import type { CliStartRequest, CliStreamEvent } from "../../ipc/types";

const EXT_ROOT = "/fake/userData/pi-extensions";

// ── pi 模块替身 ──────────────────────────────────────────────────────────────────────

/** 一次 prompt 期间要发出的事件序列（模拟 pi 的 agent loop）。 */
type PromptScript = (emit: (event: unknown) => void) => Promise<void> | void;

function makeMod(script: PromptScript) {
  const calls = {
    services: [] as Array<Record<string, unknown>>,
    session: [] as Array<Record<string, unknown>>,
    bind: [] as Array<Record<string, unknown>>,
    prompts: [] as Array<{ text: string; options?: { images?: unknown[] } }>,
    sessionManager: [] as Array<{ fn: string; args: unknown[] }>,
    aborts: 0,
    disposed: 0,
  };
  const listeners = new Set<(e: unknown) => void>();
  const emit = (event: unknown): void => listeners.forEach((l) => l(event));

  const session = {
    sessionId: "sess-1",
    subscribe(listener: (e: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async bindExtensions(bindings: Record<string, unknown>) {
      calls.bind.push(bindings);
    },
    async prompt(text: string, options?: { images?: unknown[] }) {
      calls.prompts.push({ text, options });
      await script(emit);
    },
    async abort() {
      calls.aborts++;
    },
    async waitForIdle() {},
    async reload() {},
    async navigateTree() {
      return { cancelled: false };
    },
  };

  const sessionManager = {
    getCwd: () => "/proj",
    getHeader: () => ({ type: "session", id: "sess-1", timestamp: "t", cwd: "/proj" }),
  };

  const mod = {
    getAgentDir: () => "/fake/.pi/agent",
    SessionManager: {
      create: (...args: unknown[]) => {
        calls.sessionManager.push({ fn: "create", args });
        return sessionManager;
      },
      list: async (...args: unknown[]) => {
        calls.sessionManager.push({ fn: "list", args });
        return [{ id: "existing-session-id", path: "/sessions/existing.jsonl" }];
      },
      open: (...args: unknown[]) => {
        calls.sessionManager.push({ fn: "open", args });
        return sessionManager;
      },
    },
    createAgentSessionServices: async (opts: Record<string, unknown>) => {
      calls.services.push(opts);
      return { cwd: opts.cwd, agentDir: opts.agentDir, diagnostics: [] };
    },
    createAgentSessionFromServices: async (opts: Record<string, unknown>) => {
      calls.session.push(opts);
      return { session, extensionsResult: {} };
    },
    createAgentSessionRuntime: async (
      factory: (o: Record<string, unknown>) => Promise<{ session: unknown }>,
      opts: Record<string, unknown>,
    ) => {
      const built = await factory({
        cwd: opts.cwd,
        agentDir: opts.agentDir,
        sessionManager: opts.sessionManager,
      });
      return {
        session: built.session,
        diagnostics: [],
        dispose: async () => {
          calls.disposed++;
        },
        newSession: async () => ({ cancelled: false }),
        fork: async () => ({ cancelled: false }),
        switchSession: async () => ({ cancelled: false }),
      };
    },
    resolveCliModel: ({ cliModel }: { cliModel?: string }) =>
      cliModel === "unknown-model"
        ? { model: undefined, warning: undefined, error: "no match" }
        : { model: { provider: "deepseek", id: cliModel }, warning: undefined, error: undefined },
  };

  return { mod, calls, emit };
}

/**
 * 装上模块替身（经 runtime.ts 的 importer 注入点，走的仍是真实 `loadPiCodingAgent` 路径）。
 * 必须先清缓存：`loadPiCodingAgent` 缓存的是 Promise，不清的话同一用例里换替身不生效。
 */
function installMod(script: PromptScript) {
  __resetPiRuntimeCacheForTests();
  const fake = makeMod(script);
  __setPiRuntimeImporterForTests(async () => fake.mod);
  return fake;
}

// ── 驱动 ─────────────────────────────────────────────────────────────────────────────

const baseReq: CliStartRequest = {
  runId: "r1",
  sessionId: "s1",
  agent: "pi",
  cwd: "/proj",
  prompt: "你好",
};

interface RunResult {
  /** 垫层 stdout 的逐行内容（与 `pi --mode json` 同形的 JSONL）。 */
  lines: string[];
  /** 每行经 `piDef.parseLine` 解析出的归一化事件，铺平后即渲染端会看到的序列。 */
  events: CliStreamEvent[];
  code: number | null;
  error?: Error;
  stderr: string;
  /** exit 触发时已收到的行数——用来断言「stdout 读完才 exit」。 */
  linesAtExit: number;
}

/** 起一次单发并跑到终态。`onStarted` 可在运行途中操作句柄（如 kill）。 */
function run(req: CliStartRequest, onStarted?: (proc: AgentProcess) => void): Promise<RunResult> {
  const proc = maybeStartPiInProcOneShot("pi", req, { cwd: req.cwd });
  if (!proc) throw new Error("选路失败：期望走 in-process");
  return new Promise<RunResult>((resolve) => {
    const lines: string[] = [];
    let buffer = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) lines.push(line);
      }
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const finish = (code: number | null, error?: Error): void => {
      resolve({
        lines,
        events: lines.flatMap((l) => parseLineEvents(piDef, l)),
        code,
        error,
        stderr,
        linesAtExit: lines.length,
      });
    };
    proc.onError((err) => finish(null, err));
    proc.onExit((code) => finish(code));
    onStarted?.(proc);
  });
}

// pi 的真实事件形状（取自 pi.ts 文件头的协议说明，与 --mode json 逐字段同源）。
const TEXT_DELTA = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "答" } };
const TOOL_START = { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/a.ts" } };
const TOOL_END = { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "内容", isError: false };
const MESSAGE_END_OK = {
  type: "message_end",
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "答" }], usage: { input: 5, output: 3 } },
};
const MESSAGE_END_ERROR = {
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage: "provider 挂了" },
};

beforeEach(() => {
  logMocks.logger.warn.mockClear();
  logMocks.logger.error.mockClear();
  providerMocks.resolve.mockReset();
  providerMocks.resolve.mockImplementation(async ({ providerId, modelId }: { providerId: string; modelId?: string }) => ({
    modelRuntime: providerMocks.runtime,
    model: { provider: providerId, id: modelId ?? "default" },
  }));
  __setPiInProcEnabledForTests(true);
});

afterEach(() => {
  __resetPiFeatureFlagForTests();
  __resetPiRuntimeCacheForTests();
});

// ── 1. 选路 ─────────────────────────────────────────────────────────────────────────

describe("选路", () => {
  it("开关关闭时返回 null（行为与迁移前逐字节一致）", () => {
    __setPiInProcEnabledForTests(false);
    expect(maybeStartPiInProcOneShot("pi", baseReq, { cwd: "/proj" })).toBeNull();
  });

  it("非 pi 的 agent 一律不选路", () => {
    expect(maybeStartPiInProcOneShot("claude", baseReq, { cwd: "/proj" })).toBeNull();
    expect(maybeStartPiInProcOneShot("codex", baseReq, { cwd: "/proj" })).toBeNull();
  });
});

// ── 2. CliStreamEvent 契约 ──────────────────────────────────────────────────────────

describe("CliStreamEvent 契约", () => {
  it("stdout 行经 piDef.parseLine 解析出与二进制路径同一串事件", async () => {
    installMod((emit) => {
      emit(TEXT_DELTA);
      emit(TOOL_START);
      emit(TOOL_END);
      emit(MESSAGE_END_OK);
    });
    const r = await run(baseReq);

    // 第一行必须是 session header → init（渲染端靠它记住可续接的会话 id）。
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ type: "session", id: "sess-1" });
    expect(r.events).toEqual([
      { type: "init", sessionId: "sess-1" },
      { type: "text", delta: "答" },
      { type: "tool", name: "read", detail: "/a.ts", input: { path: "/a.ts" }, phase: "start", toolCallId: "t1" },
      { type: "tool", name: "read", output: "内容", isError: false, phase: "end", toolCallId: "t1" },
      { type: "usage", inputTokens: 5, outputTokens: 3 },
      { type: "result", ok: true, text: "答" },
    ]);
    expect(r.code).toBe(0);
  });

  it("exit 只在 stdout 全部读完之后才触发（否则收尾清理会吞掉最后几个事件）", async () => {
    installMod((emit) => {
      emit(TEXT_DELTA);
      emit(MESSAGE_END_OK);
    });
    const r = await run(baseReq);
    expect(r.linesAtExit).toBe(r.lines.length);
    expect(r.lines.length).toBe(3); // header + text_delta + message_end
  });

  it("KTD5：provider 失败时退出码仍为 0，错误只经最后一条 message_end 表达", async () => {
    installMod((emit) => {
      emit(TEXT_DELTA);
      emit(MESSAGE_END_ERROR);
    });
    const r = await run(baseReq);
    // 退出码若被「补」成非零，cli.ts 会判定为可安全重试的失败而重跑一轮 → 用户看到重复失败提示。
    expect(r.code).toBe(0);
    expect(r.events.at(-1)).toEqual({ type: "result", ok: false, error: "provider 挂了" });
  });

  it("中间轮 message_end(toolUse) 不发 result，收尾 result 不被覆盖", async () => {
    installMod((emit) => {
      emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
      emit(TOOL_START);
      emit(TOOL_END);
      emit(MESSAGE_END_OK);
      // agent_end 在 pi.ts 里是已知忽略帧：发了也不得产生第二个 result。
      emit({ type: "agent_end" });
    });
    const r = await run(baseReq);
    expect(r.events.filter((e) => e.type === "result")).toEqual([{ type: "result", ok: true, text: "答" }]);
  });
});

// ── 3. buildArgs 的 flag 对应物 ─────────────────────────────────────────────────────

describe("CLI flag → in-process 选项", () => {
  const runWithMod = async (req: Partial<CliStartRequest>) => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run({ ...baseReq, ...req });
    return fake;
  };

  it("--no-extensions / --no-skills 恒下发；useOwnSkills=true 才放开原生 skill 发现", async () => {
    const off = await runWithMod({});
    expect(off.calls.services[0]!.resourceLoaderOptions).toMatchObject({ noExtensions: true, noSkills: true });

    const on = await runWithMod({ useOwnSkills: true });
    expect(on.calls.services[0]!.resourceLoaderOptions).toMatchObject({ noExtensions: true, noSkills: false });
  });

  it("--skill <p> → additionalSkillPaths；--append-system-prompt → appendSystemPrompt 数组", async () => {
    const fake = await runWithMod({ skillPaths: ["/s/a", "/s/b"], appendSystemPrompt: "你是助手" });
    expect(fake.calls.services[0]!.resourceLoaderOptions).toMatchObject({
      additionalSkillPaths: ["/s/a", "/s/b"],
      appendSystemPrompt: ["你是助手"],
    });
  });

  it("--tools 只在 plan 只读档下发（其余档在单发下等价，不收窄工具）", async () => {
    const plan = await runWithMod({ permissionMode: "plan" });
    const tools = plan.calls.session[0]!.tools as string[];
    expect(tools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    expect(tools).not.toContain("write");

    const auto = await runWithMod({ permissionMode: "full-auto" });
    expect(auto.calls.session[0]).not.toHaveProperty("tools");
  });

  it("plan 档白名单并入本轮委派协作者的 ask_<id> 工具", async () => {
    const fake = await runWithMod({
      permissionMode: "plan",
      delegateRoles: [
        { id: "张 三", label: "张三", agent: "pi", systemPrompt: "", createdAt: "", updatedAt: "" },
      ],
    });
    // safeDelegateToolId 把「张 三」清成空串后兜底为 "role"（与二进制路径的 --tools 同源）。
    expect(fake.calls.session[0]!.tools).toContain("ask_role");
  });

  it("prompt 原样传入（in-process 无 argv，不需要 @ 前缀的空格转义）", async () => {
    const fake = await runWithMod({ prompt: "@张三 帮我看看" });
    expect(fake.calls.prompts[0]!.text).toBe("@张三 帮我看看");
  });

  it("--session <id>：本地命中则 open，未命中则以该 id 新建（而非像 CLI 那样静默 exit 1）", async () => {
    const hit = await runWithMod({ resumeSessionId: "existing-session-id" });
    expect(hit.calls.sessionManager.map((c) => c.fn)).toEqual(["list", "open"]);

    const miss = await runWithMod({ resumeSessionId: "gone-session-id" });
    const create = miss.calls.sessionManager.find((c) => c.fn === "create");
    expect(create?.args[2]).toEqual({ id: "gone-session-id" });
  });
});

// ── 4. 模型与 Provider ──────────────────────────────────────────────────────────────

describe("模型与 Provider", () => {
  it("providerId 走原生注册表（**不**加载 $CORTEX_PI_KEY 占位的 provider extension）", async () => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run({ ...baseReq, providerId: "deepseek", model: "deepseek-chat", piExtensionPath: "/fake/userData/pi-providers/deepseek.js" });
    expect(providerMocks.resolve).toHaveBeenCalledWith({ providerId: "deepseek", modelId: "deepseek-chat" });
    expect(fake.calls.session[0]!.model).toEqual({ provider: "deepseek", id: "deepseek-chat" });
    // provider extension 绝不进扩展路径（它的 apiKey 是只有子进程 env 才解得开的占位符）。
    const opts = fake.calls.services[0]!.resourceLoaderOptions as Record<string, unknown>;
    expect(opts.additionalExtensionPaths).toBeUndefined();
  });

  it("委派子 agent 只继承 req.provider（无 providerId）时也能解析出模型", async () => {
    installMod((emit) => emit(MESSAGE_END_OK));
    await run({ ...baseReq, provider: { id: "deepseek", baseUrl: "https://x", models: [] } });
    expect(providerMocks.resolve).toHaveBeenCalledWith({ providerId: "deepseek", modelId: undefined });
  });

  it("只有 --model 没有 provider 时按 pi 的 resolveCliModel 语义解析", async () => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run({ ...baseReq, model: "deepseek-chat" });
    expect(providerMocks.resolve).not.toHaveBeenCalled();
    expect(fake.calls.session[0]!.model).toEqual({ provider: "deepseek", id: "deepseek-chat" });
  });

  it("模型解析不出时不抛错，交回 pi 默认链并留下告警", async () => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    const r = await run({ ...baseReq, model: "unknown-model" });
    expect(r.code).toBe(0);
    expect(fake.calls.session[0]).not.toHaveProperty("model");
    expect(logMocks.logger.warn).toHaveBeenCalled();
  });

  it("modelRuntime 恒注入（承载自定义 Provider 与 baseUrl 覆盖，缺了会静默走官方地址）", async () => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run(baseReq);
    expect(fake.calls.services[0]!.modelRuntime).toBe(providerMocks.runtime);
  });
});

// ── 5. 安全：无审批 UI / 不注入 Computer Use / 扩展路径根闸 ────────────────────────

describe("安全约束", () => {
  it("bindExtensions **不传 uiContext**——单发路径无审批回路，接上比不接更危险", async () => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run(baseReq);
    const bindings = fake.calls.bind[0]!;
    expect(bindings).not.toHaveProperty("uiContext");
    expect(bindings.mode).toBe("json");
  });

  it("源码不得引入 Computer Use（「只在聊天 RPC 路径注入」这条约束在单发侧的落点）", () => {
    const src = readFileSync(fileURLToPath(new URL("./oneshot.ts", import.meta.url)), "utf8");
    // 注释里解释「为什么绝不注入」是允许且必要的，故只禁 import 与调用形态的符号。
    // 这类跨文件架构约束没有类型系统能表达，只能靠一条读源码的测试守住
    //（手法同 capabilities/automation/inject-points.test.ts）。
    expect(src).not.toMatch(/from\s+["'][^"']*computer-use/);
    expect(src).not.toMatch(/import\s*\(\s*["'][^"']*computer-use/);
    expect(src).not.toContain("resolveComputerUse");
    expect(src).not.toContain("computerUseEnv");
    expect(src).not.toContain("GROUNDING_MODEL_ENV");
  });

  it("cli.ts 的 pi 单发选路同样不带 Computer Use（扩展来源只有 extraExtensionPaths）", () => {
    const cli = readFileSync(fileURLToPath(new URL("../../ipc/cli.ts", import.meta.url)), "utf8");
    expect(cli).not.toContain("resolveComputerUse");
    expect(cli).not.toContain("computerUseEnv");
  });

  it("扩展路径根闸：只放行 userData/pi-extensions 下的 .js", () => {
    expect(
      filterOneShotExtensionPaths(
        {
          extraExtensionPaths: [
            `${EXT_ROOT}/delegate-bridge-s1.js`,
            `${EXT_ROOT}/delegate-bridge-s1.js`, // 重复项去重
            `${EXT_ROOT}/todo.js`,
            `${EXT_ROOT}/../pi-providers/deepseek.js`, // 逃逸到 provider 目录
            "/fake/userData/pi-extensions-evil/x.js", // 前缀相同但不同目录
            "relative/x.js", // 非绝对路径
            `${EXT_ROOT}/x.json`, // 非 .js
            "/etc/passwd",
          ],
        },
        EXT_ROOT,
      ),
    ).toEqual([`${EXT_ROOT}/delegate-bridge-s1.js`, `${EXT_ROOT}/todo.js`]);
  });

  it("放行的扩展经 additionalExtensionPaths 下发（等价二进制路径的 -e）", async () => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run({
      ...baseReq,
      extraExtensionPaths: [`${EXT_ROOT}/delegate-bridge-s1.js`, "/etc/passwd"],
    });
    expect(fake.calls.services[0]!.resourceLoaderOptions).toMatchObject({
      additionalExtensionPaths: [`${EXT_ROOT}/delegate-bridge-s1.js`],
    });
  });
});

// ── 6. 图片 ─────────────────────────────────────────────────────────────────────────

describe("图片投递", () => {
  it("`@<path>` 换成 SDK 的 images 入参（base64 + 魔数嗅探出的真实 MIME）", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cortex-oneshot-img-"));
    // 最小合法 PNG：8 字节签名 + 长度 13 的 IHDR 块（pi utils/mime.js 的判据）。
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write("IHDR", 12, "ascii");
    const path = join(dir, "a.png");
    writeFileSync(path, buf);

    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run({ ...baseReq, images: [{ path, mimeType: "image/png" }] });
    expect(fake.calls.prompts[0]!.options?.images).toEqual([
      { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("无图时不传 images（保持与 print-mode 同形的调用）", async () => {
    const fake = installMod((emit) => emit(MESSAGE_END_OK));
    await run(baseReq);
    expect(fake.calls.prompts[0]!.options).toBeUndefined();
  });
});

// ── 7. 异常边界（进程隔离消失后的三道闸） ──────────────────────────────────────────

describe("异常边界", () => {
  it("pi 运行时加载失败 → onError（等价二进制路径的 ENOENT spawn 失败），无任何 stdout", async () => {
    __setPiRuntimeImporterForTests(async () => {
      throw new Error("ERR_MODULE_NOT_FOUND");
    });
    const r = await run(baseReq);
    expect(r.error?.message).toContain("pi 运行时不可用");
    expect(r.lines).toEqual([]);
  });

  it("已开始产出后失败 → stderr + 退出码 1（等价进程非零退出）", async () => {
    installMod(() => {
      throw new Error("上游断流");
    });
    const r = await run(baseReq);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("上游断流");
    // 已经吐过 header，说明确实越过了「spawn 成功」这条线。
    expect(r.lines.length).toBeGreaterThan(0);
  });

  it("kill() 调 session.abort() 并以 code=null 收尾（模拟被信号杀死，cli.ts 据此判取消）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = installMod(async (emit) => {
      emit(TEXT_DELTA);
      await gate;
      emit(MESSAGE_END_OK);
    });
    const r = await run(baseReq, (proc) => {
      // 等首个事件出来后再杀，确保会话已建立、abortHook 已挂上。
      setTimeout(() => {
        proc.kill();
        release();
      }, 5);
    });
    expect(fake.calls.aborts).toBe(1);
    expect(r.code).toBeNull();
  });

  it("事件序列化失败只丢那一条，不打断 agent loop、不影响收尾", async () => {
    const circular: Record<string, unknown> = { type: "message_update" };
    circular.self = circular;
    installMod((emit) => {
      emit(circular);
      emit(MESSAGE_END_OK);
    });
    const r = await run(baseReq);
    expect(r.code).toBe(0);
    expect(r.events.at(-1)).toEqual({ type: "result", ok: true, text: "答" });
  });

  it("无论成败都释放会话（进程边界没了，不 dispose 就是永久泄漏）", async () => {
    const ok = installMod((emit) => emit(MESSAGE_END_OK));
    await run(baseReq);
    expect(ok.calls.disposed).toBe(1);

    const bad = installMod(() => {
      throw new Error("炸了");
    });
    await run(baseReq);
    expect(bad.calls.disposed).toBe(1);
  });
});
