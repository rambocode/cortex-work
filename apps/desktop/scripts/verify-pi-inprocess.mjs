#!/usr/bin/env node
// pi in-process 运行时护栏（迁移计划 U0 / R11）。
//
// 背景：pi 正从「resources/pi 的 bun 自包含二进制 + spawn + 手抄 JSONL 协议」迁移为
// 「主进程内直接调用 @earendil-works/pi-coding-agent 的 SDK（createAgentSession）」。
// 这条链路的历史失败模式是**静默**的两类：
//   ① 纯 ESM 依赖闭包在 asar 内解析不到 → ERR_MODULE_NOT_FOUND（当年逼着改用 bun 二进制的坑，
//      0.1.52/0.1.53 正式包的连接测试全数报「模型运行时不可用」也是同一类），dev 环境永不复现；
//   ② SDK 契约不符不抛异常，只表现为 message_end.stopReason="error"（见下方 KTD5 注释）。
// 所以这个脚本不满足于「import 成功」，而是把三包加载 → 工具集构造 → 一整轮真跑的 agent loop
// （工具真实读写磁盘）→ createAgentSession 构造 串起来，任一环失败即非零退出。
//
// 两种跑法（都不需要 provider 凭据、不发任何网络请求、不花钱——模型侧全用 mock stream）：
//   node apps/desktop/scripts/verify-pi-inprocess.mjs
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron apps/desktop/scripts/verify-pi-inprocess.mjs
// 第三种跑法是打包态：scripts/verify-pi-ai-packaging.mjs 会注入 asar 内的 importModule
// 复用本文件的 runPiInProcessVerification()，让同一套断言在 app.asar 里再跑一遍。
//
// ⚠️ KTD1：包名一律用数组 join("/") 拼成变量 specifier，不写字符串字面量。与
// providers/pi-runtime.ts 同款——让打包器完全不参与静态分析，运行时保留原生 import() 加载 ESM。
// 写成字面量会把整个纯 ESM 依赖图静默打进主进程的 CJS chunk。
// ⚠️ KTD2：本文件禁止 top-level await。rollup 对 cjs 输出直接拒绝
// （Module format "cjs" does not support top-level await）。虽然本文件当前是独立 .mjs 脚本、
// 不进主进程 bundle，但其逻辑是 U2 引擎层的先行样板，保持同一条纪律，避免复制过去才炸。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 三个包的包名（KTD1：变量 specifier）。pi-agent-core 不是 apps/desktop 的直接依赖，
// 靠 .npmrc 的 shamefully-hoist 与 pi-coding-agent 的依赖闭包提供；打包态则由
// electron-builder 扁平化进 asar 的 /node_modules。两条路径都必须能按包名解析——正是本脚本要守的。
export const PI_PACKAGES = {
  coding: ["@earendil-works", "pi-coding-agent"].join("/"),
  core: ["@earendil-works", "pi-agent-core"].join("/"),
  ai: ["@earendil-works", "pi-ai"].join("/"),
};

// createCodingTools(cwd) 的真实返回集（KTD3）。它**只给这四个**，
// grep/find/ls 必须各自单独构造——而 plan 只读档的工具白名单恰好依赖那三个。
// 漏掉的表现是 plan 档下工具「不存在」而非报错，属于静默降级，故在此硬断言。
const CODING_TOOL_NAMES = ["read", "bash", "edit", "write"];
// 需要单独构造补齐的三个（KTD3）。
const EXTRA_TOOL_FACTORIES = ["createGrepTool", "createFindTool", "createLsTool"];

const NEEDLE = "NEEDLE_ABC_7F3";
// agent loop 的整体超时：mock stream 不走网络，正常几十毫秒即结束；
// 卡住通常意味着 SDK 契约漂移（事件没闭环），必须超时而非永久挂起，否则 CI 会静默吊死。
const LOOP_TIMEOUT_MS = 30_000;

/**
 * 用 pi-ai 的 createAssistantMessageEventStream 造一个 mock 模型流。
 *
 * ⚠️ KTD5（本次迁移最容易踩的静默陷阱）：streamFn 的返回值必须是 pi-ai 的
 * AssistantMessageEventStream（带 result() 方法），**不能**是裸 async generator。
 * 返回裸 generator 时 Agent 内部会抛 "response.result is not a function"，但这个异常
 * 不会冒泡，而是被吞进 message_end 的 stopReason:"error" —— 表现为「跑完了、没结果、没报错」。
 * 这与「pi 失败仍 exit 0」是同一类陷阱，所以本脚本必须显式校验 loop 的产出而非只看有没有抛。
 *
 * @param piAi   已加载的 @earendil-works/pi-ai 模块
 * @param steps  每轮要发出的工具调用；用完后发一条纯文本收尾
 */
