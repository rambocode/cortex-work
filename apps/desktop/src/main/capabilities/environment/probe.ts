// 运行环境探测(主进程侧):在用户的登录 shell 里跑一次 snapshot.ts 的探测脚本,结果缓存在内存,
// 供三端(claude / codex / pi)会话启动时渲染成 <environment> 系统提示块。
//
// 为什么用登录 shell(`$SHELL -lc`):claude 与 codex 的命令工具都是 `-lc` 起的,探测结果要和它们
// 实际看到的环境一致。pi 的内置 bash 用 `/bin/bash -c` + 主进程 env,PATH 经 `ensureProcessPath()`
// 已补齐 homebrew / nvm 等目录,与登录 shell 的差异在探测清单的粒度上可忽略。
//
// 为什么不阻塞会话启动:探测要起子进程跑 python,慢的机器上要 1~3 秒。故 app 启动时后台预热,
// 会话开启时只读缓存——没缓存就不注入(下一个会话生效),与 knowledge 能力块的策略同款。

import { spawn } from "child_process";

import { createLogger } from "../../log";
import { buildProbeScript, parseProbeOutput, renderEnvironmentBlock, type EnvironmentSnapshot } from "./snapshot";

const log = createLogger("environment");

// 探测超时:整段脚本正常 <2s;超时就用已经拿到的部分输出解析,不整体作废。
const PROBE_TIMEOUT_MS = 15_000;
// 快照有效期:用户中途装了包/工具,最晚半小时后新会话能看到。不做更短——每次换快照都会让
// 供应商 prompt 缓存前缀失效一次。
const SNAPSHOT_TTL_MS = 30 * 60_000;

let cached: EnvironmentSnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<EnvironmentSnapshot | null> | null = null;

/** 用户登录 shell;SHELL 未设置时退到 /bin/sh(脚本本身是 POSIX sh 兼容写法)。 */
function loginShell(): string {
  return process.env.SHELL || "/bin/sh";
}

/**
 * 起登录 shell 跑探测脚本,返回解析后的快照。任何失败(起不来 / 超时无输出)返回 null,
 * 由调用方决定是否保留旧缓存。
 */
export function probeEnvironment(): Promise<EnvironmentSnapshot | null> {
  // 探测脚本是 POSIX sh 写法,Windows 上跑不了;当前桌面端只发 macOS,直接不注入而不是给出错误信息。
  if (process.platform === "win32") return Promise.resolve(null);

  const base = { platform: process.platform, arch: process.arch, shell: loginShell() };
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok && !stdout.trim()) {
        log.warn("环境探测失败", { reason });
        resolve(null);
        return;
      }
      if (!ok) log.warn("环境探测未正常结束,按部分输出解析", { reason });
      resolve(parseProbeOutput(stdout, base));
    };
    let child: ReturnType<typeof spawn>;
    try {
      // env 用 process.env:启动期 ensureProcessPath() 已把补齐的 PATH 写回,这里与 spawnEnvFor() 等价,
      // 不 import ipc/cli.ts 是为了避免 cli.ts ⇄ 本文件的循环依赖。
      child = spawn(base.shell, ["-lc", buildProbeScript()], {
        env: process.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false, "timeout");
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(false, err.message));
    child.on("close", (code) => finish(code === 0, `exit ${code}`));
  });
}

/** 后台预热 / 刷新快照;并发调用共享同一次探测。失败时保留旧缓存(有旧值总比没有好)。 */
export function primeEnvironmentSnapshot(): Promise<EnvironmentSnapshot | null> {
  if (inflight) return inflight;
  inflight = probeEnvironment()
    .then((snapshot) => {
      if (snapshot) {
        cached = snapshot;
        cachedAt = Date.now();
        log.info("环境快照已更新", {
          python: snapshot.pythonVersion,
          modules: snapshot.pythonModules.length,
          node: snapshot.nodeVersion,
          tools: snapshot.cliTools.length,
        });
      }
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 当前缓存的快照(可能为 null)。过期时顺手触发后台刷新,本次仍返回旧值。
 * 刻意**不**在无缓存时发起探测:预热由启动期 `primeEnvironmentSnapshot()` 负责,读路径若也会起子进程,
 * 单测里凡是经过 cli.ts / pi-session.ts 的用例都会真的 spawn 一个登录 shell。
 */
export function getEnvironmentSnapshot(): EnvironmentSnapshot | null {
  if (cached && Date.now() - cachedAt > SNAPSHOT_TTL_MS) void primeEnvironmentSnapshot();
  return cached;
}

/**
 * 注入系统提示用的 <environment> 块。无缓存返回空串(不阻塞会话启动,后台预热,下个会话生效)。
 * 三端注入点:`ipc/cli.ts`(claude / codex / pi 单发)与 `ipc/pi-session.ts`(pi 聊天会话)。
 */
export function buildEnvironmentSystemPromptBlock(): string {
  const snapshot = getEnvironmentSnapshot();
  return snapshot ? renderEnvironmentBlock(snapshot) : "";
}

/** 仅测试用:清空缓存与在途探测。 */
export function resetEnvironmentSnapshotForTests(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}
