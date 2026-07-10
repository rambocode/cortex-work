// codex 主交互会话的 ws 运行编排(U5,跨轮持久连接版)。
//
// 模型(已升级):app-server 进程 **per-session 长驻**(CodexServerManager),ws 连接 **per-session 持久**
// —— 首轮:连接 + initialize + 建/续 thread;后续轮:**复用同一连接**,只发 turn/start(不再握手、不再
// thread/resume)。这才吃满 app-server 相对 `codex exec` 的优势:轮间零进程冷启、零磁盘水合、零握手。
//
// 连接与 run 解耦:每个 sessionId 一个长驻 SessionConn(持有 channel + threadId);channel 的事件经
// 委托(conn.onEvent 等)指向**当前活跃 run**,轮间切换。turn 结束只 detach run、**不关连接**;
// 取消走 turn/interrupt(保连接);连接异常关闭/被驱逐 → 标记 dead,下轮惰性重建。
//
// 对外仍暴露一个实现 AgentProcess 接口的 per-run 句柄,供 cli.ts 登记进 running map。
// 不变量:任意路径(成功/失败/取消/超时/崩溃)必产一个 cli:exit;成功路径先转发 result(ok:true)。

import type { AgentProcess } from "./cli";
import type { CliExitEvent, CliStartRequest, CliStreamEvent } from "./types";
import type { AgentDef } from "../agents";
import type { CodexServerManager } from "../agents/codex-app-server";
import { CodexWsChannel, buildTurnInput, type CodexWsChannelOpts } from "./codex-ws-channel";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";

export interface CodexWsRunOpts {
  req: CliStartRequest;
  def: AgentDef;
  mcpArgs?: string[];
  manager: CodexServerManager;
  sendEvent: (ev: CliStreamEvent) => void;
  sendExit: (exit: CliExitEvent) => void;
  sendKeepalive?: () => void;
  inactivityMs: number;
  retryMax?: number;
  createChannel?: (opts: CodexWsChannelOpts) => CodexWsChannel;
  clientVersion?: string;
}

// 每会话一个长驻连接。channel 事件经 onEvent/onActivity/onConnClose 委托到当前活跃 run。
interface SessionConn {
  channel: CodexWsChannel;
  wsUrl: string;
  threadId?: string;
  dead: boolean;
  onEvent?: (ev: CliStreamEvent) => void;
  onActivity?: () => void;
  onConnClose?: () => void;
}

const sessionConns = new Map<string, SessionConn>();

/** 应用退出:关闭全部持久 codex ws 连接(配合 killAllCli 回收 server)。 */
export function closeAllCodexChannels(): void {
  for (const c of sessionConns.values()) {
    c.dead = true;
    try {
      c.channel.close();
    } catch {
      /* 已关闭 */
    }
  }
  sessionConns.clear();
}

/** 丢弃某会话的连接(server 被杀/驱逐时调,下轮惰性重建)。 */
export function dropCodexChannel(sessionId: string): void {
  const c = sessionConns.get(sessionId);
  if (!c) return;
  c.dead = true;
  sessionConns.delete(sessionId);
  try {
    c.channel.close();
  } catch {
    /* 已关闭 */
  }
}

const RETRY_BACKOFF_MS = 800;
const KEEPALIVE_MIN_INTERVAL_MS = 50_000;

