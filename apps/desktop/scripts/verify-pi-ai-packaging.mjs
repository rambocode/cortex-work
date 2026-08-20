#!/usr/bin/env node
// pi-ai 主进程运行时的打包态验证。
//
// 为什么需要单独一个脚本：providers/pi-runtime.ts 与 custom-provider-registry.ts 用
// @vite-ignore 动态 import 加载 @earendil-works/pi-ai —— bundler 刻意不打包，依赖只能靠
// asar 里的 node_modules 在运行时解析。这意味着「开发态一切正常、打包后必挂」是这条链路的
// 默认失败模式：0.1.52/0.1.53 就因 electron-builder 排除了 @earendil-works/** 而让正式包的
// 连接测试全数报「模型运行时不可用」，且 dev 环境永远复现不了。
//
// 用法：先 `pnpm --filter @cortex-work/desktop dist:dir`，再 `node scripts/verify-pi-ai-packaging.mjs`。
// 任一检查失败即非零退出。
//
// 检查分三层：
//  1. 静态：asar 里 pi-ai 入口与全部重型 SDK 依赖在场（防 files 排除清单误伤闭包）。
//  2. 动态：起一个最小 Electron 主进程，从 asar 内真实 import providers/all 与各 api 实现
//     ——api 模块急切引各家 SDK，其内部裸标识符以 asar 内文件为 parent 解析，
//     与生产链路同一套 ESM 加载语义；缺任何传递依赖都会在此暴露为 ERR_MODULE_NOT_FOUND。
//  3. in-process 护栏（迁移计划 R11）：pi 收敛为 gateway 引擎后，三包
//     （pi-coding-agent / pi-agent-core / pi-tui）**必须**在 asar 内。这一层在**打包产物内**
//     实跑一整轮 agent loop（工具真实执行），断言与 scripts/verify-pi-inprocess.mjs 同源、
//     不重复实现。三包缺任何一个都直接判失败（bun 二进制形态已删除，没有回退可言）。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inProcVerifier = join(appDir, "scripts", "verify-pi-inprocess.mjs");
const failures = [];

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`  ✗ ${label} — ${err.message}`);
  }
}

/// 找 dist:dir 产出里 mtime 最新的 .app（同 verify-research-packaging：dist/ 会残留多架构
/// 历史构建，按目录名取第一个会验到陈旧产物）。
function findPackagedApp() {
  const distDir = join(appDir, "dist");
  if (!existsSync(distDir)) {
    throw new Error("dist/ 不存在，请先跑 pnpm --filter @cortex-work/desktop dist:dir");
  }
  const apps = [];
  for (const entry of readdirSync(distDir)) {
    const dir = join(distDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const sub of readdirSync(dir)) {
      if (sub.endsWith(".app")) apps.push(join(dir, sub));
    }
  }
  if (!apps.length) throw new Error("dist/ 下没有 .app 产物");
  apps.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return apps[0];
}

// 支持显式传 .app 路径：`node scripts/verify-pi-ai-packaging.mjs /tmp/Cortex.app`；不传时取 dist/ 内最新产物。
const sourceBundle = process.argv[2] ? resolve(process.argv[2]) : findPackagedApp();

// ── 自带仓库外隔离（lessons.md 纪律的强制化，不再依赖调用者记得做）──────────────────────
// 仓库内 dist 里的产物,asar/unpacked 文件向上解析能摸到仓库 node_modules 兜底,缺包也
// 「看着能解析」——这个假象骗过验证两次(全 unpack 时代与 0.1.54 的「worker 裸包名可解析」)。
// 故无论传入的 .app 在哪,一律先 ditto 到系统临时目录(仓库外)再验,让「跑错姿势」不可能发生。
// 代价是每次多几秒复制,作为发布关卡可接受。
const isolationDir = mkdtempSync(join(tmpdir(), "pi-verify-app-"));
const appBundle = join(isolationDir, basename(sourceBundle));
execFileSync("ditto", [sourceBundle, appBundle]);
const asarPath = join(appBundle, "Contents", "Resources", "app.asar");
console.log(`验证产物: ${sourceBundle}`);
console.log(`隔离副本: ${appBundle}`);

// ── 1. 静态：asar 内容 ────────────────────────────────────────────────────────

