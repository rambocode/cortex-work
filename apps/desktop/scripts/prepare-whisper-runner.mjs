#!/usr/bin/env node
// 构建本地 Whisper CLI runner，产出到 resources/whisper/<platform>-<arch>/。
//
// v1 仅支持 darwin-arm64（macOS Apple Silicon）：
//   - 其它平台报清晰错误，不尝试构建。
//   - 原因：whisper.cpp cmake 静态构建的跨平台工具链配置复杂；
//     v1 先在目标用户群（MacBook M 系列）验证功能，再逐步扩展平台。
//
// 构建结果：
//   resources/whisper/darwin-arm64/whisper-cli  （可执行文件，chmod 755）
//   resources/whisper/darwin-arm64/runner.json  （版本标记，幂等跳过依据）
//
// 幂等：runner.json 版本与目标版本一致且二进制存在则跳过，--force 强制重建。
//
// 用法：
//   node scripts/prepare-whisper-runner.mjs [--platform darwin] [--arch arm64] [--force]
//
// 依赖：git、cmake（≥3.16）。构建约 5-10 分钟。CI 应在打包步前调用此脚本。

import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ── 目标版本 ──────────────────────────────────────────────────────────────────
// whisper.cpp v1.9.x 稳定分支；与 Kun 对齐，保证 GGML 权重格式兼容。
const WHISPER_CPP_TAG = "v1.9.2";
const WHISPER_CPP_REPO = "https://github.com/ggerganov/whisper.cpp.git";

// ── 路径 ──────────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(here); // apps/desktop

// ── CLI 参数解析 ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const platform = args.find((a, i) => args[i - 1] === "--platform") ?? process.platform;
const arch = args.find((a, i) => args[i - 1] === "--arch") ?? process.arch;
const force = args.includes("--force");

const log = (msg) => console.log(`[prepare-whisper-runner] ${msg}`);
const die = (msg) => { console.error(`[prepare-whisper-runner] 错误: ${msg}`); process.exit(1); };

// ── v1 平台检查：仅支持 darwin-arm64 ─────────────────────────────────────────
if (platform !== "darwin" || arch !== "arm64") {
  die(
    `v1 本地 Whisper runner 仅支持 darwin-arm64（macOS Apple Silicon）。\n` +
    `  当前目标: ${platform}-${arch}\n` +
    `  其它平台（darwin-x64、linux-*、win32-*）将在后续版本支持。\n` +
    `  如需跳过本地构建，可在打包时省略 prepare-whisper-runner 步骤（届时 local-whisper 协议将不可用）。`,
  );
}

const platformKey = `${platform}-${arch}`;
const outDir = join(desktopRoot, "resources", "whisper", platformKey);
const binPath = join(outDir, "whisper-cli");
const stampPath = join(outDir, "runner.json");

// ── 幂等检查 ──────────────────────────────────────────────────────────────────
if (!force && existsSync(binPath) && existsSync(stampPath)) {
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf-8"));
    if (stamp.version === WHISPER_CPP_TAG) {
      log(`whisper-cli ${WHISPER_CPP_TAG} 已存在（${binPath}），跳过构建。使用 --force 强制重建。`);
      process.exit(0);
    }
  } catch {
    // stamp 损坏，继续重建
  }
}

// ── 检测依赖工具 ──────────────────────────────────────────────────────────────
function checkCmd(cmd, hint) {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
  } catch {
    die(`未找到 ${cmd}。${hint}`);
  }
}
checkCmd("git", "请安装 Xcode Command Line Tools：xcode-select --install");
checkCmd("cmake", "请安装 cmake：brew install cmake");

// ── 临时构建目录 ──────────────────────────────────────────────────────────────
const tmpBase = join(tmpdir(), `whisper-build-${randomBytes(4).toString("hex")}`);
const srcDir = join(tmpBase, "whisper.cpp");
const buildDir = join(tmpBase, "build");

try {
  mkdirSync(tmpBase, { recursive: true });

  // ── git clone（浅克隆指定 tag） ───────────────────────────────────────────
  log(`克隆 whisper.cpp ${WHISPER_CPP_TAG}…`);
  execFileSync(
    "git",
    ["clone", "--depth", "1", "--branch", WHISPER_CPP_TAG, WHISPER_CPP_REPO, srcDir],
    { stdio: "inherit" },
  );

  // ── cmake configure ───────────────────────────────────────────────────────
  // darwin-arm64 静态构建参数：
  //   -DBUILD_SHARED_LIBS=OFF     → 静态链接，产出不依赖 .dylib（便于 extraResources 独立部署）
  //   -DWHISPER_BUILD_TESTS=OFF   → 跳过测试可执行文件，节省构建时间
  //   -DWHISPER_BUILD_SERVER=OFF  → 跳过 whisper-server（只需 whisper-cli）
  //   -DCMAKE_OSX_ARCHITECTURES=arm64  → 明确锁定 arm64（Mac 上可能有 universal 环境）
  //   -DGGML_NATIVE=OFF           → 不用 -march=native，保持 arm64 通用性（避免过度优化绑定 CPU）
  log(`cmake 配置（${platformKey}）…`);
  mkdirSync(buildDir, { recursive: true });
  execFileSync(
    "cmake",
    [
      srcDir,
      "-B", buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_SHARED_LIBS=OFF",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_BUILD_SERVER=OFF",
      "-DCMAKE_OSX_ARCHITECTURES=arm64",
      "-DGGML_NATIVE=OFF",
    ],
    { stdio: "inherit" },
  );

  // ── cmake build ───────────────────────────────────────────────────────────
  const cpuCount = (() => {
    try { return parseInt(execSync("sysctl -n hw.logicalcpu", { stdio: "pipe" }).toString().trim(), 10) || 4; }
    catch { return 4; }
  })();
  log(`cmake 构建（-j${cpuCount}）…`);
  execFileSync(
    "cmake",
    ["--build", buildDir, "--config", "Release", "-j", String(cpuCount), "--target", "whisper-cli"],
    { stdio: "inherit" },
  );

  // ── 拷贝产物 ──────────────────────────────────────────────────────────────
  // whisper-cli 在构建目录的 bin/ 子目录下（cmake 约定）
  const builtBin = join(buildDir, "bin", "whisper-cli");
  if (!existsSync(builtBin)) {
    // 兼容部分版本产物直接在 buildDir 根
    const altBin = join(buildDir, "whisper-cli");
    if (!existsSync(altBin)) {
      die(`构建完成但找不到 whisper-cli（已查: ${builtBin}, ${altBin}）`);
    }
    // use altBin
    mkdirSync(outDir, { recursive: true });
    execFileSync("cp", [altBin, binPath]);
  } else {
    mkdirSync(outDir, { recursive: true });
    execFileSync("cp", [builtBin, binPath]);
  }

  // ── 权限 + stamp ──────────────────────────────────────────────────────────
  chmodSync(binPath, 0o755);
  writeFileSync(
    stampPath,
    JSON.stringify({ version: WHISPER_CPP_TAG, platform, arch, builtAt: new Date().toISOString() }, null, 2),
  );

  log(`完成: ${binPath}`);
} finally {
  // ── 清理临时目录 ──────────────────────────────────────────────────────────
  rmSync(tmpBase, { recursive: true, force: true });
}
