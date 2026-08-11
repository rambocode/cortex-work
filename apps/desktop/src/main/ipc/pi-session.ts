// pi 长驻会话的 IPC 层。registry 维护 uiSessionId → PiSessionEngine,
// pi:open 建、pi:close 销;命令转发到会话方法,归一化事件经 pi:event 推回 renderer。
// claude/codex 仍走 cli.ts 单发管线,与本通道互不影响。
//
// ── 引擎已收敛：无条件走 gateway ──────────────────────────────────────────────
// `pi:open` 恒经 `openPiGatewaySession` 建会话：常驻 utilityProcess worker 持有多个
// AgentSession —— `PiGatewaySession`（见 docs/plans/2026-08-06-001-refactor-pi-gateway-worker-plan.md，
// fork + ESM 加载只付一次）。历史上的 binary（bun 二进制 + `--mode rpc` 手抄协议）与
// inproc（主进程内 `createAgentSession`）两条选路已删除。本文件**不含任何引擎分支**：
// registry、命令转发、UI 回写、清理路径全部只依赖 `PiSessionEngine` 契约。

import { randomUUID } from "crypto";
import { existsSync, promises as fsp } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve, sep } from "path";

import { app, ipcMain, type WebContents } from "electron";

import type { PiImageContent, RpcResponse } from "../agents/pi-inproc/rpc-shared";
import type { PiSessionEngine } from "../agents/pi-inproc";
import { openPiGatewaySession } from "../agents/pi-gateway/client";
import { readImageBytes } from "./image";
import { chatBranchesDir, chatImagesRoot } from "../paths";
import { resolvePiProviderInput } from "../providers/pi-provider-input";
import { assertSpawnCwd, resolveSpawnCwd } from "./cli";
import { getPersistedState } from "./store";
import { buildBrowserMcpServerConfig } from "../capabilities/browser/inject";
import { buildAgentBrowserMcpServerConfig, migrateLegacyAgentBrowserMcp } from "../capabilities/agent-browser/inject";
import { resolveAgentBrowserBinary } from "../capabilities/agent-browser/locate";
import { buildDocExtractMcpServerConfig } from "../capabilities/doc-extract/mcp";
import { buildKnowledgeMcpServerConfig } from "../capabilities/knowledge/inject";
import { GROUNDING_MODEL_ENV, resolveComputerUse } from "../capabilities/computer-use/inject";
import { buildResearchMcpServerConfig } from "../capabilities/research/inject";
import { unregisterResearchSession } from "../capabilities/research/server";
import { buildMediaGenMcpServerConfig, unregisterMediaGenSession } from "../capabilities/media-gen/server";
import { buildLoopWorkflowsMcpServerConfig, unregisterLoopWorkflowsSession } from "../capabilities/loop-workflows/server";
import { buildAutomationMcpServerConfig, unregisterAutomationSession } from "../capabilities/automation/server";
import { ensureVoiceAssistantMcpServerConfig } from "../capabilities/voice-intent/assistant-tools";
import { buildCalendarMcpServerConfig, unregisterCalendarSession } from "../capabilities/calendar/server";
import { ensureDelegateMcpServerConfig } from "../capabilities/delegate/server";
import { loadWorkflows } from "../workflow/store";
import { collectBridgeServers, mcpServerToBridge, type BridgeServer } from "../agents/pi-mcp-bridge";
import {
  type McpServerConfig,
  type PiOpenRequest,
  type PiOpenResult,
  type PiSessionEvent,
  type PiUiRequest,
  type PiUiResponsePayload,
} from "./types";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";
import { createLogger } from "../log";
import {
  assertPiArtifactPromptIdentity,
  createPiArtifactRuntime,
  createPiDelegateRuntime,
  disposePiArtifactRuntime,
  disposePiDelegateRuntime,
  isPiDelegateUiRequestId,
  renewPiArtifactRuntime,
  type PiArtifactRuntime,
  type PiDelegateRuntime,
  type PiDelegateRuntimeDeps,
  type TransientPiUiSession,
} from "./pi-delegate";

const log = createLogger("pi-session");

interface SessionEntry {
  session: PiSessionEngine; // 引擎契约（gateway worker 内的 AgentSession 的主进程 handle）
  owner: WebContents; // 发起 open 的 renderer；既是事件回推目标，也是全部 pi:* 命令的权限边界。
  ownerDestroyedListener?: () => void; // 随 entry 销毁解绑，避免指纹重开向同一窗口累积 listener。
  generation: symbol; // 同 uiSessionId 的进程世代；旧 gateway 迟到事件不得命中新 registry。
  request: PiOpenRequest; // 已准备的父请求；abort 后下一轮可据此重建 delegate state。
  delegate?: PiDelegateRuntime;
  artifact?: PiArtifactRuntime;
  /**
   * 当前 `pi:prompt` 的主进程准备代际。图片读取发生在真正调用 engine.prompt 之前，
   * abort/close/replace 必须能把这段在途准备标成取消，防止「先停止、后启动」。
   */
  prompt?: PromptGeneration;
}

interface PromptGeneration {
  runId?: string;
  cancelled: boolean;
  /** 只撤销本 prompt 创建的能力代际，旧回调不得误删下一轮。 */
  delegate?: PiDelegateRuntime;
  artifact?: PiArtifactRuntime;
}

const sessions = new Map<string, SessionEntry>();

interface OpeningEntry {
  owner: WebContents;
  generation: symbol;
  cancelled: boolean;
  /** gateway 已登记但 open 尚未完成的 handle，用于 startup UI 回写和取消。 */
  session?: PiSessionEngine;
}

// prepare/provider/MCP/gateway open 都有 await，sessions 尚未登记时也必须占住 owner 权。
// 同 id 并发 open 直接拒绝，由 renderer 的 ensurePiSession 负责同配置去重/异配置串行。
const openingSessions = new Map<string, OpeningEntry>();

interface TransientPiUiEntry {
  session: TransientPiUiSession;
  owner: WebContents;
  uiSessionId: string;
  requestId: string;
}

