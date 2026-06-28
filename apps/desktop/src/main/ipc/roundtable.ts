// 圆桌编排器（个人工作区 chat 多角色 @mention 调度）。
//
// 架构说明（KTD4）：
//   与 orchestrate.ts（三段编排）概念相似但有意独立：圆桌是多角色 BFS 调度，不是固定三段链路。
//   二者共享 cli.ts 三原语（startAgentProcess / pipeStdoutLines / parseLineEvents），
//   但进程注册表、IPC channel、取消通道均隔离——防止未来误合并。
//
// 进程注册表隔离（对齐 orchestrate.ts KTD5）：
//   圆桌子进程注册到本模块 roundtableProcs（独立 Set），不进 cli.ts running Map。
//   cli:kill 对圆桌子进程无效；取消走 roundtable:kill → AbortController.abort()。
//
// 事件路由：
//   各角色事件加 roleId 字段后经 cli:event 推渲染端（复用通道，区分标注）。
//   中间角色的 result 事件不转发（防触发渲染端 finalizeRun）。
//   全部角色完成后推一次合成 result(ok:true) + cli:exit。
//
// 失败隔离（R12 / KTD8）：
//   角色 B 失败（超时/非零退出）→ 推 result(ok:false, roleId:B) → 后续角色继续执行。

import { ipcMain } from "electron";
import { randomUUID } from "crypto";
import type { AgentProcess } from "./cli";
import {
  assertSpawnCwd,
  pipeStdoutLines,
  spawnEnvForDef,
  startAgentProcess,
} from "./cli";
import { getAgentDef, parseLineEvents } from "../agents";
import { CODEX_MCP_CLEAR } from "./mcp-config";
import { recordAgentTrace } from "./agent-trace";
import type { CliExitEvent, CliStartRequest, CliStreamEvent, RoleConfig, RoundtableStartRequest } from "./types";

// ── 常量 ──

// 每角色超时：子 agent 可能有长工具链，对齐 orchestrate.ts 子 agent 段 30 分钟。
const ROLE_TIMEOUT_MS = 30 * 60_000;
// 单角色输出文本上限（防内存膨胀）。
const MAX_ROLE_OUTPUT = 200_000;
// BFS 深度上限：用户消息中的 @mention 为 depth 0，角色输出中的 @mention depth+1。
const MAX_DEPTH = 3;
// 单轮内每角色最多出现次数（防循环 A→B→A→B…）。
const MAX_VISITS_PER_ROLE = 2;

// ── 独立进程注册表 ──

const activeRoundtables = new Map<string, AbortController>();
const roundtableProcs = new Set<AgentProcess>();

export function killAllRoundtables(): void {
  for (const controller of activeRoundtables.values()) {
    controller.abort();
  }
  activeRoundtables.clear();
  for (const proc of roundtableProcs) {
    proc.kill();
  }
  roundtableProcs.clear();
}

// ── BFS 队列项 ──

interface QueueItem {
  role: RoleConfig;
  depth: number;
  triggeredBy?: string; // 触发源角色 id
}

// ── 单角色执行 ──

interface RoleRunResult {
  text: string;
  ok: boolean;
  error?: string;
}

// 构造角色执行上下文：[角色 system prompt] + [用户消息] + [已响应角色文本]
function buildRoleContext(
  role: RoleConfig,
  text: string,
  turnAccumulator: Array<{ roleId: string; roleLabel: string; text: string }>,
): string {
  const parts: string[] = [];

  if (role.systemPrompt) {
    parts.push(`[系统指令] ${role.systemPrompt}`);
  }

  parts.push(`[用户消息] ${text}`);

  if (turnAccumulator.length > 0) {
    parts.push("[本轮已有角色回复]");
    for (const entry of turnAccumulator) {
      parts.push(`<${entry.roleLabel}>: ${entry.text}`);
    }
  }

  return parts.join("\n\n");
}