function makeMockStreamFn(piAi, steps) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const base = { role: "assistant", api: "anthropic", provider: "verify", model: "verify", usage, timestamp: 0 };
  let turn = 0;

  return () => {
    const step = steps[turn];
    turn += 1;
    const stream = piAi.createAssistantMessageEventStream();
    let events;
    if (step) {
      const toolCall = { type: "toolCall", id: `call-${turn}`, name: step.name, arguments: step.arguments };
      const message = { ...base, content: [toolCall], stopReason: "toolUse" };
      events = [
        { type: "start", partial: { ...base, content: [], stopReason: "stop" } },
        { type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
        { type: "done", reason: "toolUse", message },
      ];
    } else {
      const message = { ...base, content: [{ type: "text", text: "done" }], stopReason: "stop" };
      events = [
        { type: "start", partial: { ...base, content: [], stopReason: "stop" } },
        { type: "text_delta", contentIndex: 0, delta: "done", partial: message },
        { type: "done", reason: "stop", message },
      ];
    }
    // 必须异步 push：同步 push 会在订阅者挂上之前就把事件丢完。
    // 用 Promise 微任务而非 queueMicrotask —— 后者不在 eslint 的 scripts/ globals 白名单里。
    Promise.resolve().then(() => {
      for (const e of events) stream.push(e);
    });
    return stream;
  };
}

/** 在 ms 毫秒后 reject 的竞速守卫，用于给 agent loop 加硬超时。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 建一个供工具真实读写的临时工作目录：一个含 NEEDLE 的文件 + 一个子目录。
 * 用真实 IO 而非 stub，是因为「工具能构造」和「工具能跑」在 asar 内是两件事
 * （photon-node 之类的 native 依赖、jiti 的运行时加载都可能只在真跑时才炸）。
 */
function makeWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-inproc-verify-"));
  writeFileSync(join(cwd, "hello.txt"), `cortex-desktop\n${NEEDLE}\n`);
  mkdirSync(join(cwd, "sub"), { recursive: true });
  return cwd;
}

/**
 * in-process 护栏主体。四段验证依次执行，任一段失败即短路返回 ok:false。
 *
 * @param importModule 模块加载器。默认按包名裸 import（从本文件位置解析）；打包态由
 *                     verify-pi-ai-packaging.mjs 注入「从 app.asar 内解析」的实现，
 *                     使同一套断言能覆盖 asar 语义——那才是真正的风险点。
 * @param log          输出回调（打包态 harness 会换成带前缀的 logger）。
 * @returns {Promise<{ok: boolean, lines: string[]}>}
 */
