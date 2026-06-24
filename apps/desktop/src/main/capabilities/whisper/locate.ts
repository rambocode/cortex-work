// whisper-cli 二进制定位（主进程）。
// 仿 apps/desktop/src/main/agents/pi-locate.ts，采用相同的「打包态 → dev 态 → env override」查找顺序。
//
// 二进制不进 asar 的原因：
//   whisper-cli 是原生可执行文件，asar 是虚拟只读归档；原生二进制必须以真实文件形式
//   落到磁盘才能被 child_process.spawn 执行。extraResources 路径直接落到
//   <App>/Contents/Resources/whisper/<platform>-<arch>/，不经 asar 打包。
//
// 查找顺序（与 pi-locate 对齐）：
//   1. 环境变量 CORTEX_WHISPER_CLI —— 开发者 / 测试覆盖（绝对路径）
//   2. 打包态: process.resourcesPath/whisper/darwin-arm64/whisper-cli
//   3. dev 态:  app.getAppPath()/resources/whisper/darwin-arm64/whisper-cli
//   4. 均未找到 → 抛出清晰错误（含期望路径，便于诊断）

import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

// v1 只支持 darwin-arm64；同步 prepare-whisper-runner.mjs 的平台目录命名。
const PLATFORM_ARCH = "darwin-arm64";

export interface WhisperRunnerLocation {
  /** whisper-cli 可执行文件绝对路径。*/
  command: string;
  /** spawn 的 cwd（whisper-cli 所在目录；部分版本从相对路径加载资源）。*/
  cwd: string;
  /** 追加给 spawn 的 env（darwin 不需要 LD_LIBRARY_PATH；linux 静态构建亦不需要）。*/
  env: Record<string, string>;
}

/**
 * 定位 whisper-cli 可执行文件。
 * @throws 若所有候选路径均不存在则抛出含路径列表的 Error，便于诊断。
 */
export function resolveWhisperRunner(): WhisperRunnerLocation {
  const candidates: string[] = [];

  // 1. 环境变量覆盖（开发 / CI 场景）
  if (process.env.CORTEX_WHISPER_CLI) {
    const envPath = process.env.CORTEX_WHISPER_CLI;
    candidates.push(envPath);
    if (existsSync(envPath)) {
      return { command: envPath, cwd: join(envPath, ".."), env: {} };
    }
  }

  // 2. 打包态：extraResources 落到 Contents/Resources/whisper/<platform>/
  const packedPath = join(process.resourcesPath, "whisper", PLATFORM_ARCH, "whisper-cli");
  candidates.push(packedPath);
  if (app.isPackaged && existsSync(packedPath)) {
    return { command: packedPath, cwd: join(packedPath, ".."), env: {} };
  }

  // 3. dev 态：prepare-whisper-runner.mjs 产出到 apps/desktop/resources/whisper/<platform>/
  const devPath = join(app.getAppPath(), "resources", "whisper", PLATFORM_ARCH, "whisper-cli");
  candidates.push(devPath);
  if (!app.isPackaged && existsSync(devPath)) {
    return { command: devPath, cwd: join(devPath, ".."), env: {} };
  }

  // 4. 兜底：当前工作目录（极少数本地直运行场景）
  const cwdPath = join(process.cwd(), "resources", "whisper", PLATFORM_ARCH, "whisper-cli");
  candidates.push(cwdPath);
  if (existsSync(cwdPath)) {
    return { command: cwdPath, cwd: join(cwdPath, ".."), env: {} };
  }

  throw new Error(
    `[resolveWhisperRunner] 找不到 whisper-cli 可执行文件。\n` +
    `已查找以下路径（均不存在）：\n${candidates.map((p) => `  ${p}`).join("\n")}\n` +
    `请先运行: node apps/desktop/scripts/prepare-whisper-runner.mjs`,
  );
}