async function runRole(opts: {
  role: RoleConfig;
  text: string;
  cwd: string;
  turnAccumulator: Array<{ roleId: string; roleLabel: string; text: string }>;
  model?: string;
  effort?: string;
  permissionMode?: string;
  approvalPolicy?: string;
  appendSystemPrompt?: string;
  signal: AbortSignal;
  onEvent: (ev: CliStreamEvent) => void;
}): Promise<RoleRunResult> {
  const { role, text, cwd, turnAccumulator, model, effort, permissionMode, approvalPolicy, appendSystemPrompt, signal, onEvent } = opts;

  if (signal.aborted) {
    return { text: "", ok: false, error: "已取消" };
  }

  const adapter = getAgentDef(role.agent);
  const spawnKey = randomUUID();
  const context = buildRoleContext(role, text, turnAccumulator);

  const req: CliStartRequest = {
    runId: spawnKey,
    sessionId: spawnKey,
    agent: role.agent,
    cwd,
    prompt: context,
    model: model ?? undefined,
    effort: effort as CliStartRequest["effort"],
    permissionMode: permissionMode as CliStartRequest["permissionMode"],
    approvalPolicy: approvalPolicy as CliStartRequest["approvalPolicy"],
    appendSystemPrompt,
  } as CliStartRequest;

  assertSpawnCwd(cwd);

  // codex 圆桌用 `codex exec`（不走 app-server ws），MCP 清空；claude 不受 mcpArgs 影响。
  const mcpArgs = role.agent === "codex" ? CODEX_MCP_CLEAR : undefined;
  const { cmd, args, stdin } = adapter.buildArgs(req, mcpArgs);

  recordAgentTrace({
    scope: "roundtable",
    phase: "start",
    summary: `${role.agent}[${role.label}] role start`,
    runId: spawnKey,
    agent: role.agent,
    data: { cmd, cwd, argCount: args.length, roleId: role.id, promptPreview: context.slice(0, 200) },
  });

  const proc = startAgentProcess(cmd, args, {
    cwd,
    env: spawnEnvForDef(req, adapter),
    stdin,
  });

  roundtableProcs.add(proc);

  return new Promise<RoleRunResult>((resolve) => {
    let out = "";
    let settled = false;
    let timedOut = false;
    let resultFailed = false;
    let errorText = "";
    let stderrBuf = "";

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        proc.kill();
      }
    }, ROLE_TIMEOUT_MS);

    const onAbort = () => {
      if (!settled) proc.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      roundtableProcs.delete(proc);
      fn();
    };

    const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
      for (const ev of parseLineEvents(adapter, line)) {
        if (ev.type === "text") {
          if (out.length < MAX_ROLE_OUTPUT) out += ev.delta;
          // 转发给渲染端（带 roleId）
          onEvent({ ...ev, roleId: role.id } as CliStreamEvent);
        } else if (ev.type === "result") {
          // 中间角色的 result 不转发（防止 finalizeRun），仅内部消费
          if (!ev.ok) {
            resultFailed = true;
            errorText = ev.error ?? "执行失败";
          }
        } else {
          // thinking/tool/turn/usage/retry：带 roleId 转发
          onEvent({ ...ev, roleId: role.id } as CliStreamEvent);
        }
      }
    });

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    proc.onError((err) => {
      recordAgentTrace({
        scope: "roundtable", phase: "error", summary: `${role.agent}[${role.label}] spawn error`,
        runId: spawnKey, agent: role.agent, data: { error: err.message, stderr: stderrBuf.slice(-500) },
      });
      settle(() => resolve({ text: out.trim(), ok: false, error: err.message }));
    });

    proc.onExit((code) => {
      flushStdout();
      settle(() => {
        recordAgentTrace({
          scope: "roundtable", phase: "exit", summary: `${role.agent}[${role.label}] exit(${code})`,
          runId: spawnKey, agent: role.agent,
          data: { code, ok: !resultFailed && code === 0, stderr: stderrBuf.slice(-500), outLen: out.length },
        });
        if (signal.aborted) {
          return resolve({ text: out.trim(), ok: false, error: "已取消" });
        }
        if (timedOut) {
          return resolve({
            text: out.trim(),
            ok: false,
            error: `角色「${role.label}」超时（${Math.round(ROLE_TIMEOUT_MS / 1000)}s），已终止`,
          });
        }
        if (resultFailed) {
          // 拼接 stderr 补充诊断信息
          const detail = stderrBuf.trim() ? `${errorText}\n${stderrBuf.trim().slice(-300)}` : errorText;
          return resolve({ text: out.trim(), ok: false, error: detail });
        }
        if (code !== 0 && code !== null) {
          const detail = stderrBuf.trim() ? `${role.agent} 退出码 ${code}\n${stderrBuf.trim().slice(-300)}` : `${role.agent} 退出码 ${code}`;
          return resolve({ text: out.trim(), ok: false, error: detail });
        }
        resolve({ text: out.trim(), ok: true });
      });
    });
  });
}

