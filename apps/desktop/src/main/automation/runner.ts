// 无头执行器：到点（或手动）无头调用 agent CLI 执行自动化的 prompt,聚合输出落
// 执行记录。复用 cli.ts 的 startAgentProcess/spawnEnvFor + agents/getAgentDef,
// 但用【独立进程注册表 runningAutomations】—— 绝不进 cli.ts 的 running Map,
// 这样 window-all-closed 的 killAllCli() 不会误杀正在跑的定时任务。
//
// 与 cli:oneshot 同构（行缓冲 + text/result 聚合 + 末行 flush），但:
//   · 支持 pi 自定义供应商（从持久化的 providerSettings 解析,关窗后仍可用）;
//   · 长超时（默认 10min,agent 任务远超 oneshot 的 60s）;
//   · 启动后即返回 running run（不阻塞到执行完）,完成时经事件推送。

import { homedir } from "os";
import type { AgentProcess } from "../ipc/cli";
import { assertSpawnCwd, detectAgents, spawnEnvForDef, startAgentProcess } from "../ipc/cli";
import { getAgentDef, parseLineEvents } from "../agents";
import { CODEX_MCP_CLEAR } from "../ipc/mcp-config";
import { writePiExtension } from "../agents/pi-providers";
import { resolvePiProviderInput } from "../providers/pi-provider-input";
import { getWorkspaceRoot } from "../ipc/store";
import type { AutomationMeta, AutomationRun, CliStartRequest } from "../ipc/types";
import { broadcastChanged, broadcastRunEvent } from "./events";
import { computeNextRun } from "./schedule-cron";
import { dispatchAutomationPush, isTerminalPushStatus, resolveNotifyChannels } from "./push-on-complete";
import { recordNotification } from "../ipc/notification-center";
import { NOTIFICATION_BODY_MAX } from "../ipc/notification-center-store";
import { appendRun, loadAutomations, newRunId, patchAutomation, updateRun } from "./store";
import { createLogger } from "../log";

const log = createLogger("automation-runner");

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

