#!/usr/bin/env node
// 构建 SenseVoiceSmall 常驻 sidecar，并把目标架构二进制放进 electron-builder resources。
//
// CMake 中间目录继续按 sourceRoot 绝对路径隔离，避免不同 git worktree 共享 CMakeCache.txt
// 后因 CMAKE_HOME_DIRECTORY 不同而互相毒化；最终二进制则按内容指纹发布到用户级共享缓存，
// 新 worktree 命中后只需复制约 1.6MB 产物，不再重复下载与编译 llama.cpp。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FUNASR_TAG = "runtime-llamacpp-v0.1.9";
const FUNASR_COMMIT = "9b918d74d7090b38211a6414c6ee08893a34afd4";
const LLAMA_COMMIT = "8086439a4cea94c71a5dfb8fe4ad1546aebd640f";
const SIDECAR_PROTOCOL = 1;
const CACHE_SCHEMA = 1;
const LOCK_WAIT_MS = 20 * 60 * 1000;
const LOCK_POLL_MS = 100;
const SUPPORTED_TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * @typedef {object} PrepareOptions
 * @property {string[]} [args] CLI 参数；缺省读取 process.argv。
 * @property {NodeJS.Platform} [hostPlatform] 当前主机平台；测试可注入。
 * @property {string} [hostArch] 当前主机架构；测试可注入。
 * @property {string} [desktopRoot] apps/desktop 根；测试用临时目录模拟不同 worktree。
 * @property {string} [sharedCacheRoot] 用户级共享产物缓存根。
 * @property {string} [buildCacheRoot] 仓库外 CMake 中间目录根。
 * @property {string} [toolchainSha256] 工具链摘要；测试注入后不执行版本探针。
 * @property {typeof execFileSync} [execFile] 外部命令执行器；测试用替身生成假二进制。
 * @property {(message: string) => void} [log] 日志出口。
 */

/**
 * 准备当前平台的 SenseVoice sidecar。
 *
 * 返回 status 便于测试与调用方观测：local 表示当前 worktree 已有；shared-cache 表示从共享缓存
 * 复制；built 表示本轮真实执行了 CMake。失败直接抛错，保持 dev/prepackage 原有失败语义。
 *
 * @param {PrepareOptions} [options]
 */
