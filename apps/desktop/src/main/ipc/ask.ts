// 历史消息追问的临时流式应答通道(ask:*)。复用 cli.ts 的 spawn 基建
// (getAdapter / startAgentProcess / spawnEnvFor / pipeStdoutLines),但用一次性 askId:
//   · 不写 chats/、不进 React Query 缓存、不入个人 run 注册表 —— 关闭即弃(R5)。
//   · 流式逐行 parseLine → e.sender.send("ask:event", {askId, event})(R3)。
//   · 终止信号 = 复用 {type:"result"} + 子进程 close 双保险,不新增 ask:exit(渲染端据此关 running)。
//   · 失败/非零退出发携带 error 的 {type:"result", ok:false} 终止事件,不抛未捕获异常(R8)。
//   · Map<askId, child> 支持 ask:cancel(幂等) 与 killAllAsk()(退出/托盘三路清理,R7)。
//   · 无 cwd(homedir 退化)时对 claude/codex 收紧 tool 能力(去掉跳审批/bypass 标志,R9/KTD8)。

import { ipcMain, type WebContents } from "electron";
import { homedir } from "os";
import type { AgentKind, AskFollowupRequest, CliStreamEvent } from "./types";
import { getAdapter } from "../agents";
import { writePiExtension } from "../agents/pi-providers";
import { type AgentProcess, pipeStdoutLines, spawnEnvFor, startAgentProcess } from "./cli";

const running = new Map<string, AgentProcess>();

// 无项目工作目录(cwd 退化到 homedir)时,跳审批的 tool 会在用户主目录真实执行,有误伤风险。
// 此处对 claude/codex 去掉「跳审批/bypass 沙箱」标志,让其回退到默认审批/沙箱;
// print 模式下无人审批 ⇒ 有副作用的 tool 会被拒(只读应答仍可用),满足 R9。
// pi 不在此列(无对应的全局跳审批标志)。
const TIGHTEN_FLAGS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
};

function tightenArgs(agent: AgentKind, args: string[]): string[] {
  const drop = TIGHTEN_FLAGS[agent];
  if (!drop) return args;
  return args.filter((a) => !drop.includes(a));
}

// cwd 缺失或退化到用户主目录 = 无项目会话,需收紧 tool。
function isNoProjectCwd(cwd: string | undefined): boolean {
  return !cwd || cwd === homedir();
}

export function registerAskHandlers(): void {
  ipcMain.handle("ask:start", (event, req: AskFollowupRequest) => {
    const sender = event.sender;
    const adapter = getAdapter(req.agent);

    // pi 自定义供应商:先生成 extension 文件,把路径塞进 buildArgs 入参供加 -e(复用 cli:start 逻辑)。
    const piExtensionPath = req.agent === "pi" && req.provider ? writePiExtension(req.provider) : undefined;

    // askId 同时充当 runId/sessionId(adapter buildArgs 需要这两个字段,但本通道不落盘、不 resume)。
    const built = adapter.buildArgs({
      runId: req.askId,
      sessionId: req.askId,
      agent: req.agent,
      cwd: req.cwd,
      prompt: req.prompt,
      model: req.model,
      appendSystemPrompt: req.appendSystemPrompt,
      effort: req.effort,
      provider: req.provider,
      piExtensionPath,
    });
    const args = isNoProjectCwd(req.cwd) ? tightenArgs(req.agent, built.args) : built.args;

    const proc = startAgentProcess(built.cmd, args, {
      cwd: req.cwd,
      env: spawnEnvFor({ agent: req.agent, provider: req.provider }),
    });
    running.set(req.askId, proc);

    const sendEvent = (ev: CliStreamEvent) => {
      if (!sender.isDestroyed()) sender.send("ask:event", { askId: req.askId, event: ev });
    };

    const flushStdout = pipeStdoutLines(proc.stdout, (line) => {
      const ev = adapter.parseLine(line);
      if (ev) sendEvent(ev);
    });

    let stderrTail = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    // 进程对象延迟回收时,闭包捕获 sender/adapter 会驻留 → 显式摘除监听(防泄漏)。
    const cleanup = () => {
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      running.delete(req.askId);
    };

    proc.onError((err) => {
      console.error(`[ask] ${req.agent} spawn failed: ${err.message}`);
      cleanup();
      // spawn 失败(如二进制缺失)也走 result 终止信号,渲染端据此呈现错误态、关 running(R8)。
      sendEvent({ type: "result", ok: false, error: err.message });
    });

    proc.onExit((code) => {
      flushStdout(); // 冲刷无换行结尾的最后一行
      cleanup();
      // 非零退出且 adapter 未自发 result(如进程被外部杀)→ 补发携带 stderr 的失败终止信号。
      if (code !== 0 && code !== null) {
        const error = stderrTail.trim() || `退出码 ${code}`;
        console.error(`[ask] ${req.agent} exited with code ${code}: ${error}`);
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
