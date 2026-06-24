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

/**
 * @param {import("electron-builder").PackagerContext} context
 */
exports.default = async function beforePack(context) {
  const desktopRoot = join(__dirname, ".."); // apps/desktop/
  const targetPlatform = context.packager.platform.name; // "mac" | "win" | "linux"
  const targetArch = context.arch;                       // 0=x64, 1=arm64, 2=universal, ...

  // electron-builder Arch enum: 0=x64, 1=arm64
  // 参考：https://www.electron.build/api/electron-builder#arch
  const archName = targetArch === 1 ? "arm64" : targetArch === 0 ? "x64" : "unknown";
  const platformName = targetPlatform === "mac" ? "darwin"
    : targetPlatform === "windows" ? "win32"
    : targetPlatform === "linux" ? "linux"
    : targetPlatform;

  const targetKey = `${platformName}-${archName}`;

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
  const whisperResDir = join(desktopRoot, "resources", "whisper");
  if (existsSync(whisperResDir)) {
    const subdirs = readdirSync(whisperResDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const dir of subdirs) {
      if (dir !== targetKey) {
        const fullPath = join(whisperResDir, dir);
        console.log(`[before-pack] 删除非目标平台目录: ${fullPath}`);
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }

  console.log(`[before-pack] 完成（${targetKey}）`);
};
