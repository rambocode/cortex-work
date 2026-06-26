// codex 主交互会话的 ws 运行编排(U5)。
//
// 模型:app-server 进程 **per-session 长驻**(CodexServerManager 管理),ws 连接 **per-run**(每轮用户
// 消息一条连接)。每轮:ensureServer → 连 ws → 首轮 thread/start / 续轮 thread/resume → turn/start →
// 流式通知转发 → turn 终态 → 关 ws(server 保留,供下轮 resume,体现持久会话收益)。
//
// 对外暴露一个实现 AgentProcess 接口的句柄,供 cli.ts 登记进 running map(cli:kill/killAllCli 统一)。
// 与 spawn 路径对齐的不变量:任意路径(成功/失败/取消/超时/崩溃)**必产一个 cli:exit**;成功路径在
// cli:exit 前先经通道转发一个 result(ok:true)。

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
  /** 转发归一化事件给渲染端(cli.ts 注入,内部带 runId/sessionId)。 */
  sendEvent: (ev: CliStreamEvent) => void;
  /** 终态退出(cli.ts 注入:清理 running/MCP session 后 send cli:exit)。 */
  sendExit: (exit: CliExitEvent) => void;
  /** 心跳:活跃期定期调用,渲染端据此重置 300s 静默看门狗(防长 MCP 工具误杀)。 */
  sendKeepalive?: () => void;
  /** 主进程活跃看门狗阈值(ms)。 */
  inactivityMs: number;
  /** 连接级失败的最大重试次数(默认 2,与 spawn 安全重试对齐)。 */
  retryMax?: number;
  /** 通道工厂(默认真实 CodexWsChannel;测试注入 fake)。 */
  createChannel?: (opts: CodexWsChannelOpts) => CodexWsChannel;
  /** 客户端版本(initialize.clientInfo.version)。 */
  clientVersion?: string;
}

const RETRY_BACKOFF_MS = 800;
const KEEPALIVE_MIN_INTERVAL_MS = 50_000; // < 渲染端 300s 静默阈值,留足余量

