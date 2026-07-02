// electron-builder beforePack hook。
// ⚠️ electron-builder 只允许一个 beforePack 入口（见 electron-builder.yml）。
//    所有预打包准备逻辑在此集中，不要另立新 hook。
//
// 当前职责：
//   1. 调用 prepare-whisper-runner.mjs 构建 whisper-cli（仅 darwin-arm64）。
//   2. 删除非目标平台的 resources/whisper/* 目录，避免错误平台产物进打包。
//
// 注：本文件用 .cjs（CommonJS），因 electron-builder 以 require() 加载 beforePack。
//     prepare-whisper-runner.mjs 是 ESM，通过 child_process.execFileSync 调用 node。

const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
// 从 builder-util 直接导入 Arch 枚举,而不是硬编码数值——这个包的枚举顺序在不同大版本间
// 变过(当前 26.x 是 ia32=0/x64=1/armv7l=2/arm64=3/universal=4),之前这里硬编码"0=x64,1=arm64"
// 是过时/错误的映射,只是因为单架构(仅 arm64)流水线从未真正触发 x64 分支才没暴露:
// 该 bug 会导致 x64 目标被误判成 arm64,把 arm64 的 whisper-cli 错误打进 x64 包。
const { Arch } = require("builder-util");

/**
 * @param {import("electron-builder").PackagerContext} context
 */
exports.default = async function beforePack(context) {
  const desktopRoot = join(__dirname, ".."); // apps/desktop/
  const targetPlatform = context.packager.platform.name; // "mac" | "win" | "linux"
  const targetArch = context.arch;                       // Arch 枚举数值,含义见上方 require 处的说明

  // ⚠️ 当 archName 无法确定(如 universal 或未来新增的 arch),
  //    步骤 2 的 prune 绝不执行——宁可多打文件也不能删错源码目录(不可逆)。
  const archName = targetArch === Arch.arm64 ? "arm64" : targetArch === Arch.x64 ? "x64" : null;
  const platformName = targetPlatform === "mac" ? "darwin"
    : targetPlatform === "windows" ? "win32"
    : targetPlatform === "linux" ? "linux"
    : targetPlatform;

  const targetKey = archName ? `${platformName}-${archName}` : `${platformName}-<unknown-arch>`;

  console.log(`[before-pack] 目标平台: ${targetKey}`);

  // ── 步骤 1：构建 whisper-cli ─────────────────────────────────────────────
  // v1 仅 darwin-arm64：其他平台 prepare 脚本会报清晰错误并退出，beforePack 捕获后仅告警，
  // 不阻断打包（非 local-whisper 用户不应因此失败）。
  const prepareScript = join(desktopRoot, "scripts", "prepare-whisper-runner.mjs");
  if (existsSync(prepareScript)) {
    try {
      execFileSync(
        process.execPath, // 当前 node 可执行
        [prepareScript, "--platform", platformName, "--arch", archName],
        { stdio: "inherit", cwd: desktopRoot },
      );
    } catch (err) {
      if (platformName === "darwin" && archName === "arm64") {
        // darwin-arm64 构建失败是真实错误，阻断打包
        throw new Error(`[before-pack] whisper-cli 构建失败: ${err.message}`);
      }
      // 其他平台（v1 暂不支持）：告警不阻断
      console.warn(`[before-pack] ⚠ 跳过 whisper-cli 构建（${targetKey} 暂不支持）: ${err.message}`);
    }
  }

  // ── 步骤 2：剪裁非目标平台的 whisper runner 目录 ─────────────────────────
  // extraResources 把整个 resources/whisper/ 拷进产物；pruning 确保只有目标平台产物进包，
  // 避免 darwin-arm64 产物混进 darwin-x64 包（v2 多平台后更重要）。
  //
  // ⚠️ 破坏性警告：rmSync 删除的是源码树（resources/whisper/），而非构建产物。
  //   一旦误删将永久丢失二进制，git 恢复也需要重新构建。
  //   因此只在 archName 明确（arm64/x64）时才执行 prune；
  //   archName 为 null（universal 等其它 arch）时跳过，打印警告，宁可多带文件。
  if (archName === null) {
    console.warn(
      `[before-pack] ⚠ 无法确定目标 arch（targetArch=${targetArch}），` +
      `跳过 whisper 目录 prune，避免误删源码树。`,
    );
  } else {
    const whisperResDir = join(desktopRoot, "resources", "whisper");
    if (existsSync(whisperResDir)) {
      const subdirs = readdirSync(whisperResDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const dir of subdirs) {
        if (dir !== targetKey) {
          const fullPath = join(whisperResDir, dir);
          // 只删除已知精确路径（如 "darwin-x64"），不做模糊匹配。
          console.log(`[before-pack] 删除非目标平台目录: ${fullPath}`);
          rmSync(fullPath, { recursive: true, force: true });
        }
      }
    }
  }

  console.log(`[before-pack] 完成（${targetKey}）`);
};
