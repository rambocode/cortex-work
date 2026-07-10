// 历史消息追问的临时流式应答通道(ask:*)。复用 cli.ts 的 spawn 基建
// (getAgentDef / startAgentProcess / spawnEnvFor / pipeStdoutLines),但用一次性 askId:
//   · 不写 chats/、不进 React Query 缓存、不入个人 run 注册表 —— 关闭即弃(R5)。
//   · 流式逐行 parseLine → e.sender.send("ask:event", {askId, event})(R3)。
//   · 终止信号 = {type:"result"}：adapter 可能自发(parseLine 解析出 result),也可能不发；
//     进程「正常结束」(code===0/非0,非被信号 kill)时主进程**保证补发**一个终止 result,
//     使渲染端的收尾只认 result(进程真实结束才收尾,语义对齐主会话)。被信号 kill
//     (code===null,即 cancel/killAll 路径)**不补发**——避免取消后污染新一轮(FIX-1)。
//   · 失败/非零退出发携带 error 的 {type:"result", ok:false} 终止事件,不抛未捕获异常(R8)。
//   · Map<askId, child> 支持 ask:cancel(幂等) 与 killAllAsk()(退出/托盘三路清理,R7)。
//   · 调用方传 tightenTools=true(无项目会话)时,对 claude/codex 收紧 tool 能力
//     (去掉跳审批/bypass 标志,R9/KTD8)——显式标志,不靠主进程猜 cwd(FIX-3)。

import { ipcMain, type WebContents } from "electron";
import { existsSync } from "fs";
import { homedir } from "os";
import type { AgentKind, AskFollowupRequest, CliStreamEvent } from "./types";
import { getAgentDef, parseLineEvents } from "../agents";
import { CODEX_MCP_CLEAR } from "./mcp-config";
import { writePiExtension } from "../agents/pi-providers";
import { type AgentProcess, pipeStdoutLines, spawnEnvForDef, startAgentProcess } from "./cli";
import { recordAgentTrace } from "./agent-trace";
import { createLogger } from "../log";

const log = createLogger("ask");

const running = new Map<string, AgentProcess>();

function promptPreview(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  return prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt;
}

// 无项目会话时,跳审批的 tool 会在用户文档/主目录真实执行,有误伤风险。
// 此处对 claude/codex 去掉「跳审批/bypass 沙箱」标志,让其回退到默认审批/沙箱;
// print 模式下无人审批 ⇒ 有副作用的 tool 会被拒(只读应答仍可用),满足 R9。
// pi 不在此列(无对应的全局跳审批标志)。是否收紧由调用方显式 req.tightenTools 决定,
// 不靠主进程猜 cwd——真实无项目 cwd 是 Documents/cortex/<date>,非 homedir(FIX-3)。
const TIGHTEN_FLAGS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
};

function tightenArgs(agent: AgentKind, args: string[]): string[] {
  const drop = TIGHTEN_FLAGS[agent];
  if (!drop) return args;
  return args.filter((a) => !drop.includes(a));
}