export async function runPiInProcessVerification({ importModule, log = console.log } = {}) {
  const load = importModule ?? ((specifier) => import(/* @vite-ignore */ specifier));
  const lines = [];
  const say = (s) => {
    lines.push(s);
    log(s);
  };
  const fail = (s) => {
    say(`✗ ${s}`);
    return { ok: false, lines };
  };

  // ── 1. 三包按包名加载 ─────────────────────────────────────────────────────
  const mods = {};
  for (const [key, name] of Object.entries(PI_PACKAGES)) {
    try {
      mods[key] = await load(name);
      say(`✓ import ${name}（${Object.keys(mods[key]).length} 个导出）`);
    } catch (err) {
      return fail(`import ${name} 失败：${err?.code ?? ""} ${err?.message ?? err}`);
    }
  }
  const { coding, core, ai: piAi } = mods;

  if (typeof coding.createAgentSession !== "function") {
    return fail("pi-coding-agent 未导出 createAgentSession —— SDK 层入口变了，U2 引擎层需重新对齐");
  }
  if (typeof core.Agent !== "function") {
    return fail("pi-agent-core 未导出 Agent —— 引擎层核心类变了");
  }
  if (typeof piAi.createAssistantMessageEventStream !== "function") {
    return fail("pi-ai 未导出 createAssistantMessageEventStream —— mock 流契约失效（见 KTD5）");
  }

  const cwd = makeWorkspace();
  try {
    // ── 2. 工具集构造（KTD3 / KTD4） ────────────────────────────────────────
    const codingTools = coding.createCodingTools(cwd);
    const codingNames = codingTools.map((t) => t.name);
    const missing = CODING_TOOL_NAMES.filter((n) => !codingNames.includes(n));
    if (missing.length) return fail(`createCodingTools 缺工具：${missing.join(", ")}`);
    // 反向断言：若上游哪天把 grep/find/ls 塞进 createCodingTools，说明 KTD3 前提变了，
    // U2 的 tools.ts 会重复注册同名工具 —— 与「缺」同样要立刻可见。
    const unexpected = codingNames.filter((n) => !CODING_TOOL_NAMES.includes(n));
    if (unexpected.length) {
      return fail(`createCodingTools 多出工具：${unexpected.join(", ")}（KTD3 前提变化，需复核 tools.ts）`);
    }

    const extraTools = [];
    for (const factory of EXTRA_TOOL_FACTORIES) {
      if (typeof coding[factory] !== "function") return fail(`pi-coding-agent 未导出 ${factory}（KTD3）`);
      extraTools.push(coding[factory](cwd));
    }
    const tools = [...codingTools, ...extraTools];
    say(`✓ 工具集构造：${tools.map((t) => t.name).join(", ")}`);

    // KTD4：pi-agent-core 的 read 用 path，与 CLI 版的 file_path 不同。
    // toolDetail() 现在两者都取所以恰好兼容，但其余消费点（审批 UI 的路径展示等）会静默取到 undefined。
    const readParams = codingTools.find((t) => t.name === "read")?.parameters;
    const readRequired = readParams?.required ?? [];
    if (!readRequired.includes("path")) {
      return fail(`read 工具必填参数不含 path（实为 ${JSON.stringify(readRequired)}）—— KTD4 前提变化`);
    }
    say(`✓ read 工具参数名为 path（非 CLI 版的 file_path，KTD4）`);

    // ── 3. 跑通一轮完整 agent loop（工具真实执行） ──────────────────────────
    // 三个工具覆盖三条不同的执行面：grep（coding-agent 单独构造的）、read（KTD4 的参数名）、
    // bash（子进程执行）。全部要求真实产出可断言的内容，而非只看 isError。
    const steps = [
      { name: "grep", arguments: { pattern: NEEDLE, path: cwd } },
      { name: "read", arguments: { path: join(cwd, "hello.txt") } },
      { name: "bash", arguments: { command: "echo BASH_OK" } },
    ];
    const agent = new core.Agent({
      initialState: {
        systemPrompt: "cortex in-process verification",
        model: { id: "verify", provider: "verify", api: "anthropic" },
        tools,
      },
      streamFn: makeMockStreamFn(piAi, steps),
    });

    const results = [];
    const errors = [];
    agent.subscribe((e) => {
      if (e.type === "tool_execution_end") {
        results.push({
          tool: e.toolName,
          isError: Boolean(e.isError),
          text: (e.result?.content ?? [])
            .map((c) => c.text ?? "")
            .join("")
            .trim(),
        });
      }
      // KTD5：错误不抛，只落在 message_end 的 stopReason 上。必须显式收集。
      if (e.type === "message_end") {
        const stopReason = e.message?.stopReason;
        if (stopReason === "error" || stopReason === "aborted") {
          errors.push(e.message?.errorMessage ?? String(stopReason));
        }
      }
    });

    try {
      await withTimeout(
        (async () => {
          await agent.prompt("verify");
          await agent.waitForIdle();
        })(),
        LOOP_TIMEOUT_MS,
        "agent loop",
      );
    } catch (err) {
      return fail(`agent loop 异常：${err?.message ?? err}`);
    }

    if (errors.length) {
      // 走到这里通常就是 KTD5：streamFn 契约不符被吞成 error，而不是真的模型出错。
      return fail(`agent loop 产生 error 终态（KTD5 静默失败）：${errors.join(" | ")}`);
    }
    for (const r of results) {
      say(`  ${r.tool} isError=${r.isError} → ${JSON.stringify(r.text.slice(0, 60))}`);
    }

    const byName = (n) => results.find((r) => r.tool === n);
    const checks = [
      [results.length === steps.length, `工具执行轮次 ${results.length} ≠ ${steps.length}`],
      [results.every((r) => !r.isError), "有工具执行报错"],
      [byName("grep")?.text.includes(NEEDLE), "grep 未在真实文件里命中 NEEDLE"],
      [byName("read")?.text.includes(NEEDLE), "read 未读回真实文件内容"],
      [byName("bash")?.text.includes("BASH_OK"), "bash 未真实执行"],
    ];
    for (const [ok, msg] of checks) {
      if (!ok) return fail(`agent loop 断言失败：${msg}`);
    }
    say(`✓ agent loop 跑通（grep / read / bash 均真实执行）`);

    // ── 3b. run 内 checkpoint guard（本地 fork contract）────────────────────
    // Guard 必须在工具批次结束后停止本次底层 loop，并把结构化原因送到 agent_end；否则 Cortex
    // 无法保留同一 UI run 后自动 compaction + continue，只能退回「length 1 token 假成功」。
    const checkpointEvents = [];
    const checkpointAgent = new core.Agent({
      initialState: {
        systemPrompt: "cortex checkpoint verification",
        model: { id: "verify", provider: "verify", api: "anthropic" },
        tools: [coding.createGrepTool(cwd)],
      },
      shouldStopAfterTurn: ({ toolResults }) => (toolResults.length ? { reason: "context-checkpoint" } : false),
      streamFn: makeMockStreamFn(piAi, [{ name: "grep", arguments: { pattern: NEEDLE, path: cwd } }]),
    });
    checkpointAgent.subscribe((event) => checkpointEvents.push(event));
    await withTimeout(checkpointAgent.prompt("checkpoint"), LOOP_TIMEOUT_MS, "checkpoint guard");
    const checkpointEnd = checkpointEvents.find((event) => event.type === "agent_end");
    if (checkpointEnd?.reason !== "context-checkpoint") {
      return fail(`checkpoint guard 未产 context-checkpoint agent_end（实际 ${checkpointEnd?.reason ?? "无"}）`);
    }
    say("✓ run 内 checkpoint guard 以 context-checkpoint 结束工具批次");

    // ── 4. createAgentSession 构造（U2 引擎层的落脚点） ─────────────────────
    // 无 provider 凭据下也应能构造成功：会话对象的创建不该依赖模型可用性。
    // 用 SessionManager.inMemory() 避免在验证机上落盘 session JSONL。
    try {
      const { session } = await coding.createAgentSession({
        cwd,
        agentDir: join(cwd, ".pi-agent"),
        sessionManager: coding.SessionManager.inMemory(),
      });
      // 抽查 PiRpcSession 现有对外行为最依赖的几个方法面（U2 要求 in-process 会话与其同形状）。
      const required = ["prompt", "abort", "compact", "setModel", "subscribe"];
      const absent = required.filter((m) => typeof session[m] !== "function");
      if (absent.length) return fail(`AgentSession 缺方法：${absent.join(", ")}（U2 同形状假设不成立）`);
      say(`✓ createAgentSession 构造成功（sessionId=${String(session.sessionId ?? "").slice(0, 12)}…）`);
    } catch (err) {
      return fail(`createAgentSession 失败：${err?.code ?? ""} ${err?.message ?? err}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  say("PI_INPROC_RESULT=PASS");
  return { ok: true, lines };
}

// ── CLI 入口 ────────────────────────────────────────────────────────────────
// 仅在被直接执行时跑；被 verify-pi-ai-packaging.mjs 当模块 import 时不自动执行。
// ⚠️ 用 .then() 而非 top-level await（KTD2）。
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`;
  console.log(`pi in-process 验证（runtime: ${runtime}）`);
  runPiInProcessVerification().then(
    ({ ok }) => {
      if (!ok) console.error("\n✗ pi in-process 验证失败");
      process.exit(ok ? 0 : 1);
    },
    (err) => {
      console.error("✗ pi in-process 验证异常：", err?.stack ?? err);
      process.exit(1);
    },
  );
}

// 打包态护栏（verify-pi-ai-packaging.mjs）要把本文件路径传给临时 Electron harness 去 import，
// 故显式导出自身绝对路径，避免那边硬编码相对路径而在目录调整后静默失联。
export const PI_INPROC_SCRIPT_PATH = fileURLToPath(import.meta.url);