// 用打包依赖里的 @electron/asar 列文件（避免 npx 网络安装）。
const asarList = (() => {
  const script = `const asar=require("@electron/asar");console.log(asar.listPackage(${JSON.stringify(asarPath)}).join("\\n"))`;
  return execFileSync(process.execPath, ["-e", script], { cwd: appDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
})();
const inAsar = new Set(asarList);

check("asar 含 pi-ai 入口 providers/all.js", () => {
  const p = "/node_modules/@earendil-works/pi-ai/dist/providers/all.js";
  if (!inAsar.has(p)) throw new Error(`${p} 不在 asar 中（files 排除清单误伤？）`);
});

// pi-ai 的重型 SDK 依赖闭包抽样（名单来源：当前 pi-ai package.json dependencies；
// 升级 pi 后先以完整闭包判据为准，再更新这份可读抽样，不让已删除的旧 SDK 变成误报）。
for (const dep of [
  "openai",
  "@anthropic-ai/sdk",
  "@google/genai",
  "@aws-sdk/client-bedrock-runtime",
  "@smithy/node-http-handler",
  "gaxios",
  "web-streams-polyfill",
  "typebox",
  "partial-json",
]) {
  check(`asar 含依赖 ${dep}`, () => {
    const prefix = `/node_modules/${dep}/`;
    if (!asarList.some((f) => f.startsWith(prefix))) throw new Error(`${prefix} 缺失`);
  });
}

// pi 唯一执行形态是 gateway 引擎（worker 内 in-process 调 SDK），三包必须在 asar 内按包名可解析。
// 曾经的自适应双态（迁移前守「不该进包」体积红线 / 迁移后守「进了包且真能跑」）随 bun 二进制
// 形态删除而收敛为单态：缺包即失败，没有「走二进制所以不需要」的豁免。
const hasInAsar = (dep) => asarList.some((f) => f.startsWith(`/node_modules/${dep}/`));

for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"]) {
  check(`asar 含 ${dep}`, () => {
    if (!hasInAsar(dep)) throw new Error(`/node_modules/${dep}/ 缺失（files 排除清单误伤？）`);
  });
}
// ── 依赖闭包自动比对（0.1.54 事故后从「抽样名单」升级）────────────────────────────────
// 曾经这里只点名 photon-node 与 highlight.js 两条「隐藏依赖」——抽样名单注定滞后：
// 0.1.54 就漏了同型的 marked（pi-tui 的直接依赖，被 files 当纯 renderer 冗余排除），
// 正式包语音聊天报 "Cannot find package 'marked'"。判据必须是 lessons.md 那句：
// **对运行时入口求一遍完整依赖闭包**。这里从仓库 node_modules 沿 pnpm 真实解析链算出
// pi-coding-agent + pi-ai 的全部传递依赖，逐包断言在 asar 里——排除清单再误伤任何一个，
// 打包态验证直接红。（不可解析的 optionalDependencies 是其它平台的变体包，跳过。）
function piRuntimeClosure() {
  const seen = new Set();
  const resolvePkgDir = (name, fromDir) => {
    let dir = fromDir;
    for (;;) {
      const cand = join(dir, "node_modules", ...name.split("/"));
      if (existsSync(join(cand, "package.json"))) return realpathSync(cand);
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };
  // 只走 dependencies:optionalDependencies 按 npm 约定允许缺席、消费方代码须自行兜底
  // (实测 electron-builder 也确实不收 pi-coding-agent 的 @mariozechner/clipboard),
  // 把 optional 算成硬缺失是误报。跳过的 optional 逐个打出来,不做静默截断。
  const walk = (name, fromDir) => {
    if (seen.has(name)) return;
    const dir = resolvePkgDir(name, fromDir);
    if (!dir) return; // 未安装的可选平台变体
    seen.add(name);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      console.log(`    · 跳过 optionalDependency ${name} → ${dep}（允许缺席）`);
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir);
  };
  walk("@earendil-works/pi-coding-agent", appDir);
  walk("@earendil-works/pi-ai", appDir);
  return [...seen].sort();
}

{
  const closure = piRuntimeClosure();
  const missing = closure.filter((dep) => !hasInAsar(dep));
  check(`asar 完整覆盖 pi 运行时依赖闭包（${closure.length} 包）`, () => {
    if (missing.length) {
      throw new Error(`缺 ${missing.length} 包（electron-builder.yml files 排除项误伤？）: ${missing.join(", ")}`);
    }
    return `closure=${closure.length}`;
  });
}

// ── 2. 动态：Electron 主进程内从 asar 真实 import ─────────────────────────────

check("Electron 主进程可从 asar 加载 pi-ai 及全部 api 实现", () => {
  const harnessDir = mkdtempSync(join(tmpdir(), "pi-ai-asar-test-"));
  try {
    writeFileSync(
      join(harnessDir, "main.cjs"),
      `
const { app } = require("electron");
const { pathToFileURL } = require("url");
const ASAR = process.env.TEST_ASAR;
app.whenReady().then(async () => {
  try {
    const base = ASAR + "/node_modules/@earendil-works/pi-ai/dist";
    const all = await import(pathToFileURL(base + "/providers/all.js").href);
    const count = all.builtinModels().getProviders().length;
    if (!count) throw new Error("builtinModels 无 provider");
    // 六个 api 实现覆盖 API_FACTORY 全集与最重的 mistral/bedrock 两条依赖链。
    for (const m of [
      "api/openai-completions.js",
      "api/openai-responses.js",
      "api/anthropic-messages.js",
      "api/google-generative-ai.js",
      "api/mistral-conversations.js",
      "api/bedrock-converse-stream.js",
    ]) await import(pathToFileURL(base + "/" + m).href);
    console.log("[ALL-PASS] providers=" + count);
    app.exit(0);
  } catch (err) {
    console.error("[FAIL]", (err && (err.stack || err.message)) || String(err));
    app.exit(1);
  }
});
`,
    );
    writeFileSync(join(harnessDir, "package.json"), JSON.stringify({ name: "pi-ai-asar-test", main: "main.cjs" }));
    const electronBin = join(appDir, "node_modules", ".bin", "electron");
    const out = spawnSync(electronBin, [harnessDir], {
      env: { ...process.env, TEST_ASAR: asarPath },
      encoding: "utf8",
      timeout: 120_000,
    });
    const stdout = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    if (out.status !== 0 || !stdout.includes("[ALL-PASS]")) {
      throw new Error(`退出码 ${out.status}: ${stdout.slice(0, 800)}`);
    }
    return stdout.match(/\[ALL-PASS\][^\n]*/)?.[0];
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

// ── 3. in-process 护栏：在 asar 内实跑一轮 agent loop（R11） ─────────────────

if (!existsSync(inProcVerifier)) {
  failures.push(`in-process 护栏: 找不到 ${inProcVerifier}`);
  console.log(`  ✗ in-process 护栏 — 找不到 ${inProcVerifier}`);
} else {
  check("Electron 主进程可在 asar 内跑通 pi in-process agent loop", () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "pi-inproc-asar-test-"));
    try {
      // harness 只负责两件事：① 把「按包名解析」翻译成「在 asar 内定位 ESM 入口」；
      // ② 调 verify-pi-inprocess.mjs 的同一套断言。断言逻辑刻意不在这里复制一份——
      // 复制必然与开发态那份漂移，而漂移正是本护栏要防的东西。
      //
      // 为什么要自己解析入口：harness 在临时目录里，裸 import 会以临时目录为 parent 解析，
      // 根本碰不到 asar。手动定位到 asar 内的入口文件后，包**内部**的裸标识符仍以 asar 内文件为
      // parent 解析（与生产链路同一套 ESM 语义），传递依赖缺失照样暴露为 ERR_MODULE_NOT_FOUND。
      writeFileSync(
        join(harnessDir, "main.cjs"),
        `
const { app } = require("electron");
const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");
const ASAR = process.env.TEST_ASAR;
const VERIFIER = process.env.TEST_VERIFIER;

// 读包自身 package.json 的 exports["."].import（回退 default / main）定位 ESM 入口。
// 三个 pi 包都是 "type":"module" 且 exports 只有 import 条件，不能用 require.resolve。
function resolveInAsar(name) {
  const dir = path.join(ASAR, "node_modules", ...name.split("/"));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const dot = pkg.exports && pkg.exports["."];
  const rel = (dot && (dot.import || dot.default)) || pkg.main || "index.js";
  return pathToFileURL(path.join(dir, rel)).href;
}

app.whenReady().then(async () => {
  try {
    const mod = await import(pathToFileURL(VERIFIER).href);
    const { ok } = await mod.runPiInProcessVerification({
      importModule: (name) => import(resolveInAsar(name)),
      log: (s) => console.log("      " + s),
    });
    console.log(ok ? "[INPROC-PASS]" : "[INPROC-FAIL]");
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[INPROC-FAIL]", (err && (err.stack || err.message)) || String(err));
    app.exit(1);
  }
});
`,
      );
      writeFileSync(join(harnessDir, "package.json"), JSON.stringify({ name: "pi-inproc-asar-test", main: "main.cjs" }));
      const electronBin = join(appDir, "node_modules", ".bin", "electron");
      const out = spawnSync(electronBin, [harnessDir], {
        env: { ...process.env, TEST_ASAR: asarPath, TEST_VERIFIER: inProcVerifier },
        encoding: "utf8",
        // 比上一层宽：这里要真跑 grep/read/bash 三个工具 + 构造 AgentSession。
        timeout: 180_000,
      });
      const stdout = `${out.stdout ?? ""}${out.stderr ?? ""}`;
      // 逐行回显 harness 输出，失败时不用再去猜是哪一段断言挂了。
      for (const line of stdout.split("\n")) if (line.trim()) console.log(`    ${line}`);
      if (out.status !== 0 || !stdout.includes("[INPROC-PASS]")) {
        throw new Error(`退出码 ${out.status}`);
      }
      return "PI_INPROC_RESULT=PASS";
    } finally {
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });
}

// ── pi gateway worker 产物存在性 ─────────────────────────────────────────────────
// 常驻 gateway 引擎的 worker 必须随包（asarUnpack 的 out/worker/**）。缺失的成因几乎只有
// 一个：构建链里 build:worker 之后没串 build:pi-host（后者 emptyOutDir:false 依赖前者先跑，
// 顺序对了但漏了第二步就会静默丢产物）。缺失的表现是 gateway 选路下开会话报「未找到入口」，
// 而 binary/inproc 完全正常——只在切了引擎的用户那里暴露，故这里在打包态就拦。
{
  const unpackedHost = join(appBundle, "Contents", "Resources", "app.asar.unpacked", "out", "worker", "pi-host.js");
  if (existsSync(unpackedHost)) {
    console.log("  ✓ gateway worker 产物在场: app.asar.unpacked/out/worker/pi-host.js");
  } else {
    console.error("  ✗ 缺少 gateway worker 产物（检查构建链是否串了 build:pi-host）");
    failures.push("pi-host.js 缺失");
  }

  // ── worker 上下文实跑（0.1.54 事故的直接护栏）────────────────────────────────────────
  // 上面几层全在**主进程**上下文验证，而 0.1.54 恰恰是 worker 独有的失败：pi-host 从
  // app.asar.unpacked fork，裸包名 import 的父链走不进 app.asar/node_modules，主进程全绿、
  // worker 全挂。这里用 utilityProcess 按生产同款参数真 fork 打包产物里的 pi-host.js——
  // fork 即预热会加载三包，warmup 结果打到 stderr（见 host.ts startPiHostRuntimeWarmup），
  // 断言收到 "[pi-host] warmup ok" 标记行。任何包在 worker 上下文解析失败都在这里红。
  if (existsSync(unpackedHost)) {
    check("pi-host worker 真 fork 后三包 warmup 成功", () => {
      const harnessDir = mkdtempSync(join(tmpdir(), "pi-host-fork-test-"));
      try {
        writeFileSync(
          join(harnessDir, "main.cjs"),
          `
const { app, utilityProcess } = require("electron");
app.whenReady().then(() => {
  // stdio 与生产 forkPiHostTransport 一致：stdin 必须 ignore（KTD2），stderr 收 warmup 标记行。
  const child = utilityProcess.fork(process.env.TEST_PI_HOST, [], {
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "verify-pi-host",
  });
  let tail = "";
  let done = false;
  // finish 必须幂等：成功路径的 child.kill() 会触发 exit 事件再进一次 finish(false)。
  const finish = (ok) => {
    if (done) return;
    done = true;
    try { child.kill(); } catch {}
    console.log(ok ? "[WORKER-PASS]" : "[WORKER-FAIL] stderr: " + tail.slice(-1500));
    app.exit(ok ? 0 : 1);
  };
  const timer = setTimeout(() => finish(false), 150000);
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    tail += chunk;
    if (tail.includes("[pi-host] warmup ok")) { clearTimeout(timer); finish(true); }
    else if (tail.includes("[pi-host] warmup failed")) { clearTimeout(timer); finish(false); }
  });
  child.on("exit", () => { clearTimeout(timer); finish(false); });
});
`,
        );
        writeFileSync(join(harnessDir, "package.json"), JSON.stringify({ name: "pi-host-fork-test", main: "main.cjs" }));
        const electronBin = join(appDir, "node_modules", ".bin", "electron");
        const out = spawnSync(electronBin, [harnessDir], {
          env: { ...process.env, TEST_PI_HOST: unpackedHost },
          encoding: "utf8",
          // 三包纯 ESM 闭包冷加载 + 进程 fork，比主进程那层慢，放宽到 160s。
          timeout: 160_000,
        });
        const stdout = `${out.stdout ?? ""}${out.stderr ?? ""}`;
        if (out.status !== 0 || !stdout.includes("[WORKER-PASS]")) {
          throw new Error(`退出码 ${out.status}: ${stdout.slice(0, 1200)}`);
        }
        return "PI_WORKER_RESULT=PASS";
      } finally {
        rmSync(harnessDir, { recursive: true, force: true });
      }
    });
  }
}

// 隔离副本用完即删（失败也删:要复查产物应看 dist/ 或安装包本体,不是临时副本）。
rmSync(isolationDir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n✓ pi-ai 打包态验证通过");