// 据 providerId 解析出 pi extension 所需的 provider（endpoint + 密钥）。
//
// 阶段③ 收编：来源改为「Catalog + provider-prefs + 凭据金库」（resolvePiProviderInput）。
// 旧实现读 PersistedState.providerSettings —— §5 首启即删除该字段，继续读它会让**每一次**
// 定时自动化都解析不到 provider 而失败，且失败点在后台、用户不在场。
async function resolveProvider(providerId: string): Promise<CliStartRequest["provider"] | null> {
  return (await resolvePiProviderInput(providerId)) ?? null;
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
  // once 任务触发后即生命周期结束:computeNextRun 对过期 once 已返回 null(nextRunAt 归空),
  // 此处再显式置 enabled:false,让列表明确呈现「已完成/已暂停」,而非「启用却无下次」的歧义态。
  const onceDone = meta.schedule.kind === "once";
  await patchAutomation(meta.id, {
    lastRunAt: run.startedAt,
    lastStatus: run.status === "running" ? "error" : run.status,
    nextRunAt,
    ...(onceDone ? { enabled: false } : {}),
  });
  broadcastChanged(await loadAutomations());
  broadcastRunEvent({ automationId: meta.id, run, phase: "end" });
  // 收尾埋点(info)：终态可观测,无头任务平时无声,这条是排查「跑没跑/什么结果」的锚点。
  log.info(`finalize id=${meta.id} agent=${meta.agent} status=${run.status} runId=${run.id}`);
  // 消息中心存档(无条件):只要是终态就记一条,**不受下面 opt-in 渠道开关约束**。
  // 两者是不同维度——渠道开关决定「要不要现在打扰你」,存档决定「事后能不能翻到」。
  // 无头执行时主窗常常没开,这条历史往往是用户唯一的结果来源。
  if (isTerminalPushStatus(run.status)) {
    const ok = run.status === "ok";
    recordNotification({
      source: "automation",
      level: ok ? "success" : "error",
      title: ok ? `${meta.name} 执行完成` : `${meta.name} 执行失败`,
      body: ((ok ? run.output : run.error) ?? "").trim().slice(0, NOTIFICATION_BODY_MAX) || undefined,
      refId: meta.id,
    });
  }
  // 完成后通知(opt-in):选中了渠道且终态(ok/error/timeout/killed)才分发。
  // fire-and-forget —— dispatchAutomationPush 内部已吞错,绝不影响 run 收尾。
  if (isTerminalPushStatus(run.status) && resolveNotifyChannels(meta).length > 0) {
    void dispatchAutomationPush(meta, run);
  }
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

  // 启动埋点(debug)：标记一次执行的开始,与 finalize 配对界定单次 run 的时间窗。
  log.debug(`start id=${meta.id} agent=${meta.agent} trigger=${trigger}`);

  const run = makeRun(meta, trigger);
  await appendRun(run);
  broadcastRunEvent({ automationId: meta.id, run: { ...run }, phase: "start" });

  // 未指定项目 cwd 时以默认工作目录（通用设置）兜底,再退回主目录。
  const cwd = meta.cwd || (await getWorkspaceRoot()) || homedir();

  const agentsAvailable = await detectAgents();
  if (meta.agent !== "pi" && agentsAvailable[meta.agent] === false) {
    run.status = "error";
    run.error = `${meta.agent === "claude" ? "Claude Code" : "Codex"} 未安装或不可用。请安装后重启 Cortex Desktop,或切换到 Pi。`;
    run.endedAt = Date.now();
    log.error(`${meta.agent} unavailable for ${meta.id}: ${run.error}`);
    await finalize(meta, run);
    return run;
  }

  // 整个启动序列（pi provider 解析/写 extension、buildArgs、spawn）都纳入 try:
  // writePiExtension 用同步 fs,磁盘满/权限错会抛 —— 必须经 finalize 解除 pending,
  // 否则该 automation 会永久卡在「运行中」假象,此后所有触发都被记 skipped。
  let proc: AgentProcess;
  try {
    let provider: CliStartRequest["provider"];
    let piExtensionPath: string | undefined;
    // 兼容旧自动化档：providerId（新）回退 piChannelId（旧）。
    const automationProviderId = meta.providerId ?? (meta as { piChannelId?: string }).piChannelId;
    if (meta.agent === "pi" && automationProviderId) {
      const resolved = await resolveProvider(automationProviderId);
      if (!resolved) throw new Error(`pi 供应商「${automationProviderId}」未配置或已禁用`);
      provider = resolved;
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
      provider,
      piExtensionPath,
    };
    const adapter = getAgentDef(meta.agent);
    const { cmd, args, stdin } = adapter.buildArgs(req, CODEX_MCP_CLEAR); // 自动化后台批跑:codex 清空 MCP(沿用 M1);claude/pi 忽略
    assertSpawnCwd(cwd);
    proc = startAgentProcess(cmd, args, { cwd, env: spawnEnvForDef(req, adapter), stdin });
  } catch (err) {
    run.status = "error";
    run.error = err instanceof Error ? err.message : String(err);
    log.error(`${meta.agent} launch failed for ${meta.id}: ${run.error}`);
    run.endedAt = Date.now();
    await finalize(meta, run);
    return run;
  }

  runningAutomations.set(meta.id, proc);
  pending.delete(meta.id); // 占位转移到 runningAutomations
  const adapter = getAgentDef(meta.agent);

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
    // 一行可解析出多个事件(如 usage + result);逐个处理。本通道只关心 init/text/result,
    // usage 等其它事件忽略(自动化只需最终文本与会话 id)。
    for (const ev of parseLineEvents(adapter, line)) {
      if (ev.type === "init") run.agentSessionId = ev.sessionId;
      else if (ev.type === "text") {
        if (out.length < MAX_OUTPUT) out += ev.delta;
      } else if (ev.type === "result") {
        if (!ev.ok) failed = ev.error ?? "执行失败";
        else if (ev.text) resultText = ev.text;
      }
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
      log.error(`${meta.agent} spawn failed for ${meta.id}: ${err.message}`);
    });
  });

  proc.onExit((code) => {
    handleLine(buffer.trim()); // 冲刷无换行结尾的最后一行（pi 末行 message_end 在此）
    settle(() => {
      if (timedOut) {
        run.status = "timeout";
        run.error = `执行超过 ${Math.round(DEFAULT_TIMEOUT_MS / 60000)} 分钟,已终止`;
        // 超时是无头任务最隐蔽的失败模式(看门狗 10min 后强杀),warn 单列便于排查。
        log.warn(`${meta.agent} timeout for ${meta.id}: ${run.error}`);
      } else if (failed) {
        run.status = "error";
        run.error = failed;
        log.error(`${meta.agent} failed for ${meta.id}: ${failed}`);
      } else if (code === 0) {
        run.status = "ok";
      } else {
        run.status = "error";
        run.error = stderrTail.trim() || `退出码 ${code}`;
        log.error(`${meta.agent} exited with code ${code} for ${meta.id}: ${run.error}`);
      }
    });
  });

  return run;
}
