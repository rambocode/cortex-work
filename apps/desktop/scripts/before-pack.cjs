// electron-builder 唯一 beforePack hook：同步 Slides 运行时并构建目标平台 SenseVoice sidecar。
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { Arch } = require("builder-util");

/** @param {import("electron-builder").PackagerContext} context */
exports.default = async function beforePack(context) {
  const desktopRoot = join(__dirname, "..");
  const builderPlatform = context.packager.platform.name;
  const platform = builderPlatform === "mac" ? "darwin"
    : builderPlatform === "windows" ? "win32"
      : builderPlatform;
  const arch = context.arch === Arch.arm64 ? "arm64" : context.arch === Arch.x64 ? "x64" : null;
  if (!arch) throw new Error(`[before-pack] SenseVoice 不支持 electron-builder arch=${context.arch}`);

  execFileSync(process.execPath, [join(desktopRoot, "scripts", "sync-bento-runtime.mjs")], {
    stdio: "inherit", cwd: desktopRoot,
  });
  execFileSync(process.execPath, [
    join(desktopRoot, "scripts", "prepare-sensevoice-sidecar.mjs"),
    "--platform", platform,
    "--arch", arch,
  ], { stdio: "inherit", cwd: desktopRoot });
};