export function startCodexWsRun(opts: CodexWsRunOpts): AgentProcess {
  const { req, def, manager, sendEvent, sendExit } = opts;
  const retryMax = opts.retryMax ?? 2;
  const makeChannel = opts.createChannel ?? ((o) => new CodexWsChannel(o));

  let channel: CodexWsChannel | null = null;
  let settled = false;
  let cancelled = false;
  let sawAnyVisible = false; // text/tool/result 任一 → 不再做连接级重试
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let lastKeepaliveAt = 0;
  const exitCbs: ((code: number | null) => void)[] = [];

  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };

  // 任意 ws 活跃:重置主看门狗 + 节流心跳(渲染端长 MCP 工具静默期不被误杀)。
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
    // 长跑卡死:杀掉该会话 server(可能 wedged),给超时退出。
    manager.killServer(req.sessionId);
    finish({ code: null, error: `活跃超时:${Math.round(opts.inactivityMs / 1000)} 秒无输出,已终止` });
  }

  // 终态收口(幂等):清看门狗、置 busy=false、关通道、回调 onExit、send cli:exit。
  function finish(exit: { code: number | null; error?: string }): void {
    if (settled) return;
    settled = true;
    clearWatchdog();
    manager.setBusy(req.sessionId, false);
    try {
      channel?.close();
    } catch {
      /* 已关闭 */
    }
    for (const cb of exitCbs) cb(exit.code);
    sendExit({ runId: req.runId, sessionId: req.sessionId, code: exit.code, error: exit.error });
  }

  // 转发归一化事件;text → recordStreamDelta,其余 → recordAgentTrace(对齐 spawn 管线)。
  // 收到 result 即 turn 终态:转发后收口(成功/失败均如此)。
  function forward(ev: CliStreamEvent): void {
    if (settled) return;
    if (ev.type === "text") {
      sawAnyVisible = true;
      recordStreamDelta({
        scope: "cli",
        segmentType: "text",
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
    sendEvent(ev);
    if (ev.type === "result") {
      // turn 终态:result 已转发,收口退出(server 保留供下轮 resume)。
      finish({ code: ev.ok ? 0 : 0, error: ev.ok ? undefined : ev.error });
    }
  }

  // 连接级失败:无可见输出 + 仍有重试额度 + 未取消 → 退避后重试;否则失败收口。
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
      sendEvent({ type: "retry", attempt: attempt + 1, maxAttempts: retryMax, reason: "connection" });
      setTimeout(() => {
        if (cancelled) {
          finish({ code: null });
          return;
        }
        void runAttempt(attempt + 1);
      }, RETRY_BACKOFF_MS);
      return;
    }
    // 不可重试:转一个失败 result(渲染端唯一终态信号)+ 退出。
    forwardResultThenExit(false, error);
  }

  function forwardResultThenExit(ok: boolean, error?: string): void {
    if (settled) return;
    sendEvent({ type: "result", ok, error });
    finish({ code: 0, error: ok ? undefined : error });
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
      data: { cwd: req.cwd, attempt },
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
      // ensureServer 失败(就绪超时/旧版不支持)→ 连接级,可重试。
      failConnection(attempt, errMsg(e));
      return;
    }
    if (cancelled || settled) return;

    const ch = makeChannel({
      wsUrl: server.wsUrl,
      clientVersion: opts.clientVersion,
      onEvent: (ev) => forward(ev),
      onActivity: () => noteActivity(),
      onClose: ({ expected }) => {
        // 非预期关闭(server 崩溃/网络断)且未收口 → 连接级失败(可重试)。
        if (!expected && !settled) failConnection(attempt, "ws 连接意外关闭");
      },
      onError: () => {
        /* 错误经 onClose / request reject 路由,这里不重复收口 */
      },
    });
    channel = ch;
    noteActivity();

    try {
      await ch.connect();
      if (cancelled || settled) return;
      // U6 续接:带 resumeSessionId/continueSession → thread/resume(失败=session-lost,不重试);
      // 否则首轮 thread/start。
      const resumeId = resolveResumeThreadId(req);
      if (resumeId) {
        try {
          await ch.resumeThread(resumeId, {
            cwd: req.cwd,
            permissionMode: req.permissionMode,
            model: req.model,
          });
        } catch (e) {
          // 续接失败:归一化为 isMissingAgentSessionError 可匹配的文本 → 渲染端清除 agentSessionId。
          forwardResultThenExit(false, `thread/resume failed: ${errMsg(e)}`);
          return;
        }
      } else {
        await ch.startThread({ cwd: req.cwd, permissionMode: req.permissionMode, model: req.model });
      }
      if (cancelled || settled) return;
      await ch.startTurn({
        input: buildTurnInput(req),
        effort: req.effort,
        model: req.model,
      });
      // 之后经通知流式产出,直至 result → finish。
    } catch (e) {
      // 握手/启动 turn 失败:连接级(可重试,前提无可见输出)。
      failConnection(attempt, errMsg(e));
    }
  }

  // 启动首轮。
  void runAttempt(0);

  // 返回 AgentProcess 句柄(供 running map + cli:kill)。
  return {
    pid: undefined,
    stdout: null,
    stderr: null,
    onExit: (cb) => exitCbs.push(cb),
    onError: () => {
      /* ws 路径错误经 result/exit 表达,无独立 error 通道 */
    },
    kill: () => {
      if (settled) return;
      cancelled = true;
      // 取消优先 turn/interrupt(OQ5),再关 ws;server 保留(下轮可 resume)。
      void channel?.interrupt().finally(() => {
        finish({ code: null });
      });
      // interrupt 可能挂起:即便上面未及时 finish,这里兜底(finish 幂等)。
      finish({ code: null });
    },
  };
}

// resumeSessionId 优先;continueSession 复用 resumeSessionId(渲染端持久化的最近 threadId)。
// app-server 无「--last」语义,故 continueSession 等价于「按已存 threadId 续接」,无则首轮新建。
function resolveResumeThreadId(req: CliStartRequest): string | undefined {
  return req.resumeSessionId || undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
