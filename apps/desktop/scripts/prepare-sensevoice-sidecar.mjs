#!/usr/bin/env node
// 构建 SenseVoiceSmall 常驻 sidecar，并把目标架构二进制放进 electron-builder resources。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const FUNASR_TAG = "runtime-llamacpp-v0.1.9";
const FUNASR_COMMIT = "9b918d74d7090b38211a6414c6ee08893a34afd4";
const LLAMA_COMMIT = "8086439a4cea94c71a5dfb8fe4ad1546aebd640f";
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const platform = option("--platform", process.platform);
const arch = option("--arch", process.arch);
const force = args.includes("--force");
const supported = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);
const target = `${platform}-${arch}`;
if (!supported.has(target)) {
  throw new Error(`SenseVoice sidecar 不支持 ${target}；支持 darwin-arm64、darwin-x64、win32-x64`);
}
if (platform !== process.platform) {
  throw new Error(`不能在 ${process.platform} 主机直接构建 ${platform} sidecar，请使用对应平台的 CI runner`);
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(desktopRoot, "native", "sensevoice-sidecar");
// FetchContent 会带入 llama.cpp 自己的 TypeScript 测试；缓存必须在仓库外，否则 Vitest 会
// 把这些上游文件误收集为桌面测试。CMake 会按 source 变化自行增量配置。
const buildRoot = join(tmpdir(), "cortex-sensevoice-sidecar", target);
const outputRoot = join(desktopRoot, "resources", "sensevoice", target);
const executable = platform === "win32" ? "cortex-sensevoice-sidecar.exe" : "cortex-sensevoice-sidecar";
const output = join(outputRoot, executable);
const marker = join(outputRoot, "runner.json");
const sourceHashInput = [
  readFileSync(join(sourceRoot, "CMakeLists.txt"), "utf8"),
  readFileSync(join(sourceRoot, "sensevoice-sidecar.cpp"), "utf8"),
].join("\n");
const { createHash } = await import("node:crypto");
const sourceSha256 = createHash("sha256").update(sourceHashInput).digest("hex");
if (!force && existsSync(output) && existsSync(marker)) {
  const metadata = JSON.parse(readFileSync(marker, "utf8"));
  if (metadata.sourceSha256 === sourceSha256) {
    console.log(`[prepare-sensevoice-sidecar] 已是最新版本: ${output}`);
    process.exit(0);
  }
}

mkdirSync(buildRoot, { recursive: true });
const configure = ["-S", sourceRoot, "-B", buildRoot, "-DCMAKE_BUILD_TYPE=Release"];
if (platform === "darwin") configure.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === "arm64" ? "arm64" : "x86_64"}`);
if (platform === "win32") configure.push("-A", "x64");
execFileSync("cmake", configure, { stdio: "inherit", cwd: desktopRoot });
execFileSync("cmake", ["--build", buildRoot, "--config", "Release", "--target", "cortex-sensevoice-sidecar", "--parallel"], {
  stdio: "inherit",
  cwd: desktopRoot,
});

const candidates = [join(buildRoot, "bin", executable), join(buildRoot, "bin", "Release", executable)];
const built = candidates.find(existsSync);
if (!built) throw new Error(`构建完成但找不到 sidecar: ${candidates.join(", ")}`);
mkdirSync(outputRoot, { recursive: true });
copyFileSync(built, output);
if (platform !== "win32") execFileSync("chmod", ["755", output]);
writeFileSync(marker, `${JSON.stringify({
  protocol: 1,
  target,
  funasrTag: FUNASR_TAG,
  funasrCommit: FUNASR_COMMIT,
  llamaCommit: LLAMA_COMMIT,
  sourceSha256,
}, null, 2)}\n`);
console.log(`[prepare-sensevoice-sidecar] 已生成: ${output}`);
