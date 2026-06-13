// 无头执行器：到点（或手动）无头调用 agent CLI 执行自动化的 prompt,聚合输出落
// 执行记录。复用 cli.ts 的 startAgentProcess/spawnEnvFor + agents/getAdapter,
// 但用【独立进程注册表 runningAutomations】—— 绝不进 cli.ts 的 running Map,
// 这样 window-all-closed 的 killAllCli() 不会误杀正在跑的定时任务。
//
// 与 cli:oneshot 同构（行缓冲 + text/result 聚合 + 末行 flush），但:
//   · 支持 pi 自定义通道（从持久化的 piSettings 解析,关窗后仍可用）;
//   · 长超时（默认 10min,agent 任务远超 oneshot 的 60s）;
//   · 启动后即返回 running run（不阻塞到执行完）,完成时经事件推送。

import { homedir } from "os";
import type { AgentProcess } from "../ipc/cli";
import { spawnEnvFor, startAgentProcess } from "../ipc/cli";
import { getAdapter } from "../agents";
import { writePiExtension } from "../agents/pi-providers";
import { getPersistedState } from "../ipc/store";
import type { AutomationMeta, AutomationRun, CliStartRequest } from "../ipc/types";
import { broadcastChanged, broadcastRunEvent } from "./events";
import { computeNextRun } from "./schedule-cron";
import { appendRun, loadAutomations, newRunId, patchAutomation, updateRun } from "./store";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 200_000;

// automationId → 进程。每个自动化同一时刻至多一个在跑（并发去重的依据）。
const runningAutomations = new Map<string, AgentProcess>();
// 启动中占位:从去重检查到进程注册之间隔着 await（appendRun / 解析 pi 通道）,
// 若不同步占位,scheduler 与 manual 几乎同时触发会双双越过检查、各起一个进程。
const pending = new Set<string>();

export function isAutomationRunning(automationId: string): boolean {
  return runningAutomations.has(automationId) || pending.has(automationId);
}

// 退出时统一终止所有正在跑的自动化进程（仅 before-quit 调用,关窗不调用）。
export function killAllAutomations(): void {
  for (const proc of runningAutomations.values()) proc.kill();
  runningAutomations.clear();
  pending.clear();
}

// 据 channelId 从持久化的 piSettings 取回完整通道,拍平成 CliStartRequest.piChannel。
async function resolvePiChannel(channelId: string): Promise<CliStartRequest["piChannel"] | null> {
  const state = await getPersistedState();
  const ch = state.piSettings?.channels.find((c) => c.id === channelId && c.enabled);
  if (!ch) return null;
  return {
    id: ch.id,
    baseUrl: ch.baseUrl,
    apiKey: ch.apiKey,
    models: ch.models.map((m) => ({ id: m.id, name: m.label })),
  };
}

function makeRun(meta: AutomationMeta, trigger: AutomationRun["trigger"]): AutomationRun {
  return {
    id: newRunId(),
    automationId: meta.id,
    startedAt: Date.now(),
    status: "running",
    trigger,
    agent: meta.agent,
    prompt: meta.prompt,
    output: "",
  };
}

// 收尾:持久化最终 run、更新 meta（上次/下次运行）、广播列表与运行事件。
// 同时解除启动占位（覆盖 set proc 之前就失败的早退路径）。
async function finalize(meta: AutomationMeta, run: AutomationRun): Promise<void> {
  pending.delete(meta.id);
  await updateRun(meta.id, run.id, run);
  const nextRunAt = meta.enabled ? (computeNextRun(meta.schedule, meta.timezone) ?? undefined) : undefined;
  await patchAutomation(meta.id, {
    lastRunAt: run.startedAt,
    lastStatus: run.status === "running" ? "error" : run.status,
    nextRunAt,
  });
  broadcastChanged(await loadAutomations());
  broadcastRunEvent({ automationId: meta.id, run, phase: "end" });
}