export function startCodexWsRun(opts: CodexWsRunOpts): AgentProcess {
  const { req, def, manager } = opts;
  const retryMax = opts.retryMax ?? 2;
  const makeChannel = opts.createChannel ?? ((o) => new CodexWsChannel(o));

  let conn: SessionConn | null = null;
  let settled = false;
  let cancelled = false;
  let sawAnyVisible = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let lastKeepaliveAt = 0;
  const exitCbs: ((code: number | null) => void)[] = [];

  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };

  const noteActivity = () => {
    clearWatchdog();
    watchdog = setTimeout(onWatchdogTrip, opts.inactivityMs);
    const now = Date.now();
    if (opts.sendKeepalive && now - lastKeepaliveAt >= KEEPALIVE_MIN_INTERVAL_MS) {
      lastKeepaliveAt = now;
      opts.sendKeepalive();
    }
  };

  function onWatchdogTrip(): void {
    if (settled) return;
    recordAgentTrace({
      scope: "cli",
      phase: "watchdog",
      summary: `codex ws inactivity timeout`,
      runId: req.runId,
      sessionId: req.sessionId,
      agent: req.agent,
      data: { inactivityMs: opts.inactivityMs },
    });
    // 长跑卡死:杀会话 server 并丢弃连接(下轮重建),给超时退出。
    manager.killServer(req.sessionId);
    dropCodexChannel(req.sessionId);
    finish({ code: null, error: `活跃超时:${Math.round(opts.inactivityMs / 1000)} 秒无输出,已终止` });
  }

  // 终态收口(幂等):清看门狗、置 busy=false、**detach 本 run 的连接回调(不关连接)**、回调 onExit、send cli:exit。
  function finish(exit: { code: number | null; error?: string }): void {
    if (settled) return;
    settled = true;
    clearWatchdog();
    manager.setBusy(req.sessionId, false);
    // 仅当连接的当前 sink 仍是本 run 时才摘除(避免摘掉下一 run 已挂上的回调)。
    if (conn && conn.onEvent === forward) {
      conn.onEvent = undefined;
      conn.onActivity = undefined;
      conn.onConnClose = undefined;
    }
    for (const cb of exitCbs) cb(exit.code);
    opts.sendExit({ runId: req.runId, sessionId: req.sessionId, code: exit.code, error: exit.error });
  }

  function forward(ev: CliStreamEvent): void {
    if (settled) return;
    // text/thinking 增量交 trace 记录端合并为生长段(与 pi-session 同策略,避免逐 delta 刷屏);
    // 仅影响 dev 调试跟踪,sendEvent 真实事件管线不变。
    if (ev.type === "text" || ev.type === "thinking") {
      sawAnyVisible = true;
      recordStreamDelta({
        scope: "cli",
        segmentType: ev.type === "text" ? "text" : "reasoning",
        delta: ev.delta,
        runId: req.runId,
        sessionId: req.sessionId,
        agent: req.agent,
      });
    } else {
      if (ev.type === "tool" || ev.type === "result") sawAnyVisible = true;
      recordAgentTrace({
        scope: "cli",
        phase: "event",
        summary: `codex ws ${ev.type}`,
        runId: req.runId,
        sessionId: req.sessionId,
        agent: req.agent,
        data: { parsedEvent: ev },
      });
    }
    opts.sendEvent(ev);
    if (ev.type === "result") finish({ code: 0, error: ev.ok ? undefined : ev.error });
  }

  function failConnection(attempt: number, error: string): void {
    if (settled) return;
    if (!cancelled && !sawAnyVisible && attempt < retryMax) {
      recordAgentTrace({
        scope: "cli",
        phase: "retry",
        summary: `codex ws retry`,
        runId: req.runId,
        sessionId: req.sessionId,
        agent: req.agent,
        data: { attempt: attempt + 1, error },
      });
      opts.sendEvent({ type: "retry", attempt: attempt + 1, maxAttempts: retryMax, reason: "connection" });
      setTimeout(() => {
        if (cancelled) {
          finish({ code: null });
          return;
        }
        void runAttempt(attempt + 1);
      }, RETRY_BACKOFF_MS);
      return;
    }
    forwardResultThenExit(false, error);
  }

  function forwardResultThenExit(ok: boolean, error?: string): void {
    if (settled) return;
    opts.sendEvent({ type: "result", ok, error });
    finish({ code: 0, error: ok ? undefined : error });
  }

  // 获取或(重)建会话连接。dead 或 wsUrl 变化(server 重启/换端口)→ 重建。
  function getOrCreateConn(wsUrl: string): { conn: SessionConn; fresh: boolean } {
    let existing = sessionConns.get(req.sessionId);
    if (existing && (existing.dead || existing.wsUrl !== wsUrl)) {
      dropCodexChannel(req.sessionId);
      existing = undefined;
    }
    if (existing) return { conn: existing, fresh: false };
    const created: SessionConn = { channel: null as unknown as CodexWsChannel, wsUrl, dead: false };
    created.channel = makeChannel({
      wsUrl,
      clientVersion: opts.clientVersion,
      onEvent: (ev) => created.onEvent?.(ev),
      onActivity: () => created.onActivity?.(),
      onClose: ({ expected }) => {
        created.dead = true;
        if (!expected) created.onConnClose?.();
      },
    });
    sessionConns.set(req.sessionId, created);
    return { conn: created, fresh: true };
  }

  async function runAttempt(attempt: number): Promise<void> {
    if (cancelled || settled) return;
    recordAgentTrace({
      scope: "cli",
      phase: attempt === 0 ? "start" : "retry",
      summary: attempt === 0 ? `codex ws start` : `codex ws retry#${attempt}`,
      runId: req.runId,
      sessionId: req.sessionId,
      agent: req.agent,
      // model/effort:调试跟踪需能直读本轮用的模型与推理强度(缺省 = 未显式传,用 agent 自身默认)。
      data: { cwd: req.cwd, model: req.model ?? "(默认)", effort: req.effort ?? "(默认)", attempt },
    });
    let server: { wsUrl: string };
    try {
      manager.setBusy(req.sessionId, true);
      server = await manager.ensureServer(req.sessionId, {
        cwd: req.cwd,
        serverCmd: def.serverCmd ?? "codex",
        mcpArgs: opts.mcpArgs,
        extraEnv: def.extraEnv,
      });
    } catch (e) {
      failConnection(attempt, errMsg(e));
      return;
    }
    if (cancelled || settled) return;

    const { conn: c, fresh } = getOrCreateConn(server.wsUrl);
    conn = c;
    // 把本 run 接到该连接(委托 sink)。
    c.onEvent = forward;
    c.onActivity = noteActivity;
    c.onConnClose = () => {
      if (!settled) failConnection(attempt, "ws 连接意外关闭");
    };
    noteActivity();

    try {
      const resumeId = resolveResumeThreadId(req);
      if (fresh) {
        await c.channel.connect();
        if (cancelled || settled) return;
      }
      // thread 初始化判据用「channel 是否已建好 thread」(c.threadId)而非 fresh:getOrCreateConn 在
      // connect/startThread 之前就把 conn 存进 sessionConns,故首轮 startThread 失败/被取消后,重试会
      // 复用同一 conn(fresh=false)却没有 thread。若仍按 fresh 跳过建 thread,startTurn 会因 channel
      // 无 _threadId 抛「startTurn 前需先 startThread」。改用 c.threadId 判定可覆盖该重试/并发场景。
      const wantResume = !!resumeId && resumeId !== c.threadId; // 续到不同 thread(编辑重发/切历史)
      if (!c.threadId || wantResume) {
        if (resumeId) {
          // 续接(失败=session-lost,归一化错误供渲染端清除 agentSessionId,不重试)。
          try {
            await c.channel.resumeThread(resumeId, { cwd: req.cwd, permissionMode: req.permissionMode, model: req.model });
          } catch (e) {
            forwardResultThenExit(false, `thread/resume failed: ${errMsg(e)}`);
            return;
          }
          c.threadId = resumeId;
        } else {
          c.threadId = await c.channel.startThread({ cwd: req.cwd, permissionMode: req.permissionMode, model: req.model });
        }
      }
      if (cancelled || settled) return;
      // 每轮发 init(从 threadId):首轮新建/续接、后续轮复用,渲染端据此维护 agentSessionId。
      if (c.threadId) forward({ type: "init", sessionId: c.threadId });
      await c.channel.startTurn({ input: buildTurnInput(req), effort: req.effort, model: req.model });
      // 之后经通知流式产出,直至 result → finish(连接保留供下轮)。
    } catch (e) {
      failConnection(attempt, errMsg(e));
    }
  }

  void runAttempt(0);

  return {
    pid: undefined,
    stdout: null,
    stderr: null,
    onExit: (cb) => exitCbs.push(cb),
    onError: () => {},
    kill: () => {
      if (settled) return;
      cancelled = true;
      // 取消:turn/interrupt(OQ5)中断当前 turn,**保留连接**(下轮可继续);interrupt 尽力而为。
      void conn?.channel.interrupt().finally(() => finish({ code: null }));
      finish({ code: null }); // 幂等兜底
    },
  };
}

function resolveResumeThreadId(req: CliStartRequest): string | undefined {
  return req.resumeSessionId || undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
