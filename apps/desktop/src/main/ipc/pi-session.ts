// pi RPC 长驻会话的 IPC 层。registry 维护 uiSessionId → PiRpcSession（= 一个 pi 子进程）,
// pi:open 建、pi:close 销;命令转发到会话方法,归一化事件经 pi:event 推回 renderer。
// claude/codex 仍走 cli.ts 单发管线,与本通道互不影响。

import { randomUUID } from "crypto";
import { existsSync, promises as fsp } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve, sep } from "path";

import { ipcMain, type WebContents } from "electron";

import { buildRpcArgs, spawnPiRpc, PiRpcSession, type PiImageContent, type RpcResponse } from "../agents/pi-rpc";
import { readImageBytes } from "./image";
import { chatBranchesDir, chatImagesRoot } from "../paths";
import { writePiExtension } from "../agents/pi-providers";
import {
  writeApprovalExtension,
  writeAskQuestionExtension,
  writeCustomToolExtension,
  writePathJailExtension,
  writeSlashCommandExtension,
} from "../agents/pi-extensions";
import { assertSpawnCwd, spawnEnvFor } from "./cli";
import { getPersistedState } from "./store";
import { buildBrowserMcpServerConfig } from "../capabilities/browser/inject";
import { buildDocExtractMcpServerConfig } from "../capabilities/doc-extract/mcp";
import { collectBridgeServers, writeMcpBridgeExtension } from "../agents/pi-mcp-bridge";
import type { PiOpenRequest, PiOpenResult, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "./types";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";
import { createLogger } from "../log";

const log = createLogger("pi-session");

interface SessionEntry {
  session: PiRpcSession;
  sender: WebContents; // 发起 open 的 renderer,事件回推目标（销毁则丢弃）
}

const sessions = new Map<string, SessionEntry>();
type TransientPiUiSession = Pick<PiRpcSession, "respondUi">;

const transientUiSessions = new Map<string, TransientPiUiSession>();

function transientUiKey(uiSessionId: string, requestId: string): string {
  return `${uiSessionId}\0${requestId}`;
}

export function registerTransientPiUiRequest(uiSessionId: string, requestId: string, session: TransientPiUiSession): void {
  transientUiSessions.set(transientUiKey(uiSessionId, requestId), session);
}

export function clearTransientPiUiRequestsForSession(session: TransientPiUiSession): void {
  for (const [id, s] of transientUiSessions) {
    if (s === session) transientUiSessions.delete(id);
  }
}

// 推一条归一化事件给 renderer。crashed 顺带摘除注册表条目（进程已死,避免悬挂）。
// 带 runId（阶段4 代际）:renderer 据此守卫丢弃迟到/串台事件。
function emitEvent(uiSessionId: string, ev: PiSessionEvent, runId?: string): void {
  // text / reasoning 是高频流式增量,交记录端合并为各自的一条生长段(text 与 reasoning 互不合并);
  // 其它事件(tool/turn-end/result/error/crashed 等)走普通 trace,并触发同 run/session 打开段收尾。
  if (ev.type === "text" || ev.type === "reasoning") {
    recordStreamDelta({
      scope: "pi",
      segmentType: ev.type,
      delta: ev.delta,
      runId,
      sessionId: uiSessionId,
      agent: "pi",
    });
  } else {
    recordAgentTrace({
      scope: "pi",
      phase: "event",
      summary: `pi ${ev.type}`,
      runId,
      sessionId: uiSessionId,
      agent: "pi",
      data: { event: ev },
    });
  }
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
  if (!entry) return;
  // 渲染端已销毁(窗口关/reload 且未重开会话)→ 无人能回写;立即回 {cancelled} 解锁 pi 的 ctx.ui await
  // (ctx.ui 未传 signal,abort 不会 reject;不解锁则 pi 的 execute 永久挂起)。confirm/askquestion 共用此兜底。
  if (entry.sender.isDestroyed()) {
    entry.session.respondUi(request.id, { cancelled: true });
    return;
  }
  entry.sender.send("pi:uiRequest", { uiSessionId, request });
}

// 把图片绝对路径读为 pi RPC 的 images content（base64 + mime;经 image.ts 同款根边界/realpath
// /lstat 安全闸门）。任一张读失败 → 抛(整轮 reject,由 sendPiTurn catch 走 failPiTurn,不静默丢图)。
async function buildPiImages(imagePaths: string[] | undefined): Promise<PiImageContent[] | undefined> {
  if (!imagePaths?.length) return undefined;
  const root = chatImagesRoot();
  const images: PiImageContent[] = [];
  for (const p of imagePaths) {
    const { mimeType, base64 } = await readImageBytes(root, p);
    images.push({ type: "image", data: base64, mimeType });
  }
  return images;
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

// U7 路径收敛根:市场扩展 -e 必须落在 pi 库存根（~/.pi:pi install 的 npm/git 包落盘处,C7——
// install 与运行同 HOME,pi 读 ~/.pi/agent/settings.json）内。v1 仅 npm/git（均在库存根内）;
// 未来 local 扩展接入需放宽。可注入根便于测试（无 ~/.pi 的 CI 环境）。
let piExtStoreRoot = resolve(homedir(), ".pi");
/** 测试注入库存根;传 null 复位为 ~/.pi。 */
export function __setPiExtStoreRootForTest(root: string | null): void {
  piExtStoreRoot = root ? resolve(root) : resolve(homedir(), ".pi");
}

// c 必须等于根或在根/ 下。resolve 规范化 `..` 段,挡住 `<root>/../../etc/passwd` 这类逃逸
// （与 skills.ts:39-43 的 isInside 同款收敛）。
function isInsideExtStoreRoot(child: string): boolean {
  const c = resolve(child);
  return c === piExtStoreRoot || c.startsWith(piExtStoreRoot + sep);
}

// U7 坏/越界 -e 隔离:实测 pi 对坏 -e fail-hard——一个失效路径会拖垮整会话。注入前剔除
// (a) 非绝对/不存在路径（防 fail-hard）与 (b) 库存根外路径——被篡改的 store/settings/pi list
// 可能把 -e 指向 ~/.ssh/id_rsa、~/.zshrc 等库存根外现存文件,经 blanket -a 每轮注入执行
// （C3 已承认 settings 可被外部改）。UI 侧已据 pi list 标失踪,此处是注入层最后安全网。
// 返回可加载子集,跳过的打 warn。
export function filterLoadableExtensionPaths(paths: string[] | undefined): string[] {
  if (!paths?.length) return [];
  return paths.filter((p) => {
    if (!isAbsolute(p) || !existsSync(p)) {
      log.warn(`[pi-ext] 注入前跳过失效扩展 -e 路径: ${p}`);
      return false;
    }
    if (!isInsideExtStoreRoot(p)) {
      log.warn(`[pi-ext] 注入前跳过越界扩展 -e 路径(不在 pi 库存根内): ${p}`);
      return false;
    }
    return true;
  });
}

export async function preparePiOpenRequest(req: PiOpenRequest): Promise<PiOpenRequest> {
  const prepared = req;
  if (prepared.provider) prepared.piExtensionPath = writePiExtension(prepared.provider);

  const extra: string[] = [...(prepared.extraExtensionPaths ?? [])];
  if (prepared.enableToolApproval) extra.push(writeApprovalExtension(prepared.approvalTools));
  // 目录执行权限「仅工作目录」/「外部沙箱」:注入 cwd 路径闸 extension(pi 无原生沙箱)。allowed roots =
  // cwd + 已启用 skill 目录(后者避免 skill references 在 cwd 外被误伤)。与审批 extension 共存(多 -e)。
  // 经 preparePiOpenRequest 注入,故 pi 主会话与三段编排子会话(同走此函数)均受路径闸约束。
  if (prepared.confineToCwd) extra.push(writePathJailExtension([prepared.cwd, ...(prepared.skillPaths ?? [])]));
  if (prepared.enableSampleTools) extra.push(writeCustomToolExtension());
  if (prepared.enableSampleCommands) extra.push(writeSlashCommandExtension());

  const askQuestionSentinel =
    prepared.askQuestionSentinel ?? `@@CORTEX_ASKQ:${randomUUID()}@@`;
  prepared.askQuestionSentinel = askQuestionSentinel;
  extra.push(writeAskQuestionExtension(askQuestionSentinel));

  try {
    const gs = (await getPersistedState()).generalSettings;
    const userServers = gs?.mcp?.enabled ? gs.mcp.servers : [];
    const docServer = buildDocExtractMcpServerConfig(prepared.uiSessionId);
    const bridgeInputs = docServer ? [...userServers, docServer] : userServers;
    const browserServer = buildBrowserMcpServerConfig(gs?.browserControl, prepared.uiSessionId);
    const bridgeServers = collectBridgeServers(bridgeInputs, browserServer);
    if (bridgeServers.length) extra.push(writeMcpBridgeExtension(bridgeServers));
  } catch (e) {
    log.warn(`MCP 桥接扩展生成失败: ${String(e)}`);
  }

  prepared.extraExtensionPaths = extra;
  prepared.extensionPaths = filterLoadableExtensionPaths(prepared.extensionPaths);
  return prepared;
}

export function registerPiSessionHandlers(): void {
  ipcMain.handle("pi:open", async (event, req: PiOpenRequest): Promise<PiOpenResult> => {
    // 同 uiSessionId 重开（renderer 重挂载）:先停旧会话,避免泄漏一个孤儿子进程。
    const prev = sessions.get(req.uiSessionId);
    if (prev) {
      prev.session.stop();
      sessions.delete(req.uiSessionId);
    }

    // 扩展准备(provider / 审批 / cwd 路径闸 / askquestion / MCP 桥接 / 市场扩展)统一抽进
    // preparePiOpenRequest —— pi 主会话与三段编排子会话同走此函数,路径闸/审批等一处定义两处复用。
    const prepared = await preparePiOpenRequest(req);
    const args = buildRpcArgs(prepared);
    assertSpawnCwd(prepared.cwd);
    recordAgentTrace({
      scope: "pi",
      phase: "open",
      summary: "pi open",
      sessionId: prepared.uiSessionId,
      agent: "pi",
      data: { cwd: prepared.cwd, argCount: args.length, providerId: prepared.provider?.id },
    });
    const transport = spawnPiRpc(args, {
      cwd: prepared.cwd,
      env: spawnEnvFor({ agent: "pi", provider: prepared.provider }),
    });
    const session = new PiRpcSession(
      transport,
      (ev, runId) => emitEvent(prepared.uiSessionId, ev, runId),
      (request) => emitUiRequest(prepared.uiSessionId, request),
      prepared.askQuestionSentinel,
    );
    sessions.set(prepared.uiSessionId, { session, sender: event.sender });

    // renderer 只 reload 不关窗时,旧 WebContents 销毁但 Map 条目连同 sender 常驻——监听
    // destroyed 主动回收:停子进程 + 摘条目。幂等:仅当条目仍是本会话时才清,避免与 crashed/
    // 重开（pi:open 顶部已 stop 旧会话）的清理重复（防泄漏）。
    event.sender.once("destroyed", () => {
      if (sessions.get(prepared.uiSessionId)?.session === session) {
        session.stop();
        sessions.delete(prepared.uiSessionId);
      }
    });

    try {
      // 就绪靠 get_state 轮询（冷启动 ~790ms,不能用固定 sleep）;顺带取 sessionFile 供恢复。
      const { sessionId, sessionFile } = await session.ready();
      return { uiSessionId: prepared.uiSessionId, sessionId, sessionFile };
    } catch (e) {
      session.stop();
      sessions.delete(prepared.uiSessionId);
      throw e instanceof Error ? e : new Error(String(e));
    }
  });

  // ── 运行时命令（均转发到对应 PiRpcSession 方法）──────────────────────────
  ipcMain.handle("pi:prompt", (_e, uiSessionId: string, message: string, runId?: string, imagePaths?: string[]) =>
    command(uiSessionId, async (s) => {
      recordAgentTrace({
        scope: "pi",
        phase: "command",
        summary: "pi prompt",
        runId,
        sessionId: uiSessionId,
        agent: "pi",
        data: {
          command: "prompt",
          promptPreview: message.length > 300 ? `${message.slice(0, 300)}…` : message,
          imageCount: imagePaths?.length ?? 0,
        },
      });
      const images = await buildPiImages(imagePaths);
      // 无图沿用两参调用,保持既有行为/契约不变。
      return images ? s.prompt(message, runId, images) : s.prompt(message, runId);
    }),
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
  // 分支回复:把当前 live 会话的磁盘 JSONL 复制为不可变快照(chat-branches/<sessionId>/<branchId>.jsonl),
  // 旧分支据快照 switchSession 续聊。快照在 fork rewind **之前**做,故不依赖 fork 的原地/换文件语义。
  // 会话不存在/无 sessionFile/复制失败 → null(调用方把该分支降级为只读)。
  ipcMain.handle("pi:snapshotSession", async (_e, uiSessionId: string, branchId: string): Promise<{ path: string } | null> => {
    if (!/^[\w-]+$/.test(branchId)) return null; // branchId 进入文件名,同 SAFE_ID 校验防路径穿越
    try {
      const entry = sessions.get(uiSessionId);
      if (!entry) return null;
      const resp = await entry.session.getState();
      const src = resp.success ? (resp.data as { sessionFile?: string } | undefined)?.sessionFile : undefined;
      if (!src || !existsSync(src)) return null;
      const dir = chatBranchesDir(uiSessionId);
      await fsp.mkdir(dir, { recursive: true });
      const dest = join(dir, `${branchId}.jsonl`);
      // live 文件本身可能就是该分支此前的快照(切换分支后 switchSession 到快照续写):
      // 自拷贝会把文件截断清空,原样返回即可。
      if (resolve(src) === resolve(dest)) return { path: dest };
      await fsp.copyFile(src, dest);
      return { path: dest };
    } catch (e) {
      log.warn(`pi 会话快照失败(${uiSessionId}/${branchId}): ${String(e)}`);
      return null;
    }
  });
  ipcMain.handle("pi:getStats", (_e, uiSessionId: string) =>
    command(uiSessionId, (s) => s.getSessionStats()),
  );

  // extension UI 应答:回写到 pi stdin（fire-and-forget,不走 command 等 response）。
  // async 包一层:getSession 的同步抛（会话不存在）转成 rejection,与 renderer invoke 语义一致。
  ipcMain.handle("pi:uiResponse", async (_e, uiSessionId: string, id: string, payload: PiUiResponsePayload) => {
    const key = transientUiKey(uiSessionId, id);
    const transient = transientUiSessions.get(key);
    if (transient) {
      transientUiSessions.delete(key);
      transient.respondUi(id, payload);
      return;
    }
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