// ── @mention 解析（主进程侧轻量版，仅用于链条触发） ──
// 复用 core/personal/mention.ts 的逻辑，但主进程不能 import core 包。
// 这里做最简提取：匹配 @token，到已知角色列表里查。

function extractChainMentions(
  output: string,
  allRoles: RoleConfig[],
  builtinIds: Set<string>,
): RoleConfig[] {
  const re = /@([\w一-鿿㐀-䶿豈-﫿_-]+)/gu;
  const found: RoleConfig[] = [];
  const seenIds = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = re.exec(output)) !== null) {
    const token = match[1].toLowerCase();

    // 内置 shortcut
    if (builtinIds.has(token) && !seenIds.has(token)) {
      seenIds.add(token);
      found.push({
        id: token,
        label: token.charAt(0).toUpperCase() + token.slice(1),
        agent: token,
        systemPrompt: "",
        createdAt: "",
        updatedAt: "",
      });
      continue;
    }

    // 自定义角色 id 匹配
    const byId = allRoles.find((r) => r.id.toLowerCase() === token);
    if (byId && !seenIds.has(byId.id)) {
      seenIds.add(byId.id);
      found.push(byId);
      continue;
    }

    // 自定义角色 label 匹配
    const byLabel = allRoles.find((r) => r.label.toLowerCase() === token);
    if (byLabel && !seenIds.has(byLabel.id)) {
      seenIds.add(byLabel.id);
      found.push(byLabel);
    }
  }

  return found;
}

// ── IPC Handler 注册 ──