const transientUiSessions = new Map<string, TransientPiUiEntry>();

function transientUiKey(uiSessionId: string, requestId: string): string {
  return `${uiSessionId}\0${requestId}`;
}

export function registerTransientPiUiRequest(
  uiSessionId: string,
  requestId: string,
  session: TransientPiUiSession,
  owner: WebContents,
): void {
  // 编排段/delegate child 不进长会话 sessions 表，因此临时路由自身必须携带 owner。
  // 否则为了让审批回写先于长会话查找，会同时打开跨 WebContents 代答面。
  transientUiSessions.set(transientUiKey(uiSessionId, requestId), {
    session,
    owner,
    uiSessionId,
    requestId,
  });
}

export function clearTransientPiUiRequestsForSession(session: TransientPiUiSession): void {
  for (const [id, entry] of transientUiSessions) {
    if (entry.session !== session) continue;
    transientUiSessions.delete(id);
    // renderer 的弹窗队列与主进程 transient map 是两份状态；只摘 map 会留下一张
    // 已无 worker 接收的残卡。撤销事件只带定位键，不含命令内容。
    if (entry.owner.isDestroyed()) continue;
    try {
      entry.owner.send("pi:uiCancel", {
        uiSessionId: entry.uiSessionId,
        requestId: entry.requestId,
      });
    } catch (error) {
      log.debug(`Pi transient UI 撤销转发失败(${entry.uiSessionId}): ${String(error)}`);
    }
  }
}

function cleanupPiCapabilitySessions(uiSessionId: string): void {
  unregisterResearchSession(uiSessionId);
  unregisterMediaGenSession(uiSessionId);
  unregisterLoopWorkflowsSession(uiSessionId);
  unregisterAutomationSession(uiSessionId);
  unregisterCalendarSession(uiSessionId);
}

/** 撤销一个 prompt 准备代际及其专属能力；对象身份守卫避免旧代清掉新代。 */
function cancelPromptGeneration(entry: SessionEntry, prompt: PromptGeneration | undefined = entry.prompt): void {
  if (!prompt) return;
  prompt.cancelled = true;
  if (prompt.delegate) {
    disposePiDelegateRuntime(prompt.delegate);
    if (entry.delegate === prompt.delegate) entry.delegate = undefined;
    prompt.delegate = undefined;
  }
  if (prompt.artifact) {
    disposePiArtifactRuntime(prompt.artifact);
    if (entry.artifact === prompt.artifact) entry.artifact = undefined;
    prompt.artifact = undefined;
  }
}

function promptGenerationIsActive(
  uiSessionId: string,
  entry: SessionEntry,
  prompt: PromptGeneration,
): boolean {
  return sessions.get(uiSessionId) === entry && entry.prompt === prompt && !prompt.cancelled;
}

/** 用户已经停止本轮时返回成功 no-op，避免 renderer 把主动取消再渲染成「启动失败」。 */
function cancelledPromptResponse(): RpcResponse {
  return {
    type: "response",
    command: "prompt",
    success: true,
    data: { accepted: false, cancelled: true },
  };
}

function disposeSessionEntry(uiSessionId: string, entry: SessionEntry, stopSession: boolean): void {
  try {
    if (entry.ownerDestroyedListener) {
      entry.owner.removeListener("destroyed", entry.ownerDestroyedListener);
      entry.ownerDestroyedListener = undefined;
    }
    cancelPromptGeneration(entry);
    entry.prompt = undefined;
    disposePiDelegateRuntime(entry.delegate);
    entry.delegate = undefined;
    disposePiArtifactRuntime(entry.artifact);
    entry.artifact = undefined;
    if (stopSession) entry.session.stop();
  } finally {
    if (sessions.get(uiSessionId) === entry) sessions.delete(uiSessionId);
    cleanupPiCapabilitySessions(uiSessionId);
  }
}

// 推一条归一化事件给 renderer。crashed 顺带摘除注册表条目（进程已死,避免悬挂）。
// 带 runId（阶段4 代际）:renderer 据此守卫丢弃迟到/串台事件。
function emitEvent(uiSessionId: string, generation: symbol, ev: PiSessionEvent, runId?: string): void {
  const entry = sessions.get(uiSessionId);
  // stop/worker crash 与同 id 重开可并发；旧世代迟到 crashed 若只按 id 查表，会把
  // 已就绪的新会话 dispose。UI 请求也遵守同一世代闸，不路由给新进程。
  if (!entry || entry.generation !== generation) return;
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
  if (
    ev.type === "settled" &&
    entry?.artifact &&
    entry.artifact.designState.runId === runId
  ) {
    // artifact 写能力只属于当前 prompt 代际。按 runId 守卫后撤销，避免旧 turn 的迟到 settled
    // 把已经登记好的新 turn state 删除；下一次 prompt 会重新建立一份干净代际。
    disposePiArtifactRuntime(entry.artifact);
    entry.artifact = undefined;
  }
  if (ev.type === "settled" && entry.prompt?.runId === runId) {
    // authoritative settled 结束本轮；这里只摘准备代际，不再 abort 已自然完成的能力。
    entry.prompt = undefined;
  }
  if (ev.type === "crashed" && entry) {
    // worker 已经宣告本会话崩溃，不再重复 stop；但 delegate controller 与 MCP 授权映射仍由
    // 主进程持有，必须同步撤销。entry 保留在局部变量中，确保 crashed 本身仍能推给 renderer。
    disposeSessionEntry(uiSessionId, entry, false);
  }
  if (entry && !entry.owner.isDestroyed()) {
    entry.owner.send("pi:event", { uiSessionId, runId, event: ev });
  }
}