// 启动一次执行;返回初始（running / skipped / error）run,执行在后台进行,
// 完成时经 broadcastRunEvent({phase:"end"}) 推送最终结果。
export async function runAutomation(
  meta: AutomationMeta,
  trigger: AutomationRun["trigger"],
): Promise<AutomationRun> {
  // 并发去重:上轮还在跑（或正在启动）→ 记一条 skipped 终态,不重复启动。
  if (isAutomationRunning(meta.id)) {
    const skipped: AutomationRun = {
      ...makeRun(meta, trigger),
      status: "skipped",
      endedAt: Date.now(),
      error: "上次执行尚未结束,本次已跳过",
    };
    await appendRun(skipped);
    broadcastRunEvent({ automationId: meta.id, run: skipped, phase: "end" });
    return skipped;
  }
  // 同步占位,杜绝后续 await 期间的并发重入。
  pending.add(meta.id);

  const run = makeRun(meta, trigger);
  await appendRun(run);
  broadcastRunEvent({ automationId: meta.id, run: { ...run }, phase: "start" });

  const cwd = meta.cwd || homedir();

  // 整个启动序列（pi 通道解析/写 extension、buildArgs、spawn）都纳入 try:
  // writePiExtension 用同步 fs,磁盘满/权限错会抛 —— 必须经 finalize 解除 pending,
  // 否则该 automation 会永久卡在「运行中」假象,此后所有触发都被记 skipped。
  let proc: AgentProcess;
  try {
    let piChannel: CliStartRequest["piChannel"];
    let piExtensionPath: string | undefined;
    if (meta.agent === "pi" && meta.piChannelId) {
      const resolved = await resolvePiChannel(meta.piChannelId);
      if (!resolved) throw new Error(`pi 通道「${meta.piChannelId}」未配置或已禁用`);
      piChannel = resolved;
      piExtensionPath = writePiExtension({
        id: resolved.id,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        models: resolved.models,
      });
    }
    const req: CliStartRequest = {
      runId: run.id,
      sessionId: run.id,
      agent: meta.agent,
      cwd,
      prompt: meta.prompt,
      model: meta.model,
      effort: meta.effort,
      useOwnSkills: meta.useOwnSkills,
      piChannel,
      piExtensionPath,
    };
    const adapter = getAdapter(meta.agent);
    const { cmd, args } = adapter.buildArgs(req);
    proc = startAgentProcess(meta.agent, cmd, args, { cwd, env: spawnEnvFor(req) });
  } catch (err) {
    run.status = "error";
    run.error = err instanceof Error ? err.message : String(err);
    run.endedAt = Date.now();
    await finalize(meta, run);
    return run;
  }

  runningAutomations.set(meta.id, proc);
  pending.delete(meta.id); // 占位转移到 runningAutomations
  const adapter = getAdapter(meta.agent);

  let out = "";
  let resultText = "";
  let failed: string | null = null;
  let stderrTail = "";
  let timedOut = false;
  let settled = false;

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, DEFAULT_TIMEOUT_MS);

  const handleLine = (line: string) => {
    if (!line) return;
    const ev = adapter.parseLine(line);
    if (!ev) return;
    if (ev.type === "init") run.agentSessionId = ev.sessionId;
    else if (ev.type === "text") {
      if (out.length < MAX_OUTPUT) out += ev.delta;
    } else if (ev.type === "result") {
      if (!ev.ok) failed = ev.error ?? "执行失败";
      else if (ev.text) resultText = ev.text;
    }
  };

  let buffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  });

  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  const settle = (compute: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    runningAutomations.delete(meta.id);
    compute();
    run.endedAt = Date.now();
    run.output = (out || resultText).trim();
    void finalize(meta, run);
  };

  proc.onError((err) => {
    settle(() => {
      run.status = "error";
      run.error = err.message;
    });
  });

  proc.onExit((code) => {
    handleLine(buffer.trim()); // 冲刷无换行结尾的最后一行（pi 末行 message_end 在此）
    settle(() => {
      if (timedOut) {
        run.status = "timeout";
        run.error = `执行超过 ${Math.round(DEFAULT_TIMEOUT_MS / 60000)} 分钟,已终止`;
      } else if (failed) {
        run.status = "error";
        run.error = failed;
      } else if (code === 0) {
        run.status = "ok";
      } else {
        run.status = "error";
        run.error = stderrTail.trim() || `退出码 ${code}`;
      }
    });
  });

  return run;
}
