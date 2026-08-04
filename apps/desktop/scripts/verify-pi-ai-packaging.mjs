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
// 检查分两层：
//  1. 静态：asar 里 pi-ai 入口与全部重型 SDK 依赖在场（防 files 排除清单误伤闭包）。
//  2. 动态：起一个最小 Electron 主进程，从 asar 内真实 import providers/all 与各 api 实现
//     ——api 模块急切引各家 SDK，其内部裸标识符以 asar 内文件为 parent 解析，
//     与生产链路同一套 ESM 加载语义；缺任何传递依赖都会在此暴露为 ERR_MODULE_NOT_FOUND。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const appBundle = findPackagedApp();
const asarPath = join(appBundle, "Contents", "Resources", "app.asar");
console.log(`验证产物: ${appBundle}`);

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

// pi-ai 的重型 SDK 依赖闭包抽样（名单来源：pi-ai package.json dependencies + 实测传递闭包；
// 升级 pi 后若此处失败，先重新求闭包再改 electron-builder.yml 的排除项）。
for (const dep of [
  "openai",
  "@anthropic-ai/sdk",
  "@google/genai",
  "@mistralai/mistralai",
  "@aws-sdk/client-bedrock-runtime",
  "@smithy/node-http-handler",
  "fast-xml-parser",
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

// 不该进包的 pi CLI 家族仍应被排除（体积守卫，防排除项回退成全量放行）。
for (const dep of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-agent-core"]) {
  check(`asar 不含 ${dep}`, () => {
    const prefix = `/node_modules/${dep}/`;
    if (asarList.some((f) => f.startsWith(prefix))) throw new Error(`${prefix} 不该进 asar`);
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

if (failures.length) {
  console.error(`\n✗ ${failures.length} 项失败`);
  process.exit(1);
}
console.log("\n✓ pi-ai 打包态验证通过");