export function registerAskHandlers(): void {
  ipcMain.handle("ask:start", (event, req: AskFollowupRequest) => {
    const sender = event.sender;
    const adapter = getAgentDef(req.agent);

    // cwd 兜底:空串或磁盘上不存在的目录会让 child_process.spawn 抛 `spawn <cmd> ENOENT`
    // (Node 把「cwd 不存在」误报成 cmd 不存在)。无项目会话(cwd=noProjectDir 可能尚未创建)
    // 或项目已删时会踩中,故退化到 homedir(),保证 spawn 不因 cwd 失败。buildArgs 与 spawn
    // 用同一 cwd(codex 的 --cd 等据此)。无项目场景的 tool 安全由调用方 tightenTools 兜底(R9)。
    const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : homedir();

    // pi 自定义供应商:先生成 extension 文件,把路径塞进 buildArgs 入参供加 -e(复用 cli:start 逻辑)。
    const piExtensionPath = req.agent === "pi" && req.provider ? writePiExtension(req.provider) : undefined;

    // askId 同时充当 runId/sessionId(adapter buildArgs 需要这两个字段,但本通道不落盘、不 resume)。
    const built = adapter.buildArgs({
      runId: req.askId,
      sessionId: req.askId,
      agent: req.agent,
      cwd,
      prompt: req.prompt,
      model: req.model,
      appendSystemPrompt: req.appendSystemPrompt,
      effort: req.effort,
      // 运行模式:claude/codex adapter 据此拼权限标志(pi 单发无 UI,plan 经 --tools 白名单生效)。
      permissionMode: req.permissionMode,
      provider: req.provider,
      piExtensionPath,
    }, CODEX_MCP_CLEAR); // 追问为轻量单发:codex 清空 MCP(沿用 M1);claude/pi 忽略
    // tightenTools 与运行模式叠加:plan/accept-edits 已是非 bypass,剥离 bypass 对其 no-op;
    // full-auto 仍剥离 bypass → 无项目会话安全(更严者优先)。
    const args = req.tightenTools ? tightenArgs(req.agent, built.args) : built.args;

    recordAgentTrace({
      scope: "ask",
      phase: "start",
      summary: `${req.agent} ask start`,
      runId: req.askId,
      sessionId: req.askId,
      agent: req.agent,
      // model/effort:调试跟踪需能直读本轮用的模型与推理强度(缺省 = 未显式传,用 agent 自身默认)。
      data: {
        cmd: built.cmd,
        cwd,
        model: req.model ?? "(默认)",
        effort: req.effort ?? "(默认)",
        argCount: args.length,
        promptPreview: promptPreview(req.prompt),
      },
    });
    const proc = startAgentProcess(built.cmd, args, {
      cwd,
      env: spawnEnvForDef({ agent: req.agent, provider: req.provider }, adapter),
      stdin: built.stdin, // claude/codex 经 stdin 投递 prompt(U4);pi 为 undefined
    });
    running.set(req.askId, proc);

    // 本轮是否已发过终止 result(adapter 自发 或 主进程补发)。onExit/onError 据此避免重复终止信号,
    // 也保证「进程正常结束」一定有一个 result 到达渲染端(FIX-1)。
    let resultSent = false;
    const sendEvent = (ev: CliStreamEvent) => {
      if (ev.type === "result") resultSent = true;
      recordAgentTrace({
        scope: "ask",
        phase: "event",
        summary: `${req.agent} ask ${ev.type}`,
        runId: req.askId,
        sessionId: req.askId,
        agent: req.agent,
        data: { parsedEvent: ev },
      });
      if (!sender.isDestroyed()) sender.send("ask:event", { askId: req.askId, event: ev });
    };

    const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
      // 一行可解析出多个归一化事件(如 usage + result);逐个转发。
      for (const ev of parseLineEvents(adapter, line)) sendEvent(ev);
    });

    let stderrTail = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      recordAgentTrace({
        scope: "ask",
        phase: "stderr",
        summary: `${req.agent} ask stderr`,
        runId: req.askId,
        sessionId: req.askId,
        agent: req.agent,
        data: { chunk },
      });
    });

    // 进程对象延迟回收时,闭包捕获 sender/adapter 会驻留 → 显式摘除监听(防泄漏)。
    const cleanup = () => {
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      running.delete(req.askId);
    };

    proc.onError((err) => {
      log.error(`${req.agent} spawn failed: ${err.message}`);
      recordAgentTrace({
        scope: "ask",
        phase: "error",
        summary: `${req.agent} ask spawn failed`,
        runId: req.askId,
        sessionId: req.askId,
        agent: req.agent,
        data: { error: err.message },
      });
      cleanup();
      // spawn 失败(如二进制缺失)也走 result 终止信号,渲染端据此呈现错误态、关 running(R8)。
      sendEvent({ type: "result", ok: false, error: err.message });
    });

    proc.onExit((code) => {
      flushStdout(); // 冲刷无换行结尾的最后一行(可能含 adapter 自发的 result)
      cleanup();
      recordAgentTrace({
        scope: "ask",
        phase: "exit",
        summary: `${req.agent} ask exit ${code ?? "null"}`,
        runId: req.askId,
        sessionId: req.askId,
        agent: req.agent,
        data: { code, error: stderrTail.trim() || undefined },
      });
      // code===null = 被信号 kill(cancel/killAll 路径)→ 不补发,避免取消后污染新一轮(FIX-1)。
      if (code === null) return;
      // 进程正常结束(无论 code 是否为 0):若 adapter 未自发 result,主进程补发明确终止信号,
      // 保证渲染端「只认 result 收尾」一定能收到一个(防长思考/冷启动间隔被误判 done)。
      if (resultSent) return;
      if (code === 0) {
        sendEvent({ type: "result", ok: true });
      } else {
        const error = stderrTail.trim() || `退出码 ${code}`;
        log.error(`${req.agent} exited with code ${code}: ${error}`);
        sendEvent({ type: "result", ok: false, error });
      }
    });
  });

  // 取消:kill 子进程 + 删表。幂等(askId 不存在或已退出时静默)。
  ipcMain.handle("ask:cancel", (_e, askId: string) => {
    const proc = running.get(askId);
    if (!proc) return;
    proc.kill();
    running.delete(askId);
  });
}

// app 后台/退出/托盘三路清理:遍历表全 kill 并清空(R7,与 killAllCli 并列接入退出钩子)。
export function killAllAsk(): void {
  for (const proc of running.values()) proc.kill();
  running.clear();
}

// 供测试/诊断:当前在途 ask 数量。
export function hasRunningAsk(_sender?: WebContents): boolean {
  return running.size > 0;
}
