#!/usr/bin/env node
// CRE 打包态验证（spec §19.2.7、§19.5）。
//
// 为什么需要单独一个脚本：Research Worker 是 utilityProcess 子进程，它的入口解析、asar 边界、
// 依赖内联全部只在**打包产物**里才会暴露问题。开发态一切正常而打包后崩，是这条链路的常见
// 失败模式——docs/lessons.md 已经记了一次（vite build.ssr 默认外部化依赖，导致 worker 打包后
// import 到不存在的 pdfjs）。
//
// 用法：先 `pnpm --filter @cortex-work/desktop dist:dir`，再 `node scripts/verify-research-packaging.mjs`。
// 任一检查失败即非零退出。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`  ✗ ${label} — ${err.message}`);
  }
}

/// 找到 dist:dir 产出的 .app。
///
/// ⚠️ **必须取 mtime 最新的那个**：dist/ 下会同时留着历史构建（mac/、mac-arm64/、mac-x64/
/// 各一份，且 electron-builder 按目标架构选目录名）。按目录名顺序取第一个会验到几天前的
/// 陈旧产物——这个坑本脚本自己踩过一次，当时报「worker 缺失」，实际是在验一个 CRE 还不存在
/// 的旧包。
function findPackagedApp() {
  const distDir = join(appDir, "dist");
  if (!existsSync(distDir)) {
    throw new Error("dist/ 不存在，请先跑 pnpm --filter @cortex-work/desktop dist:dir");
  }
  const apps = [];
  for (const entry of readdirSync(distDir)) {
    const candidate = join(distDir, entry);
    if (!statSync(candidate).isDirectory()) continue;
    for (const inner of readdirSync(candidate)) {
      if (!inner.endsWith(".app")) continue;
      const appPath = join(candidate, inner);
      apps.push({ path: appPath, mtime: statSync(appPath).mtimeMs });
    }
  }
  if (apps.length === 0) throw new Error("dist/ 下找不到 .app");
  apps.sort((a, b) => b.mtime - a.mtime);
  const newest = apps[0];
  const ageMinutes = (Date.now() - newest.mtime) / 60_000;
  if (ageMinutes > 120) {
    notes.push(
      `产物已是 ${Math.round(ageMinutes / 60)} 小时前构建的，可能不含最新改动——建议重跑 dist:dir`,
    );
  }
  return newest.path;
}

console.log("Cortex Research Engine 打包态验证\n");

const appPath = findPackagedApp();
console.log(`产物: ${appPath}\n`);

const resourcesDir = join(appPath, "Contents", "Resources");
const unpackedDir = join(resourcesDir, "app.asar.unpacked");
const workerEntry = join(unpackedDir, "out", "worker", "research-worker.js");

console.log("[1] Worker 产物");
check("research-worker.js 存在于 asar 外（asarUnpack 生效）", () => {
  if (!existsSync(workerEntry)) {
    throw new Error(`缺失: ${workerEntry}`);
  }
  return `${(statSync(workerEntry).size / 1024).toFixed(0)} KB`;
});

check("pdfjs chunk 一并解包（否则运行期 dynamic import 会失败）", () => {
  const chunksDir = join(unpackedDir, "out", "worker", "chunks");
  if (!existsSync(chunksDir)) throw new Error("chunks/ 缺失");
  const pdfChunk = readdirSync(chunksDir).find((f) => f.startsWith("pdf-"));
  if (!pdfChunk) throw new Error("找不到 pdf-*.js chunk");
  return pdfChunk;
});

check("worker 产物不 require 任何第三方包（只允许 node 内建）", () => {
  const src = readFileSync(workerEntry, "utf8");
  const externals = [...src.matchAll(/require\("([^"]+)"\)/g)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith("node:") && !name.startsWith("./") && !name.startsWith("../"))
    // url / path 等无前缀内建也放行。
    .filter((name) => !["url", "path", "fs", "os", "crypto", "http", "https", "dns", "zlib", "stream", "buffer", "events", "util"].includes(name));
  if (externals.length > 0) {
    throw new Error(`残留外部依赖: ${[...new Set(externals)].join(", ")}`);
  }
  return "仅 node 内建";
});

console.log("\n[2] agent-browser（Browser 降级路径复用的既有二进制）");
check("二进制存在且可执行", () => {
  const bin = join(resourcesDir, "agent-browser", "agent-browser");
  if (!existsSync(bin)) throw new Error(`缺失: ${bin}`);
  const mode = statSync(bin).mode;
  if ((mode & 0o111) === 0) throw new Error("缺少可执行位");
  return `${(statSync(bin).size / 1024 / 1024).toFixed(1)} MB`;
});

console.log("\n[3] 密钥泄漏（spec §19.2.7：打包产物不得包含共享 Search API Key）");
check("产物内无硬编码的 Search Server 凭据", () => {
  // 只扫我们自己的产物，不扫整个 Resources（node_modules 里的测试固件会误报）。
  const targets = [workerEntry, join(resourcesDir, "app.asar")];
  // 这些字面量一旦出现在产物里，说明有人把凭据写死了。
  const forbidden = [
    "RESEARCH_SEARCH_HMAC_KEY=",
    "SEARXNG_BASE_URL=http",
  ];
  for (const target of targets) {
    if (!existsSync(target)) continue;
    const buf = readFileSync(target);
    for (const needle of forbidden) {
      if (buf.includes(needle)) throw new Error(`${target} 含 ${needle}`);
    }
  }
  return "未发现";
});

console.log("\n[4] 打包态 fork（U0 spike S7 的最后一环）");
check("从 app.asar.unpacked fork worker 并完成 hello/doctor 协议往返", () => {
  const electron = join(appDir, "..", "..", "node_modules", ".bin", "electron");
  const harness = join(appDir, "scripts", "research-worker-fork-probe.cjs");
  if (!existsSync(harness)) throw new Error(`探针缺失: ${harness}`);
  const out = execFileSync(electron, [harness, workerEntry], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  if (!out.includes("PACKAGED_FORK_OK")) {
    throw new Error(`协议往返失败:\n${out.slice(0, 800)}`);
  }
  const pdfOk = out.includes('"pdf_available":true');
  if (!pdfOk) notes.push("doctor 报告 pdf_available=false —— 打包态 pdfjs 未能加载");
  return pdfOk ? "hello + doctor 通过，pdf_available=true" : "hello + doctor 通过（但 pdf 不可用）";
});

console.log("");
for (const note of notes) console.log(`  ! ${note}`);

if (failures.length > 0) {
  console.error(`\n打包验证失败（${failures.length} 项）:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n全部通过。");
