#!/usr/bin/env node
// 把 apps/desktop/native/Cortex_Helper(Swift 可执行包)用 `swift build -c release` 编译成
// 单个原生二进制,产出到 apps/desktop/resources/Cortex_Helper/Cortex_Helper。
// Cortex 打包时经 electron-builder 的 extraResources 落到 <App>/Contents/Resources/Cortex_Helper/,
// 主进程 helper-client(U4)spawn 它。结构:幂等 stamp + 跨架构 + --force(沿用已删除的
// build-pi-binary.mjs 的同款套路)。
//
// 平台:reply 功能是 macOS 专属(AX / CGEventTap / Vision / EventKit),仅在 darwin 上构建;
// 非 darwin 直接跳过(prepackage:win-x64 不挂本脚本)。
//
// 架构:
//   node scripts/build-cortex-helper.mjs --arch arm64   (默认)
//   node scripts/build-cortex-helper.mjs --arch x64
// 强制重编:--force

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(here); // apps/desktop
const pkgDir = join(desktopRoot, "native/Cortex_Helper");
const outDir = join(desktopRoot, "resources/Cortex_Helper");
const binName = "Cortex_Helper";
const binPath = join(outDir, binName);
const stampPath = join(outDir, ".Cortex_Helper-version");

const log = (msg) => console.log(`[build-cortex-helper] ${msg}`);

// ── 平台守卫:仅 macOS 构建 ────────────────────────────────────────────────────
if (process.platform !== "darwin") {
  log(`当前平台 ${process.platform} 非 macOS,Cortex_Helper 为 macOS 专属,跳过。`);
  process.exit(0);
}

// ── CLI 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const targetArch = flagVal("--arch") ?? "arm64"; // arm64 | x64
const force = argv.includes("--force");
// Swift 用 x86_64 表示 x64
const swiftArch = targetArch === "x64" ? "x86_64" : "arm64";
const stampKey = swiftArch;

if (!existsSync(pkgDir)) {
  console.error(`[build-cortex-helper] 找不到 Swift 包: ${pkgDir}`);
  process.exit(1);
}

// ── 幂等 stamp:对 Package.swift + 全部 .swift 源码算内容哈希,叠加目标架构。
// 源码与架构都未变且二进制在,则跳过重编(dev / 反复打包不做无谓 swift build)。
function hashSources() {
  const hash = createHash("sha256");
  const files = [];
  hash.update(binName);
  hash.update(readFileSync(join(pkgDir, "Package.swift")));
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过 SwiftPM 构建缓存目录
        if (entry.name === ".build") continue;
        walk(full);
      } else if (entry.name.endsWith(".swift")) {
        files.push(full);
      }
    }
  };
  walk(pkgDir);
  files.sort();
  for (const f of files) {
    hash.update(f);
    hash.update(readFileSync(f));
  }
  return hash.digest("hex").slice(0, 16);
}

const sourceHash = hashSources();
const stamp = `${sourceHash}:${stampKey}`;

if (!force && existsSync(binPath) && existsSync(stampPath)) {
  if (readFileSync(stampPath, "utf-8").trim() === stamp) {
    log(`Cortex_Helper (${stampKey}) 已最新,跳过(--force 强制重编)。`);
    process.exit(0);
  }
}

// ── 编译 ──────────────────────────────────────────────────────────────────────
log(`编译 Cortex_Helper → ${binPath} (arch: ${swiftArch})`);
const swiftArgs = ["build", "-c", "release", "--arch", swiftArch, "--package-path", pkgDir];
execFileSync("swift", swiftArgs, { stdio: "inherit" });

// swift 把产物放在 arch 专属的 bin 目录;用 --show-bin-path 精确定位,避免猜路径
const binDir = execFileSync("swift", [...swiftArgs, "--show-bin-path"], { encoding: "utf-8" }).trim();
const builtBin = join(binDir, binName);
if (!existsSync(builtBin)) {
  console.error(`[build-cortex-helper] 编译产物缺失: ${builtBin}`);
  process.exit(1);
}

// ── 拷贝到 resources/Cortex_Helper ─────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(builtBin, binPath);
// 保底可执行位(cpSync 保留权限,这里再确认一次)
try { execFileSync("chmod", ["+x", binPath]); } catch { /* 忽略:cpSync 通常已带执行位 */ }

writeFileSync(stampPath, stamp);
const sizeKB = Math.round(statSync(binPath).size / 1024);
log(`完成: ${binPath} (${sizeKB} KB)`);