export function registerRoundtableHandlers(): void {
  ipcMain.handle("roundtable:start", async (event, req: RoundtableStartRequest) => {
    const { runId, sessionId, agent, cwd, text, mentions, roles, model, effort, permissionMode, approvalPolicy, appendSystemPrompt } = req;

    const sender = event.sender;
    const controller = new AbortController();
    activeRoundtables.set(runId, controller);

    const sendEvent = (ev: CliStreamEvent) => {
      if (!sender.isDestroyed()) {
        sender.send("cli:event", { runId, sessionId, event: ev });
      }
    };
    const sendExit = (exit: CliExitEvent) => {
      if (!sender.isDestroyed()) {
        sender.send("cli:exit", exit);
      }
    };

    // 内置 agent id 集合（链条触发用）
    const builtinIds = new Set(["claude", "codex", "pi"]);

    // 访问计数（防循环）
    const visitCount = new Map<string, number>();

    // 本轮累积上下文（后续角色能看到前序角色的回复）
    const turnAccumulator: Array<{ roleId: string; roleLabel: string; text: string }> = [];

    // ── 管线第一段：主 agent 先执行用户 prompt ──
    // 主 agent（会话绑定的 agent）处理完整用户消息，其输出作为 @mentioned agent 的上下文。
    // 仅当 @mentioned agent 与主 agent 不是同一个时才分两段；若用户在 codex 会话 @Codex，
    // 跳过主 agent 直接走 BFS（避免同 agent 跑两次、prompt 重复）。
    const mentionedIds = new Set(mentions.map((m) => m.role.id));
    const skipPrimary = mentions.length === 1 && mentionedIds.has(agent);

    if (!skipPrimary && !controller.signal.aborted) {
      const primaryLabel = agent.charAt(0).toUpperCase() + agent.slice(1);
      const primaryRole: RoleConfig = {
        id: `__primary_${agent}`,
        label: primaryLabel,
        agent,
        systemPrompt: "",
        createdAt: "",
        updatedAt: "",
      };

      // 角色开始信号
      sendEvent({ type: "init", sessionId, roleId: primaryRole.id, stageLabel: primaryRole.label } as CliStreamEvent);

      const primaryResult = await runRole({
        role: primaryRole,
        text,
        cwd,
        turnAccumulator,
        model,
        effort,
        permissionMode,
        approvalPolicy,
        appendSystemPrompt,
        signal: controller.signal,
        onEvent: sendEvent,
      });

      if (!controller.signal.aborted) {
        if (!primaryResult.ok) {
          sendEvent({
            type: "result",
            ok: false,
            error: primaryResult.error,
            roleId: primaryRole.id,
          } as CliStreamEvent);
          turnAccumulator.push({
            roleId: primaryRole.id,
            roleLabel: primaryRole.label,
            text: `[执行失败: ${primaryResult.error ?? "未知错误"}]`,
          });
        } else {
          turnAccumulator.push({
            roleId: primaryRole.id,
            roleLabel: primaryRole.label,
            text: primaryResult.text,
          });
        }
      }
    }

    // ── 管线第二段：BFS 调度 @mentioned agents ──
    const queue: QueueItem[] = mentions.map((m) => ({
      role: m.role,
      depth: 0,
    }));

    while (queue.length > 0) {
      if (controller.signal.aborted) break;

      const item = queue.shift()!;
      const { role, depth } = item;

      // 深度检查
      if (depth >= MAX_DEPTH) continue;

      // 访问次数检查
      const visits = visitCount.get(role.id) ?? 0;
      if (visits >= MAX_VISITS_PER_ROLE) continue;
      visitCount.set(role.id, visits + 1);

      // 角色开始信号（渲染端据此插入 roleHeader）
      sendEvent({ type: "init", sessionId, roleId: role.id, stageLabel: role.label } as CliStreamEvent);

      // 执行角色
      const result = await runRole({
        role,
        text,
        cwd,
        turnAccumulator,
        model,
        effort,
        permissionMode,
        approvalPolicy,
        appendSystemPrompt,
        signal: controller.signal,
        onEvent: sendEvent,
      });

      if (controller.signal.aborted) break;

      if (!result.ok) {
        // 角色失败：推 result(ok:false, roleId) 标注错误，但不触发 finalizeRun
        sendEvent({
          type: "result",
          ok: false,
          error: result.error,
          roleId: role.id,
        } as CliStreamEvent);
        // 在累积上下文中记录失败
        turnAccumulator.push({
          roleId: role.id,
          roleLabel: role.label,
          text: `[执行失败: ${result.error ?? "未知错误"}]`,
        });
      } else {
        // 角色成功：累积上下文
        turnAccumulator.push({
          roleId: role.id,
          roleLabel: role.label,
          text: result.text,
        });

        // 解析输出中的 @mention → 追加到 BFS 队列（链条触发）
        const chainRoles = extractChainMentions(result.text, roles, builtinIds);
        for (const chainRole of chainRoles) {
          queue.push({
            role: chainRole,
            depth: depth + 1,
            triggeredBy: role.id,
          });
        }
      }
    }

    activeRoundtables.delete(runId);

    // 全部角色完成：推合成终态（对齐 orchestrate.ts 约定）
    if (!controller.signal.aborted) {
      sendEvent({ type: "result", ok: true } as CliStreamEvent);
      sendExit({ runId, sessionId, code: 0 });
    }
  });

  // roundtable:kill — 取消指定圆桌（fire-and-forget，对齐 orchestrate:kill / cli:kill 模式）
  ipcMain.on("roundtable:kill", (_event, runId: string) => {
    const controller = activeRoundtables.get(runId);
    if (controller) {
      controller.abort();
      activeRoundtables.delete(runId);
    }
  });
}