export function prepareSenseVoiceSidecar(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const hostPlatform = options.hostPlatform ?? process.platform;
  const hostArch = options.hostArch ?? process.arch;
  const platform = option("--platform", hostPlatform);
  const arch = option("--arch", hostArch);
  const force = args.includes("--force");
  const target = `${platform}-${arch}`;
  const log = options.log ?? console.log;
  const execFile = options.execFile ?? execFileSync;

  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`SenseVoice sidecar 不支持 ${target}；支持 darwin-arm64、darwin-x64、win32-x64`);
  }
  if (platform !== hostPlatform) {
    throw new Error(`不能在 ${hostPlatform} 主机直接构建 ${platform} sidecar，请使用对应平台的 CI runner`);
  }

  const scriptDesktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const desktopRoot = resolve(options.desktopRoot ?? scriptDesktopRoot);
  const sourceRoot = join(desktopRoot, "native", "sensevoice-sidecar");
  const executable = platform === "win32" ? "cortex-sensevoice-sidecar.exe" : "cortex-sensevoice-sidecar";
  const outputRoot = join(desktopRoot, "resources", "sensevoice", target);
  const output = join(outputRoot, executable);
  const marker = join(outputRoot, "runner.json");

  const sourceHashInput = [
    readFileSync(join(sourceRoot, "CMakeLists.txt"), "utf8"),
    readFileSync(join(sourceRoot, "sensevoice-sidecar.cpp"), "utf8"),
  ].join("\n");
  const sourceSha256 = sha256(sourceHashInput);
  const toolchainSha256 =
    options.toolchainSha256 ?? resolveToolchainSha256(execFile, platform, process.env);
  const artifactKey = sha256(
    JSON.stringify({
      cacheSchema: CACHE_SCHEMA,
      protocol: SIDECAR_PROTOCOL,
      target,
      funasrTag: FUNASR_TAG,
      funasrCommit: FUNASR_COMMIT,
      llamaCommit: LLAMA_COMMIT,
      sourceSha256,
      toolchainSha256,
    }),
  ).slice(0, 24);
  const expected = {
    protocol: SIDECAR_PROTOCOL,
    target,
    funasrTag: FUNASR_TAG,
    funasrCommit: FUNASR_COMMIT,
    llamaCommit: LLAMA_COMMIT,
    sourceSha256,
    cacheSchema: CACHE_SCHEMA,
    artifactKey,
    toolchainSha256,
  };

  const sharedCacheRoot = resolve(
    options.sharedCacheRoot ??
      process.env.CORTEX_SENSEVOICE_CACHE_DIR ??
      defaultSharedCacheRoot(platform, process.env),
  );
  const cacheEntry = join(sharedCacheRoot, target, artifactKey);
  const cachedOutput = join(cacheEntry, executable);
  const cachedMarker = join(cacheEntry, "runner.json");
  const cacheArtifact = { binary: cachedOutput, marker: cachedMarker };
  const localArtifact = { binary: output, marker };

  // 当前 worktree 已有合法产物时仍顺手发布到共享缓存。这样升级脚本后，主仓库里已经编好的
  // 旧产物能直接成为种子，不需要为了建立缓存再完整编译一次。
  if (!force && artifactMatches(localArtifact, expected, false)) {
    const metadata = completeMetadata(localArtifact.binary, expected);
    const releaseLock = acquireCacheLock(cacheEntry, () => artifactMatches(cacheArtifact, expected, true), log);
    if (releaseLock) {
      try {
        if (!artifactMatches(cacheArtifact, expected, true)) publishCache(localArtifact.binary, cacheEntry, executable, metadata);
      } finally {
        releaseLock();
      }
    }
    writeMarkerAtomic(marker, metadata);
    log(`[prepare-sensevoice-sidecar] 已是最新版本: ${output}`);
    return { status: "local", output, cacheEntry, artifactKey };
  }

  if (!force && artifactMatches(cacheArtifact, expected, true)) {
    materializeArtifact(cachedOutput, output, marker, readMarker(cachedMarker), platform);
    log(`[prepare-sensevoice-sidecar] 命中共享缓存: ${cachedOutput} -> ${output}`);
    return { status: "shared-cache", output, cacheEntry, artifactKey };
  }

  // 同一指纹只允许一个进程构建。其它 worktree 等待锁持有者发布产物后直接复用，避免并发启动时
  // 同时下载/编译两份 llama.cpp。--force 刻意不接受“等待后命中”作为完成，仍会重新构建。
  const releaseLock = acquireCacheLock(
    cacheEntry,
    () => !force && artifactMatches(cacheArtifact, expected, true),
    log,
  );
  if (!releaseLock) {
    materializeArtifact(cachedOutput, output, marker, readMarker(cachedMarker), platform);
    log(`[prepare-sensevoice-sidecar] 等待后命中共享缓存: ${cachedOutput} -> ${output}`);
    return { status: "shared-cache", output, cacheEntry, artifactKey };
  }

  try {
    // 拿锁前后的窗口里另一个进程可能已经发布；锁内再查一次，避免无意义重编译。
    if (!force && artifactMatches(cacheArtifact, expected, true)) {
      materializeArtifact(cachedOutput, output, marker, readMarker(cachedMarker), platform);
      log(`[prepare-sensevoice-sidecar] 命中共享缓存: ${cachedOutput} -> ${output}`);
      return { status: "shared-cache", output, cacheEntry, artifactKey };
    }

    // FetchContent 会带入 llama.cpp 自己的 TypeScript 测试，中间目录必须留在仓库外；目录名继续
    // 带 sourceRoot 路径哈希，保留不同 worktree 的 CMakeCache.txt 隔离。
    const sourceKey = sha256(sourceRoot).slice(0, 12);
    const buildCacheRoot = resolve(
      options.buildCacheRoot ?? join(tmpdir(), "cortex-sensevoice-sidecar"),
    );
    const buildRoot = join(buildCacheRoot, `${target}-${sourceKey}`);
    const cacheFile = join(buildRoot, "CMakeCache.txt");
    if (existsSync(cacheFile)) {
      const homeDir = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(readFileSync(cacheFile, "utf8"))?.[1]?.trim();
      if (homeDir && resolve(homeDir) !== resolve(sourceRoot)) {
        log(`[prepare-sensevoice-sidecar] 缓存源目录不匹配(${homeDir})，清理后重建: ${buildRoot}`);
        rmSync(buildRoot, { recursive: true, force: true });
      }
    }

    mkdirSync(buildRoot, { recursive: true });
    const configure = ["-S", sourceRoot, "-B", buildRoot, "-DCMAKE_BUILD_TYPE=Release"];
    if (platform === "darwin") configure.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === "arm64" ? "arm64" : "x86_64"}`);
    if (platform === "win32") configure.push("-A", "x64");
    execFile("cmake", configure, { stdio: "inherit", cwd: desktopRoot });
    execFile(
      "cmake",
      ["--build", buildRoot, "--config", "Release", "--target", "cortex-sensevoice-sidecar", "--parallel"],
      { stdio: "inherit", cwd: desktopRoot },
    );

    const candidates = [join(buildRoot, "bin", executable), join(buildRoot, "bin", "Release", executable)];
    const built = candidates.find(existsSync);
    if (!built) throw new Error(`构建完成但找不到 sidecar: ${candidates.join(", ")}`);
    const metadata = completeMetadata(built, expected);
    publishCache(built, cacheEntry, executable, metadata);
    materializeArtifact(cachedOutput, output, marker, metadata, platform);
    log(`[prepare-sensevoice-sidecar] 已生成: ${output}`);
    log(`[prepare-sensevoice-sidecar] 已写入共享缓存: ${cacheEntry}`);
    return { status: "built", output, cacheEntry, artifactKey };
  } finally {
    releaseLock();
  }
}

/** 当前用户的默认共享缓存目录；可用 CORTEX_SENSEVOICE_CACHE_DIR 覆盖。 */
function defaultSharedCacheRoot(platform, env) {
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "ai.cortex.work", "sensevoice-sidecar");
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Cortex", "Cache", "sensevoice-sidecar");
  }
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cortex-desktop", "sensevoice-sidecar");
}

/** 工具链变化时切换缓存桶，避免 Xcode/CMake 升级后继续复用旧 ABI 产物。 */
function resolveToolchainSha256(execFile, platform, env) {
  const probe = (command, args) => {
    try {
      return String(execFile(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
    } catch (error) {
      return `${command}:unavailable:${error instanceof Error ? error.name : "unknown"}`;
    }
  };
  const compiler = platform === "darwin" ? ["xcrun", ["clang", "--version"]] : [env.CXX || "c++", ["--version"]];
  return sha256(
    JSON.stringify({
      osRelease: release(),
      cmake: probe("cmake", ["--version"]),
      compiler: probe(compiler[0], compiler[1]),
      cc: env.CC ?? "",
      cxx: env.CXX ?? "",
      generator: env.CMAKE_GENERATOR ?? "",
      sdkRoot: env.SDKROOT ?? "",
      deploymentTarget: env.MACOSX_DEPLOYMENT_TARGET ?? "",
      visualStudioVersion: env.VisualStudioVersion ?? "",
    }),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readMarker(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** strict=false 兼容升级前没有 artifactKey/binarySha256 的 worktree 本地产物。 */
function artifactMatches(artifact, expected, strict) {
  if (!existsSync(artifact.binary) || !existsSync(artifact.marker)) return false;
  const metadata = readMarker(artifact.marker);
  if (!metadata) return false;
  for (const key of ["protocol", "target", "funasrTag", "funasrCommit", "llamaCommit", "sourceSha256"]) {
    if (metadata[key] !== expected[key]) return false;
  }
  // 新版 marker 已经声明了具体 artifactKey，就必须与当前工具链指纹一致；只有升级前完全没有
  // artifactKey 的旧 marker 才按源码元数据兼容并在本轮自动晋升。
  if (!strict && metadata.artifactKey !== undefined && metadata.artifactKey !== expected.artifactKey) return false;
  if (strict && (metadata.cacheSchema !== CACHE_SCHEMA || metadata.artifactKey !== expected.artifactKey)) return false;
  if (strict && typeof metadata.binarySha256 !== "string") return false;
  if (metadata.binarySha256 && fileSha256(artifact.binary) !== metadata.binarySha256) return false;
  return true;
}

function completeMetadata(binary, expected) {
  return { ...expected, binarySha256: fileSha256(binary) };
}

/** 把共享产物原子复制进当前 worktree，避免并发 dev 读到半截二进制或 marker。 */
function materializeArtifact(source, output, marker, metadata, platform) {
  if (!metadata) throw new Error(`SenseVoice 共享缓存 marker 损坏: ${marker}`);
  mkdirSync(dirname(output), { recursive: true });
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const outputTmp = `${output}${suffix}`;
  const markerTmp = `${marker}${suffix}`;
  try {
    copyFileSync(source, outputTmp);
    if (platform !== "win32") chmodSync(outputTmp, 0o755);
    writeFileSync(markerTmp, `${JSON.stringify(metadata, null, 2)}\n`);
    replaceFile(outputTmp, output);
    replaceFile(markerTmp, marker);
  } finally {
    rmSync(outputTmp, { force: true });
    rmSync(markerTmp, { force: true });
  }
}

function writeMarkerAtomic(marker, metadata) {
  mkdirSync(dirname(marker), { recursive: true });
  const temporary = `${marker}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`);
    replaceFile(temporary, marker);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Windows 不保证 rename 能覆盖既有文件；只对目标精确文件做兜底替换。 */
function replaceFile(temporary, target) {
  try {
    renameSync(temporary, target);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "EPERM"].includes(error.code))) {
      throw error;
    }
    rmSync(target, { force: true });
    renameSync(temporary, target);
  }
}

/** 锁内用临时目录完整写好，再 rename 发布；缓存消费者永远只看见完整目录。 */
function publishCache(source, cacheEntry, executable, metadata) {
  mkdirSync(dirname(cacheEntry), { recursive: true });
  const temporary = `${cacheEntry}.tmp-${process.pid}-${Date.now()}`;
  try {
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    copyFileSync(source, join(temporary, executable));
    if (metadata.target.startsWith("darwin-")) chmodSync(join(temporary, executable), 0o755);
    writeFileSync(join(temporary, "runner.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    rmSync(cacheEntry, { recursive: true, force: true });
    renameSync(temporary, cacheEntry);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * 获取单 artifact 锁。等待期间一旦 ready() 变真就返回 null，让调用方直接消费缓存。
 * owner PID 已退出时才清理；owner 文件尚未写完则给 5 秒宽限。只删除当前 fingerprint 的
 * 精确 `.lock` 目录，绝不清理整个共享缓存根。
 */
function acquireCacheLock(cacheEntry, ready, log) {
  mkdirSync(dirname(cacheEntry), { recursive: true });
  const lockPath = `${cacheEntry}.lock`;
  const startedAt = Date.now();
  let announced = false;
  for (;;) {
    if (ready()) return null;
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }

    if (!announced) {
      log(`[prepare-sensevoice-sidecar] 另一进程正在准备同一产物，等待共享缓存: ${cacheEntry}`);
      announced = true;
    }
    if (ready()) return null;
    if (lockIsAbandoned(lockPath)) {
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - startedAt > LOCK_WAIT_MS) {
      throw new Error(`等待 SenseVoice 共享缓存超时: ${lockPath}`);
    }
    Atomics.wait(SLEEP_BUFFER, 0, 0, LOCK_POLL_MS);
  }
}

function lockIsAbandoned(lockPath) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    const owner = readMarker(join(lockPath, "owner.json"));
    if (!owner || typeof owner.pid !== "number") return age > 5_000;
    try {
      process.kill(owner.pid, 0);
      // 活着的构建进程优先于纯时间判断；网络极慢时编译可能超过一小时，不能误删它的锁。
      return false;
    } catch (error) {
      return !(error && typeof error === "object" && "code" in error && error.code === "EPERM");
    }
  } catch {
    return false;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) prepareSenseVoiceSidecar();
