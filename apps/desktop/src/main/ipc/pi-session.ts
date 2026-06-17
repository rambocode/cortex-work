// pi RPC 长驻会话的 IPC 层。registry 维护 uiSessionId → PiRpcSession（= 一个 pi 子进程）,
// pi:open 建、pi:close 销;命令转发到会话方法,归一化事件经 pi:event 推回 renderer。
// claude/codex 仍走 cli.ts 单发管线,与本通道互不影响。

import { randomUUID } from "crypto";

import { ipcMain, type WebContents } from "electron";

import { buildRpcArgs, spawnPiRpc, PiRpcSession, type RpcResponse } from "../agents/pi-rpc";
import { writePiExtension } from "../agents/pi-providers";
import {
  writeApprovalExtension,
  writeAskQuestionExtension,
  writeCustomToolExtension,
  writeSlashCommandExtension,
} from "../agents/pi-extensions";
import { spawnEnvFor } from "./cli";
import type { PiOpenRequest, PiOpenResult, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "./types";

interface SessionEntry {
  session: PiRpcSession;
  sender: WebContents; // 发起 open 的 renderer,事件回推目标（销毁则丢弃）
}

const sessions = new Map<string, SessionEntry>();

// 推一条归一化事件给 renderer。crashed 顺带摘除注册表条目（进程已死,避免悬挂）。
// 带 runId（阶段4 代际）:renderer 据此守卫丢弃迟到/串台事件。
function emitEvent(uiSessionId: string, ev: PiSessionEvent, runId?: string): void {
  const entry = sessions.get(uiSessionId);
  if (ev.type === "crashed") sessions.delete(uiSessionId);
  if (entry && !entry.sender.isDestroyed()) {
    entry.sender.send("pi:event", { uiSessionId, runId, event: ev });
  }
}

// 推一条 extension UI 请求给 renderer（独立于事件流;阶段3 工具确认）。不摘注册表——
// UI 请求不终止会话,会话继续等用户经 pi:uiResponse 回写。
function emitUiRequest(uiSessionId: string, request: PiUiRequest): void {
  const entry = sessions.get(uiSessionId);
  if (entry && !entry.sender.isDestroyed()) {
    entry.sender.send("pi:uiRequest", { uiSessionId, request });
  }
}

// 取会话;不存在即抛错（renderer 的 invoke 会收到 rejection）。
function getSession(uiSessionId: string): PiRpcSession {
  const entry = sessions.get(uiSessionId);
  if (!entry) throw new Error(`pi 会话不存在: ${uiSessionId}`);
  return entry.session;
}

// 命令转发:取会话 → 执行 → 命令级失败（success:false）转成 rejection,成功回 data。
async function command(uiSessionId: string, fn: (s: PiRpcSession) => Promise<RpcResponse>): Promise<unknown> {
  const resp = await fn(getSession(uiSessionId));
  if (!resp.success) throw new Error(resp.error ?? "pi 命令失败");
  return resp.data;
}

export function registerPiSessionHandlers(): void {
  ipcMain.handle("pi:open", async (event, req: PiOpenRequest): Promise<PiOpenResult> => {
    // 同 uiSessionId 重开（renderer 重挂载）:先停旧会话,避免泄漏一个孤儿子进程。
    const prev = sessions.get(req.uiSessionId);
    if (prev) {
      prev.session.stop();
      sessions.delete(req.uiSessionId);
    }

    // 自定义供应商:先生成 extension 文件,把路径塞回 req 供 buildRpcArgs 加 -e（与 cli.ts 同策略）。
    if (req.provider) req.piExtensionPath = writePiExtension(req.provider);
    // 阶段3 深度定制:审批 / 自定义工具 / 斜杠命令样例各生成独立 extension,追加各一个 -e
    // （与 provider extension 共存,provider 注入不动）。
    const extra: string[] = [];
    if (req.enableToolApproval) extra.push(writeApprovalExtension(req.approvalTools));
    if (req.enableSampleTools) extra.push(writeCustomToolExtension());
    if (req.enableSampleCommands) extra.push(writeSlashCommandExtension());
    // askquestion 常驻注入(KTD-4,无开关):每会话高熵 sentinel——extension 经它把信封塞进 input.title,
    // PiRpcSession.handleLine 据同一 sentinel 归一为 method:"askquestion"（防 LLM 在裸 input 的 title 伪造）。
    const askQuestionSentinel = `@@CORTEX_ASKQ:${randomUUID()}@@`;
    extra.push(writeAskQuestionExtension(askQuestionSentinel));
    req.extraExtensionPaths = extra;

    const args = buildRpcArgs(req);
    const transport = spawnPiRpc(args, {
      cwd: req.cwd,
      env: spawnEnvFor({ agent: "pi", provider: req.provider }),
    });
    const session = new PiRpcSession(
      transport,
      (ev, runId) => emitEvent(req.uiSessionId, ev, runId),
      (request) => emitUiRequest(req.uiSessionId, request),
      askQuestionSentinel,
    );
    sessions.set(req.uiSessionId, { session, sender: event.sender });

    try {
      // 就绪靠 get_state 轮询（冷启动 ~790ms,不能用固定 sleep）;顺带取 sessionFile 供恢复。
      const { sessionId, sessionFile } = await session.ready();
      return { uiSessionId: req.uiSessionId, sessionId, sessionFile };
    } catch (e) {
      session.stop();
      sessions.delete(req.uiSessionId);
      throw e instanceof Error ? e : new Error(String(e));
    }
  });

  // ── 运行时命令（均转发到对应 PiRpcSession 方法）──────────────────────────
  ipcMain.handle("pi:prompt", (_e, uiSessionId: string, message: string, runId?: string) =>
    command(uiSessionId, (s) => s.prompt(message, runId)),
  );
  ipcMain.handle("pi:steer", (_e, uiSessionId: string, message: string) =>
    command(uiSessionId, (s) => s.steer(message)),
  );
  ipcMain.handle("pi:followUp", (_e, uiSessionId: string, message: string) =>
    command(uiSessionId, (s) => s.followUp(message)),
  );
  ipcMain.handle("pi:abort", (_e, uiSessionId: string) => command(uiSessionId, (s) => s.abort()));
  ipcMain.handle("pi:fork", (_e, uiSessionId: string, entryId: string) =>
    command(uiSessionId, (s) => s.fork(entryId)),
  );
  // 取可分支的历史消息（编辑重发的分支点预览,与 pi:fork 配套,见 plan §3.6）。
  ipcMain.handle("pi:getForkMessages", (_e, uiSessionId: string) =>
    command(uiSessionId, (s) => s.getForkMessages()),
  );
  ipcMain.handle("pi:setModel", (_e, uiSessionId: string, provider: string, modelId: string) =>
    command(uiSessionId, (s) => s.setModel(provider, modelId)),
  );
  ipcMain.handle("pi:setThinking", (_e, uiSessionId: string, level: string) =>
    command(uiSessionId, (s) => s.setThinkingLevel(level)),
  );
  ipcMain.handle("pi:compact", (_e, uiSessionId: string, customInstructions?: string) =>
    command(uiSessionId, (s) => s.compact(customInstructions)),
  );
  // 阶段4 恢复:从磁盘 JSONL switchSession（独立长超时;best-effort,坏文件 pi 静默起空会话回 success,
  // cwd 缺失走 success:false 被 command 捕获）。
  ipcMain.handle("pi:switchSession", (_e, uiSessionId: string, sessionPath: string) =>
    command(uiSessionId, (s) => s.switchSession(sessionPath)),
  );
  ipcMain.handle("pi:getState", (_e, uiSessionId: string) => command(uiSessionId, (s) => s.getState()));
  ipcMain.handle("pi:getStats", (_e, uiSessionId: string) =>
    command(uiSessionId, (s) => s.getSessionStats()),
  );

  // extension UI 应答:回写到 pi stdin（fire-and-forget,不走 command 等 response）。
  // async 包一层:getSession 的同步抛（会话不存在）转成 rejection,与 renderer invoke 语义一致。
  ipcMain.handle("pi:uiResponse", async (_e, uiSessionId: string, id: string, payload: PiUiResponsePayload) => {
    getSession(uiSessionId).respondUi(id, payload);
  });

  // 显式关闭:停进程 + 摘除注册表（幂等,不存在则静默）。
  ipcMain.handle("pi:close", (_e, uiSessionId: string) => {
    const entry = sessions.get(uiSessionId);
    if (entry) {
      entry.session.stop();
      sessions.delete(uiSessionId);
    }
  });
}

// 退出清理:终止所有 pi RPC 会话子进程（app window-all-closed / before-quit 调）。
export function killAllPiSessions(): void {
  for (const { session } of sessions.values()) session.stop();
  sessions.clear();
}

// 供测试/诊断:当前活跃 pi 会话数。
export function piSessionCount(): number {
  return sessions.size;
}