// 推一条 extension UI 请求给 renderer（独立于事件流;阶段3 工具确认）。不摘注册表——
// UI 请求不终止会话,会话继续等用户经 pi:uiResponse 回写。
function emitUiRequest(uiSessionId: string, generation: symbol, request: PiUiRequest): void {
  const entry = sessions.get(uiSessionId);
  if (entry?.generation === generation) {
    // 渲染端已销毁(窗口关/reload 且未重开会话)→ 无人能回写;立即回 {cancelled}
    // 解锁 pi 的 ctx.ui await。confirm/askquestion 共用此兜底。
    if (entry.owner.isDestroyed()) {
      entry.session.respondUi(request.id, { cancelled: true });
      return;
    }
    entry.owner.send("pi:uiRequest", { uiSessionId, request });
    return;
  }

  // `session_start` handler 可在 openPiGatewaySession() 完成前弹对话。此时 sessions 还没 entry，
  // 但 gateway handle 已在 opening 句柄上；仍需推主界面，否则 worker open 与 UI 互相等待。
  const opening = openingSessions.get(uiSessionId);
  if (!opening || opening.generation !== generation || opening.cancelled || !opening.session) return;
  if (opening.owner.isDestroyed()) {
    opening.session.respondUi(request.id, { cancelled: true });
    return;
  }
  opening.owner.send("pi:uiRequest", { uiSessionId, request });
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
function getOwnedSessionEntry(uiSessionId: string, sender: WebContents): SessionEntry {
  const entry = sessions.get(uiSessionId);
  if (!entry) throw new Error(`pi 会话不存在: ${uiSessionId}`);
  // uiSessionId 由 renderer 自己提供，不能当 capability token。否则另一个窗口只要猜到 id，
  // 就能替 owner prompt/abort/审批/close，甚至用 pi:open 抢占同 id 后接管事件流。
  if (entry.owner !== sender) throw new Error(`pi 会话不属于当前 renderer: ${uiSessionId}`);
  return entry;
}

// 命令转发:取会话 → 执行 → 命令级失败（success:false）转成 rejection,成功回 data。
async function command(
  sender: WebContents,
  uiSessionId: string,
  fn: (s: PiSessionEngine, entry: SessionEntry) => Promise<RpcResponse>,
): Promise<unknown> {
  const entry = getOwnedSessionEntry(uiSessionId, sender);
  const resp = await fn(entry.session, entry);
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

export async function preparePiOpenRequest(
  req: PiOpenRequest,
  options: {
    profile?: "parent" | "child";
    requiredArtifactBridges?: readonly BridgeServer[];
  } = {},
): Promise<PiOpenRequest> {
  const prepared = req;
  const profile = options.profile ?? "parent";
  // ⚠️ 安全:req 是 renderer 经 IPC 传来的对象,而下面这两个字段是**主进程内部填充**的。
  // computerUseEnv 会被 worker 原样写进自己的 process.env,customProviderEnv 是历史上
  // binary 路径的 spawn env 注入口——不先清空的话,renderer 可以借它们注入任意环境变量。
  // 类型注释写了「renderer 不传」,但注释拦不住任何人,必须在边界上真删。
  delete prepared.customProviderEnv;
  delete prepared.computerUseEnv;
  // 这些字段都只允许主进程在本函数内生成。renderer 或父请求快照若能把它们带进 child，
  // 就能绕过 server allowlist 注入任意 MCP / in-process extension。
  delete prepared.bridgeServers;
  delete prepared.requiredBridgeServerIds;
  delete prepared.inProcExtensionPaths;
  delete prepared.extraExtensionPaths;
  delete prepared.piExtensionPath;
  // provider 与上面的 bridge/env 同属主进程权威字段。无论请求来自 renderer 还是内部 child，
  // 都只能携带 providerId；endpoint 快照必须在本边界重新解析，不能沿用调用方塞入的对象。
  delete prepared.provider;
  // jsReplSentinel 同为主进程内部字段:renderer 若能预置它,就能伪造 method:"jsrepl" 的触发前缀。
  delete prepared.jsReplSentinel;
  // cwd 归一放在最前:空串历史上会让 spawn 继承 Electron 自己的工作目录;gateway 下 worker 的
  // 会话文件与工具根同样按它推导,语义保留。见 cli.resolveSpawnCwd。
  prepared.cwd = resolveSpawnCwd(prepared.cwd);
  const isArtifact = prepared.artifactContext !== undefined;
  if (profile === "child" && (isArtifact || prepared.delegateRoles?.length)) {
    throw new Error("Pi child 不得继承 artifact 或 delegate 能力");
  }
  if (profile === "child") {
    // 旧 delegate child 是 bare 运行时：只保留模型/provider、cwd、skills/persona 与审批/白名单。
    // 不读取任何全局 MCP 配置，也不加载普通聊天/市场扩展；因此即使父会话能力很多，child 仍
    // 只能使用 Pi 内置工具，并由下面保留的 enableToolApproval/approvalTools 走父窗口审批。
    prepared.extensionPaths = [];
    prepared.webSearch = false;
    prepared.enableArtifactsTool = false;
    prepared.enableJsReplTool = false;
    prepared.enableSampleTools = false;
    prepared.enableSampleCommands = false;
  }
  if (isArtifact) {
    // artifact RPC 只迁移旧 one-shot lane 已有的能力面。市场扩展、示例工具、inline artifact 与
    // javascript_repl 都属于普通聊天能力；即使 renderer 被篡改后显式传 true/路径也在主进程清掉。
    prepared.extensionPaths = [];
    prepared.inProcExtensionPaths = undefined;
    prepared.enableArtifactsTool = false;
    prepared.enableJsReplTool = false;
    prepared.enableSampleTools = false;
    prepared.enableSampleCommands = false;
  }
  // 供应商解析:renderer 只给 providerId。gateway 下模型/凭据的**最终**解析在 worker 侧
  // （credentials 经 RPC 回主进程取,见 pi-gateway 的 KTD1）,providerId 随 open 参数透传;
  // 这里只把「Catalog + provider-prefs」合成的 endpoint 覆盖挂上 prepared.provider——
  // worker 的 applyBaseUrlOverride 靠它登记 baseUrl 覆盖,漏掉即「设置里配好了自建网关,
  // 请求却发官方地址」的静默失败。
  // 自定义 Provider 在此解析不出（resolvePiProviderInput 只认 Catalog）→ provider 留空,
  // worker 侧 resolveModel 会以「供应商没有可用模型」响亮失败,绝不静默换模型。
  if (prepared.providerId) {
    const provider = await resolvePiProviderInput(prepared.providerId);
    if (provider) prepared.provider = provider;
  }

  const askQuestionSentinel =
    prepared.askQuestionSentinel ?? `@@CORTEX_ASKQ:${randomUUID()}@@`;
  prepared.askQuestionSentinel = askQuestionSentinel;
  // jsrepl 的会话级 sentinel:仅在 renderer 请求启用该工具时生成（不启用就不给 normalize 分支
  // 留任何可命中的前缀）。上方已 delete renderer 传入的同名字段,这里必为新生成值。
  if (prepared.enableJsReplTool) prepared.jsReplSentinel = `@@CORTEX_JSREPL:${randomUUID()}@@`;

  // child profile 到此已完成全部必要准备。后续代码会读取用户设置并注册普通聊天 MCP / Computer
  // Use，绝不能让 delegate/design child 进入；空 bridgeServers 也让 worker 侧工具集可直接断言。
  if (profile === "child") {
    prepared.bridgeServers = [];
    prepared.requiredBridgeServerIds = [];
    prepared.extensionPaths = [];
    return prepared;
  }

  // delegate 是调用方明确声明的本轮必需能力，不得与普通可选 MCP 一起 best-effort 降级。
  // state 已由 pi:open 在 prepare 前登记；这里先独立启动 host 并验证桥接形状，失败就响亮拒绝 open。
  let delegateServer: McpServerConfig | null = null;
  if (prepared.delegateRoles?.length) {
    try {
      delegateServer = await ensureDelegateMcpServerConfig(prepared.uiSessionId);
    } catch (error) {
      throw new Error(`Pi delegate MCP 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!delegateServer || !mcpServerToBridge(delegateServer)) {
      throw new Error("Pi delegate MCP 不可用，无法建立带委派能力的会话");
    }
  }
  const delegateBridge = delegateServer ? mcpServerToBridge(delegateServer) : null;
  const requiredBridges = [
    ...(options.requiredArtifactBridges ?? []),
    ...(delegateBridge ? [delegateBridge] : []),
  ].filter(
    (bridge, index, all) => all.findIndex((candidate) => candidate.id === bridge.id) === index,
  );
  prepared.requiredBridgeServerIds = requiredBridges.map((bridge) => bridge.id);

  try {
    const state = await getPersistedState();
    const gs = state.generalSettings;
    const migratedMcp = migrateLegacyAgentBrowserMcp(gs?.mcp ?? { enabled: false, servers: [] });
    // artifact 沿用旧 Pi one-shot 的最小 MCP 面，不继承普通聊天的用户 MCP。
    const userServers = !isArtifact && migratedMcp.enabled ? migratedMcp.servers : [];
    const docServer = buildDocExtractMcpServerConfig(prepared.uiSessionId);
    const agentBrowserServer = isArtifact
      ? null
      : buildAgentBrowserMcpServerConfig(
          gs?.agentBrowser,
          prepared.uiSessionId,
          resolveAgentBrowserBinary({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: app.getAppPath(),
            platform: process.platform,
            arch: process.arch,
          }),
        );
    // 研究引擎:pi 与 claude/codex 拿到同一套联网能力(web_search / web_read)。
    // pi 走 mcpInjection==="none",不经 cli.ts 的 builtinServers 数组,必须在这里单独并入——
    // 漏掉它就会出现「同一个开关，claude 能搜、pi 不能」这种查起来很费劲的不一致。
    //
    // 准入同 claude/codex 走会话级的 webSearch。差别在生效时机:pi 的工具集在 open 时冻结,
    // 故 renderer 侧把 webSearch 计入 extensionFingerprint,中途切开关会触发会话重开。
    const researchServer = buildResearchMcpServerConfig(
      gs?.researchEngine,
      prepared.uiSessionId,
      prepared.artifactContext?.kind === "slides" ? "slides" : "chat",
      prepared.webSearch === true,
    );
    // 公司知识库:与 claude/codex 拿到同一套知识库工具。pi 走 mcpInjection==="none",
    // 不经 cli.ts 的 builtinServers 数组,必须在这里单独并入——漏掉它就会出现
    // 「同一个开关，claude 能查知识库、pi 不能」这种查起来很费劲的不一致。
    // 无会话级开关,故不必计入 extensionFingerprint(改设置后重开会话即生效)。
    const knowledgeServer = isArtifact ? null : buildKnowledgeMcpServerConfig(gs?.knowledgeBase);
    // 媒体生成:pi 走 mcpInjection==="none",必须在此并入——否则「同一开关 claude 能生图、pi 不能」。
    // 工具集在 open 时冻结:改设置后重开会话生效(同 knowledge 语义,不计 extensionFingerprint);
    // handler 每次调用仍读最新设置做 enabled gate,中途禁用会得到可读错误而非静默成功。
    // X-Cortex-Session 用 prepared.uiSessionId(与 doc-extract/research 同款),sessionStateMap 按
    // 该 id 存 cwd——pi RPC 会话 cwd 固定于 open 时,语义成立。
    const mediaGenServer = buildMediaGenMcpServerConfig(
      state.mediaGenSettings,
      prepared.uiSessionId,
      prepared.cwd,
    );
    // loop 工作流:同上必须在此并入;loadWorkflows 失败降级不注入(不阻断 pi 启动)。
    const workflowsForMcp = await loadWorkflows().catch(() => []);
    const loopServer = buildLoopWorkflowsMcpServerConfig(workflowsForMcp, prepared.uiSessionId, prepared.cwd);
    // 自动化（会话内管理定时任务）与系统日历:**只在这条 pi RPC 聊天路径注入**。
    //
    // 它们的写工具（create_automation / delete_automation / create_calendar_event 等）必须逐次
    // 经用户确认,而真审批回路只有这里有——claude 在 full-auto 下走 --dangerously-skip-permissions、
    // codex 的内置 server 被强制 default_tools_approval_mode="approve"、pi 单发路径不写审批
    // extension 且 ctx.hasUI 为 false。所以刻意**不**并进 cli.ts 的 builtinServers / piBridgeCfgs,
    // 与 capabilities/computer-use/inject.ts 的既定判例同源。
    //
    // 定时任务自身的执行路径（automation/runner.ts）同样拿不到:它自己拼 CliStartRequest 直接
    // spawn,根本不经过本函数;两个 server 内部还有 sessionStateMap 未登记即不注册工具的守卫兜底。
    //
    // 执行上下文（cwd/model/providerId）从本会话继承,自动化建出来的任务即「跟当前对话一样地跑」。
    const automationServer = isArtifact
      ? null
      : buildAutomationMcpServerConfig(
          prepared.uiSessionId,
          {
            cwd: prepared.cwd,
            agent: "pi",
            model: prepared.model,
            // 刻意不带 effort：pi RPC 会话用的是 thinkingLevel（--thinking），与自动化落盘的
            // ReasoningEffort 不是同一个刻度，硬映射只会得到一个看似合理实则随意的值。
            // 留空即用默认强度，用户要调可以去自动化界面改。
            providerId: prepared.providerId,
          },
          gs?.automationTools,
        );
    // 日历门控自带四道（非 macOS / helper 缺失 / 授权非 full / host 不可用）,故无独立开关。
    // allowWrite 只在这条路径为 true。探测失败降级不注入,不阻断 pi 启动。
    const calendarServer = isArtifact
      ? null
      : await buildCalendarMcpServerConfig(prepared.uiSessionId, true).catch(() => null);
    // 语音助手控制工具(voice_exit_assistant 等):常驻聊天路径注入——pi 工具集 open 时冻结,
    // 语音助手常在会话已开后才激活,按轮注入意味着每次都得重开会话。安全门控在执行面:
    // handler 验语音激活态,普通打字轮误调无副作用(见 assistant-tools.ts 文件头)。
    const voiceAssistantServer = isArtifact
      ? null
      : await ensureVoiceAssistantMcpServerConfig(prepared.uiSessionId).catch(() => null);
    const bridgeInputs = [
      ...userServers,
      ...(docServer ? [docServer] : []),
      ...(agentBrowserServer ? [agentBrowserServer] : []),
      ...(researchServer ? [researchServer] : []),
      ...(knowledgeServer ? [knowledgeServer] : []),
      ...(mediaGenServer ? [mediaGenServer] : []),
      ...(loopServer ? [loopServer] : []),
      ...(automationServer ? [automationServer] : []),
      ...(calendarServer ? [calendarServer] : []),
      ...(voiceAssistantServer ? [voiceAssistantServer] : []),
      ...(delegateServer ? [delegateServer] : []),
    ];
    const browserServer = isArtifact
      ? null
      : buildBrowserMcpServerConfig(gs?.browserControl, prepared.uiSessionId);
    // 结构化桥接配置随 open 参数进 worker,由 capabilities.ts 原生注册成 customTools。
    const collected = collectBridgeServers(bridgeInputs, browserServer);
    // required artifact/delegate 以主进程独立验证后的 bridge 为真值；同 id 用户配置不能抢占。
    const requiredIds = new Set(requiredBridges.map((server) => server.id));
    prepared.bridgeServers = [
      ...collected.filter((server) => !requiredIds.has(server.id)),
      ...requiredBridges,
    ];
  } catch (e) {
    log.warn(`MCP 桥接配置收集失败: ${String(e)}`);
    // 普通 MCP 读取/转换失败可以降级，但 required artifact/delegate 已独立验证，必须完整保留。
    prepared.bridgeServers = [...requiredBridges];
  }

  // Computer Use（pi-computer-use package,操作真实桌面 GUI）。
  // 独立 try 而非并进上面那块:它不是 MCP 桥接,混进去会让失败日志张冠李戴。
  // 只在这条聊天会话路径注入——单发路径无审批 UI,详见 capabilities/computer-use/inject.ts 的说明。
  if (!isArtifact) try {
    const gs = (await getPersistedState()).generalSettings;
    // pi 在常驻 worker 里，主进程写自己的 env 对它无效（两个 agent 独立发现的坑），
    // 必须经 computerUseEnv 传过去由 worker 的 applyComputerUseEnv 落地。
    // ⚠️ 常驻进程的 env **跨会话残留**：注入轮必须显式携带 grounding 键——有值 = 写，
    // 空串 = 删（worker 侧语义），整个字段缺省 = 门控未过、一个字节不碰。少了空串这条，
    // 用户清空设置后旧模型名会在 worker 里永久粘住。
    const cu = await resolveComputerUse(gs?.computerUse);
    if (cu.path) {
      prepared.inProcExtensionPaths = [cu.path];
      prepared.computerUseEnv = { ...cu.env, [GROUNDING_MODEL_ENV]: cu.env[GROUNDING_MODEL_ENV] ?? "" };
    }
  } catch (e) {
    log.warn(`Computer Use 注入决策失败,本轮不注入: ${String(e)}`);
  }

  prepared.extensionPaths = filterLoadableExtensionPaths(prepared.extensionPaths);
  return prepared;
}

// delegate child 复用父会话的准备与注册表，但运行时实现不反向依赖本 IPC 模块。
// 这四项是 pi-session 独有状态的完整 seam；gateway、cwd 校验与 delegate host 由新模块直接依赖。
const piDelegateRuntimeDeps: PiDelegateRuntimeDeps = {
  prepareOpenRequest: preparePiOpenRequest,
  cleanupCapabilitySessions: cleanupPiCapabilitySessions,
  registerTransientUiRequest: registerTransientPiUiRequest,
  clearTransientUiRequestsForSession: clearTransientPiUiRequestsForSession,
};

export function registerPiSessionHandlers(): void {
  ipcMain.handle("pi:open", async (event, req: PiOpenRequest): Promise<PiOpenResult> => {
    const uiSessionId = req.uiSessionId;
    const pending = openingSessions.get(uiSessionId);
    if (pending) {
      if (pending.owner !== event.sender) {
        throw new Error(`pi 会话不属于当前 renderer: ${uiSessionId}`);
      }
      throw new Error(`pi 会话正在开启: ${uiSessionId}`);
    }

    // 已就绪与 opening 两张表都要验 owner：uiSessionId 只是可猜字符串，不是 capability token。
    const prev = sessions.get(req.uiSessionId);
    if (prev && prev.owner !== event.sender) {
      throw new Error(`pi 会话不属于当前 renderer: ${req.uiSessionId}`);
    }
    const opening: OpeningEntry = {
      owner: event.sender,
      generation: Symbol(uiSessionId),
      cancelled: event.sender.isDestroyed(),
    };
    openingSessions.set(uiSessionId, opening);
    let openedEntry: SessionEntry | undefined;
    const onOwnerDestroyed = () => {
      opening.cancelled = true;
      if (openedEntry && sessions.get(uiSessionId) === openedEntry) {
        disposeSessionEntry(uiSessionId, openedEntry, true);
      } else {
        // open/rebind 可能正等 startup dialog；早停 handle 会 reject 在途 open，并让
        // worker closeSession 标记 opening 代际取消，不必等 120s open 超时。
        opening.session?.stop();
      }
    };
    event.sender.once("destroyed", onOwnerDestroyed);

    const assertOpeningActive = (): void => {
      if (
        opening.cancelled ||
        event.sender.isDestroyed() ||
        openingSessions.get(uiSessionId) !== opening
      ) {
        throw new Error(`pi 会话开启已取消: ${uiSessionId}`);
      }
    };

    try {
      assertOpeningActive();
      // 同 owner 重开（renderer 重挂载）:抢到 opening lease 后再停旧会话，避免并发 open 互相覆盖。
      if (prev && sessions.get(uiSessionId) === prev) {
        disposeSessionEntry(uiSessionId, prev, true);
      }

      // artifact/delegate host 的 tools/list 会在 gateway open 后立即发生，必须先登记本轮 state。
      // artifact 还会在此复验 registered root/cwd/index，并把 design/slides MCP 提升为 required。
      let artifact: PiArtifactRuntime | undefined;
      let delegate: PiDelegateRuntime | undefined;
      let prepared: PiOpenRequest;
      try {
        artifact = await createPiArtifactRuntime(req, event.sender, piDelegateRuntimeDeps);
        assertOpeningActive();
        delegate = createPiDelegateRuntime(req, event.sender, piDelegateRuntimeDeps);
        // 扩展准备(provider / cwd 路径闸 / askquestion / MCP 桥接 / 市场扩展)统一抽进
        // preparePiOpenRequest —— Pi 主会话与 delegate 子会话同走此函数，路径闸、审批集与能力注入
        // 一处定义、两处复用。
        prepared = await preparePiOpenRequest(req, {
          requiredArtifactBridges: artifact?.requiredBridgeServers,
        });
        assertOpeningActive();
        assertSpawnCwd(prepared.cwd);
      } catch (error) {
        disposePiDelegateRuntime(delegate);
        disposePiArtifactRuntime(artifact);
        cleanupPiCapabilitySessions(req.uiSessionId);
        throw error instanceof Error ? error : new Error(String(error));
      }

      recordAgentTrace({
        scope: "pi",
        phase: "open",
        summary: "pi open",
        sessionId: prepared.uiSessionId,
        agent: "pi",
        // model:调试跟踪需能直读会话启动模型(缺省 = pi 自身默认;运行时可经 pi:setModel 切换)。
        data: {
          cwd: prepared.cwd,
          model: prepared.model ?? "(默认)",
          engine: "gateway",
          providerId: prepared.provider?.id,
        },
      });

      // 无条件走 gateway：能力组装在 worker 侧（capabilities.ts）按 prepared 里的结构化字段完成；
      // hasUiOutlet 经 open 协议下发，由传了 onUiRequest 这一事实决定。
      let session: PiSessionEngine | undefined;
      try {
        session = await openPiGatewaySession({
          request: prepared,
          onEvent: (ev, runId) => emitEvent(prepared.uiSessionId, opening.generation, ev, runId),
          onUiRequest: (request) => emitUiRequest(prepared.uiSessionId, opening.generation, request),
          onSessionCreated: (created) => {
            if (
              opening.cancelled ||
              event.sender.isDestroyed() ||
              openingSessions.get(uiSessionId) !== opening
            ) {
              created.stop();
              return;
            }
            opening.session = created;
          },
        });
        assertOpeningActive();
      } catch (error) {
        // owner 可在 gateway open await 期间销毁，killAll/pi:close 也可取消 lease。若迟到
        // engine 已经构造成功，拒绝 open 前必须就地 stop，不能只清能力注册表。
        session?.stop();
        disposePiDelegateRuntime(delegate);
        disposePiArtifactRuntime(artifact);
        cleanupPiCapabilitySessions(prepared.uiSessionId);
        throw error instanceof Error ? error : new Error(String(error));
      }
      const entry: SessionEntry = {
        session,
        owner: event.sender,
        ownerDestroyedListener: onOwnerDestroyed,
        generation: opening.generation,
        request: prepared,
        delegate,
        artifact,
      };
      openedEntry = entry;
      sessions.set(prepared.uiSessionId, entry);

      try {
        // 就绪靠 get_state 轮询（冷启动 ~790ms,不能用固定 sleep）;顺带取 sessionFile 供恢复。
        const { sessionId, sessionFile } = await session.ready();
        assertOpeningActive();
        if (sessions.get(prepared.uiSessionId) !== entry) {
          throw new Error(`pi 会话开启已取消: ${prepared.uiSessionId}`);
        }
        // 斜杠命令表缓存:让「扩展命令补发收尾」由命令来源精确判定,而非按 / 前缀猜。不 await——
        // 它只影响补发判定的精度（缺失时自动退回宽限窗兜底），不该拖慢开会话这条关键路径。
        void session.loadSlashCommands();
        return { uiSessionId: prepared.uiSessionId, sessionId, sessionFile };
      } catch (e) {
        disposeSessionEntry(prepared.uiSessionId, entry, true);
        throw e instanceof Error ? e : new Error(String(e));
      }
    } finally {
      if (openingSessions.get(uiSessionId) === opening) openingSessions.delete(uiSessionId);
      // 成功会话继续保留 destroyed 监听；失败/取消的 opening 不留累积 listener。
      if (!openedEntry || sessions.get(uiSessionId) !== openedEntry) {
        event.sender.removeListener("destroyed", onOwnerDestroyed);
      }
    }
  });

  // ── 运行时命令（均转发到对应 PiSessionEngine 方法）──────────────────────────
  ipcMain.handle("pi:prompt", (event, uiSessionId: string, message: string, runId?: string, imagePaths?: string[]) =>
    command(event.sender, uiSessionId, async (s, entry) => {
      // runId 与 artifactContext 必须在主进程重新成对校验：artifact 不能借普通会话调用，普通会话
      // 也不能伪造 artifact:* 前缀取得能力。校验在重建 state 和执行 prompt 之前，失败无副作用。
      assertPiArtifactPromptIdentity(entry.request, runId);
      // 同 entry 的上一条 prompt 即使还卡在图片读取，也已被新一轮取代。先取消旧准备代际，
      // 后续迟到 continuation 只能返回 no-op，不能再启动旧 prompt 或撤销本轮能力。
      cancelPromptGeneration(entry);
      const promptGeneration: PromptGeneration = {
        runId,
        cancelled: false,
      };
      entry.prompt = promptGeneration;
      // delegatePolicy 的 maxChildRuns 是“每轮”预算。即便上一轮正常结束、controller 未 abort，
      // 也不能沿用 childRunCount/并行队列；每次 prompt 都撤销旧 state 并登记一个干净代际。
      // open 时的预注册只服务首次 tools/list，到首 prompt 也按同一规则替换。
      if (entry.request.delegateRoles?.length) {
        disposePiDelegateRuntime(entry.delegate);
        entry.delegate = createPiDelegateRuntime(entry.request, entry.owner, piDelegateRuntimeDeps);
        promptGeneration.delegate = entry.delegate;
      }
      if (entry.delegate) entry.delegate.state.runId = runId ?? uiSessionId;
      if (entry.request.artifactContext) {
        entry.artifact = renewPiArtifactRuntime(
          entry.request,
          entry.owner,
          piDelegateRuntimeDeps,
          runId!,
          entry.artifact,
        );
        promptGeneration.artifact = entry.artifact;
      }
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
      try {
        const images = await buildPiImages(imagePaths);
        // `pi:abort`、close、owner destroy 或同 id replace 都可在图片 I/O 的 await 窗口发生。
        // abort 对尚未启动的 engine run 是空操作；若不复核，这里会在用户点停之后反向启动模型。
        if (!promptGenerationIsActive(uiSessionId, entry, promptGeneration)) {
          cancelPromptGeneration(entry, promptGeneration);
          return cancelledPromptResponse();
        }
        // 无图沿用两参调用,保持既有行为/契约不变。
        const response = images
          ? await s.prompt(message, runId, images)
          : await s.prompt(message, runId);
        if (!response.success) {
          cancelPromptGeneration(entry, promptGeneration);
          if (entry.prompt === promptGeneration) entry.prompt = undefined;
        }
        return response;
      } catch (error) {
        // 如果异常到达前本代已经被 Stop/close 取消，按主动取消成功收口，避免 renderer
        // 把用户自己的 Stop 再渲染成「启动失败」。真正的图片/transport 错误仍原样抛出。
        const wasCancelled = !promptGenerationIsActive(uiSessionId, entry, promptGeneration);
        cancelPromptGeneration(entry, promptGeneration);
        if (entry.prompt === promptGeneration) entry.prompt = undefined;
        if (wasCancelled) {
          return cancelledPromptResponse();
        }
        throw error;
      }
    }),
  );
  ipcMain.handle("pi:steer", (event, uiSessionId: string, message: string) =>
    command(event.sender, uiSessionId, (s) => s.steer(message)),
  );
  ipcMain.handle("pi:followUp", (event, uiSessionId: string, message: string) =>
    command(event.sender, uiSessionId, (s) => s.followUp(message)),
  );
  ipcMain.handle("pi:abort", (event, uiSessionId: string) => {
    const entry = getOwnedSessionEntry(uiSessionId, event.sender);
    // 必须先标记 prompt 准备代际，再下发 engine abort：图片尚在读取时 engine 还没有活跃 run，
    // 单靠 abort 会成功返回却什么也没停，迟到 continuation 随后仍会启动模型。
    cancelPromptGeneration(entry);
    if (entry.delegate) {
      disposePiDelegateRuntime(entry.delegate);
      entry.delegate = undefined;
    }
    if (entry.artifact) {
      disposePiArtifactRuntime(entry.artifact);
      entry.artifact = undefined;
    }
    return command(event.sender, uiSessionId, (s) => s.abort());
  });
  ipcMain.handle("pi:fork", (event, uiSessionId: string, entryId: string) =>
    command(event.sender, uiSessionId, (s) => s.fork(entryId)),
  );
  // 取可分支的历史消息（编辑重发的分支点预览,与 pi:fork 配套,见 plan §3.6）。
  ipcMain.handle("pi:getForkMessages", (event, uiSessionId: string) =>
    command(event.sender, uiSessionId, (s) => s.getForkMessages()),
  );
  ipcMain.handle("pi:setModel", async (event, uiSessionId: string, provider: string, modelId: string) => {
    let commandEntry: SessionEntry | undefined;
    const data = await command(event.sender, uiSessionId, (s, entry) => {
      commandEntry = entry;
      return s.setModel(provider, modelId);
    });
    // live 父会话切模型成功后同步更新 child 继承快照；失败时 command 已抛，不能提前写出假状态。
    // await 期间 renderer 可能已关闭/重开同 id 会话；旧 engine 的迟到响应只能更新自己那一代，
    // 否则会污染新 entry 的 child 继承配置，使后续委派走错 provider/model。
    if (!commandEntry || sessions.get(uiSessionId) !== commandEntry) return data;
    commandEntry.request.providerId = provider;
    commandEntry.request.model = modelId;
    // prepared.provider 是 open 时解析出的 endpoint 快照；跨 provider 切换后必须清掉，让下一个
    // child 在 preparePiOpenRequest 中按新 providerId 重解。否则会把新模型发往旧网关。
    commandEntry.request.provider = undefined;
    commandEntry.request.providerFingerprint = undefined;
    return data;
  });
  ipcMain.handle("pi:setThinking", async (event, uiSessionId: string, level: string) => {
    let commandEntry: SessionEntry | undefined;
    const data = await command(event.sender, uiSessionId, (s, entry) => {
      commandEntry = entry;
      return s.setThinkingLevel(level);
    });
    if (commandEntry && sessions.get(uiSessionId) === commandEntry) {
      commandEntry.request.thinkingLevel = level;
    }
    return data;
  });
  ipcMain.handle("pi:compact", (event, uiSessionId: string, customInstructions?: string) =>
    command(event.sender, uiSessionId, (s) => s.compact(customInstructions)),
  );
  // 阶段4 恢复:从磁盘 JSONL switchSession（独立长超时;best-effort,坏文件 pi 静默起空会话回 success,
  // cwd 缺失走 success:false 被 command 捕获）。
  ipcMain.handle("pi:switchSession", (event, uiSessionId: string, sessionPath: string) =>
    command(event.sender, uiSessionId, (s) => s.switchSession(sessionPath)),
  );
  ipcMain.handle("pi:getState", (event, uiSessionId: string) =>
    command(event.sender, uiSessionId, (s) => s.getState()),
  );
  // 分支回复:把当前 live 会话的磁盘 JSONL 复制为不可变快照(chat-branches/<sessionId>/<branchId>.jsonl),
  // 旧分支据快照 switchSession 续聊。快照在 fork rewind **之前**做,故不依赖 fork 的原地/换文件语义。
  // 会话不存在/无 sessionFile/复制失败 → null(调用方把该分支降级为只读)。
  ipcMain.handle("pi:snapshotSession", async (event, uiSessionId: string, branchId: string): Promise<{ path: string } | null> => {
    const entry = getOwnedSessionEntry(uiSessionId, event.sender);
    if (!/^[\w-]+$/.test(branchId)) return null; // branchId 进入文件名,同 SAFE_ID 校验防路径穿越
    try {
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
  ipcMain.handle("pi:getStats", (event, uiSessionId: string) =>
    command(event.sender, uiSessionId, (s) => s.getSessionStats()),
  );

  // extension UI 应答:回写到 pi stdin（fire-and-forget,不走 command 等 response）。
  // async 包一层:getSession 的同步抛（会话不存在）转成 rejection,与 renderer invoke 语义一致。
  ipcMain.handle("pi:uiResponse", async (event, uiSessionId: string, id: string, payload: PiUiResponsePayload) => {
    const key = transientUiKey(uiSessionId, id);
    const transient = transientUiSessions.get(key);
    if (transient) {
      if (transient.owner !== event.sender) {
        throw new Error(`pi 会话不属于当前 renderer: ${uiSessionId}`);
      }
      transientUiSessions.delete(key);
      transient.session.respondUi(id, payload);
      return;
    }
    const entry = sessions.get(uiSessionId);
    if (entry) {
      if (entry.owner !== event.sender) {
        throw new Error(`pi 会话不属于当前 renderer: ${uiSessionId}`);
      }
      // delegate child 已结束后 renderer 仍可能提交一个刚关闭弹窗的迟到响应。routed id 带私有前缀，
      // 可在 transient 已清理时明确丢弃；若继续 fallback 到父 engine，会把 child id 当父 native id 回写。
      if (isPiDelegateUiRequestId(id)) return;
      entry.session.respondUi(id, payload);
      return;
    }

    const opening = openingSessions.get(uiSessionId);
    if (opening) {
      if (opening.owner !== event.sender) {
        throw new Error(`pi 会话不属于当前 renderer: ${uiSessionId}`);
      }
      if (!opening.cancelled && opening.session) {
        opening.session.respondUi(id, payload);
        return;
      }
    }
    throw new Error(`pi 会话不存在: ${uiSessionId}`);
  });

  // 显式关闭:停进程 + 摘除注册表（幂等,不存在则静默）。
  ipcMain.handle("pi:close", (event, uiSessionId: string) => {
    const opening = openingSessions.get(uiSessionId);
    if (opening) {
      if (opening.owner !== event.sender) throw new Error(`pi 会话不属于当前 renderer: ${uiSessionId}`);
      // prepare/open/ready 任一 await 窗口都可关闭；open handler 会在下一个世代检查点
      // 停掉已构造的迟到 engine，不留一个未登记孤儿。
      opening.cancelled = true;
      // gateway handle 在 worker open 应答前已可用；立即 close 才能解开 startup UI/rebind await。
      opening.session?.stop();
    }
    const entry = sessions.get(uiSessionId);
    if (entry) {
      if (entry.owner !== event.sender) throw new Error(`pi 会话不属于当前 renderer: ${uiSessionId}`);
      // 同时清 delegate child 与所有 per-session MCP 映射；后两者含写能力授权状态，不能只停 engine。
      disposeSessionEntry(uiSessionId, entry, true);
    }
  });
}

// 退出清理:终止所有 pi RPC 会话子进程（app window-all-closed / before-quit 调）。
export function killAllPiSessions(): void {
  for (const opening of openingSessions.values()) {
    opening.cancelled = true;
    opening.session?.stop();
  }
  openingSessions.clear();
  for (const [uiSessionId, entry] of [...sessions]) {
    disposeSessionEntry(uiSessionId, entry, true);
  }
  sessions.clear();
}

// 供测试/诊断:当前活跃 pi 会话数。
export function piSessionCount(): number {
  return sessions.size;
}
