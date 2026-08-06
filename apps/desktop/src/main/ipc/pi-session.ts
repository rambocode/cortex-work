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
import { buildCalendarMcpServerConfig, unregisterCalendarSession } from "../capabilities/calendar/server";
import { loadWorkflows } from "../workflow/store";
import { collectBridgeServers } from "../agents/pi-mcp-bridge";
import type { PiOpenRequest, PiOpenResult, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "./types";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";
import { createLogger } from "../log";

const log = createLogger("pi-session");

interface SessionEntry {
  session: PiSessionEngine; // 引擎契约（gateway worker 内的 AgentSession 的主进程 handle）
  sender: WebContents; // 发起 open 的 renderer,事件回推目标（销毁则丢弃）
}

const sessions = new Map<string, SessionEntry>();
type TransientPiUiSession = Pick<PiSessionEngine, "respondUi">;

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
function getSession(uiSessionId: string): PiSessionEngine {
  const entry = sessions.get(uiSessionId);
  if (!entry) throw new Error(`pi 会话不存在: ${uiSessionId}`);
  return entry.session;
}

// 命令转发:取会话 → 执行 → 命令级失败（success:false）转成 rejection,成功回 data。
async function command(uiSessionId: string, fn: (s: PiSessionEngine) => Promise<RpcResponse>): Promise<unknown> {
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
  // ⚠️ 安全:req 是 renderer 经 IPC 传来的对象,而下面这两个字段是**主进程内部填充**的。
  // computerUseEnv 会被 worker 原样写进自己的 process.env,customProviderEnv 是历史上
  // binary 路径的 spawn env 注入口——不先清空的话,renderer 可以借它们注入任意环境变量。
  // 类型注释写了「renderer 不传」,但注释拦不住任何人,必须在边界上真删。
  delete prepared.customProviderEnv;
  delete prepared.computerUseEnv;
  // jsReplSentinel 同为主进程内部字段:renderer 若能预置它,就能伪造 method:"jsrepl" 的触发前缀。
  delete prepared.jsReplSentinel;
  // cwd 归一放在最前:空串历史上会让 spawn 继承 Electron 自己的工作目录;gateway 下 worker 的
  // 会话文件与工具根同样按它推导,语义保留。见 cli.resolveSpawnCwd。
  prepared.cwd = resolveSpawnCwd(prepared.cwd);
  // 供应商解析:renderer 只给 providerId。gateway 下模型/凭据的**最终**解析在 worker 侧
  // （credentials 经 RPC 回主进程取,见 pi-gateway 的 KTD1）,providerId 随 open 参数透传;
  // 这里只把「Catalog + provider-prefs」合成的 endpoint 覆盖挂上 prepared.provider——
  // worker 的 applyBaseUrlOverride 靠它登记 baseUrl 覆盖,漏掉即「设置里配好了自建网关,
  // 请求却发官方地址」的静默失败。
  // 自定义 Provider 在此解析不出（resolvePiProviderInput 只认 Catalog）→ provider 留空,
  // worker 侧 resolveModel 会以「供应商没有可用模型」响亮失败,绝不静默换模型。
  if (!prepared.provider && prepared.providerId) {
    const provider = await resolvePiProviderInput(prepared.providerId);
    if (provider) prepared.provider = provider;
  }
  // provider 由调用方（编排子会话）直接给定时原样沿用——worker 侧只消费 id 与 baseUrl。

  const askQuestionSentinel =
    prepared.askQuestionSentinel ?? `@@CORTEX_ASKQ:${randomUUID()}@@`;
  prepared.askQuestionSentinel = askQuestionSentinel;
  // jsrepl 的会话级 sentinel:仅在 renderer 请求启用该工具时生成（不启用就不给 normalize 分支
  // 留任何可命中的前缀）。上方已 delete renderer 传入的同名字段,这里必为新生成值。
  if (prepared.enableJsReplTool) prepared.jsReplSentinel = `@@CORTEX_JSREPL:${randomUUID()}@@`;

  try {
    const state = await getPersistedState();
    const gs = state.generalSettings;
    const migratedMcp = migrateLegacyAgentBrowserMcp(gs?.mcp ?? { enabled: false, servers: [] });
    const userServers = migratedMcp.enabled ? migratedMcp.servers : [];
    const docServer = buildDocExtractMcpServerConfig(prepared.uiSessionId);
    const agentBrowserServer = buildAgentBrowserMcpServerConfig(
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
      "chat",
      prepared.webSearch === true,
    );
    // 公司知识库:与 claude/codex 拿到同一套知识库工具。pi 走 mcpInjection==="none",
    // 不经 cli.ts 的 builtinServers 数组,必须在这里单独并入——漏掉它就会出现
    // 「同一个开关，claude 能查知识库、pi 不能」这种查起来很费劲的不一致。
    // 无会话级开关,故不必计入 extensionFingerprint(改设置后重开会话即生效)。
    const knowledgeServer = buildKnowledgeMcpServerConfig(gs?.knowledgeBase);
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
    const automationServer = buildAutomationMcpServerConfig(
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
    const calendarServer = await buildCalendarMcpServerConfig(prepared.uiSessionId, true).catch(() => null);
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
    ];
    const browserServer = buildBrowserMcpServerConfig(gs?.browserControl, prepared.uiSessionId);
    // 结构化桥接配置随 open 参数进 worker,由 capabilities.ts 原生注册成 customTools。
    prepared.bridgeServers = collectBridgeServers(bridgeInputs, browserServer);
  } catch (e) {
    log.warn(`MCP 桥接配置收集失败: ${String(e)}`);
  }

  // Computer Use（pi-computer-use package,操作真实桌面 GUI）。
  // 独立 try 而非并进上面那块:它不是 MCP 桥接,混进去会让失败日志张冠李戴。
  // 只在这条聊天会话路径注入——单发路径无审批 UI,详见 capabilities/computer-use/inject.ts 的说明。
  try {
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

export function registerPiSessionHandlers(): void {
  ipcMain.handle("pi:open", async (event, req: PiOpenRequest): Promise<PiOpenResult> => {
    // 同 uiSessionId 重开（renderer 重挂载）:先停旧会话,避免泄漏一个孤儿子进程。
    const prev = sessions.get(req.uiSessionId);
    if (prev) {
      prev.session.stop();
      sessions.delete(req.uiSessionId);
    }

    // 扩展准备(provider / cwd 路径闸 / askquestion / MCP 桥接 / 市场扩展)统一抽进
    // preparePiOpenRequest —— pi 主会话与三段编排子会话同走此函数,路径闸/审批集等一处定义两处复用。
    const prepared = await preparePiOpenRequest(req);
    assertSpawnCwd(prepared.cwd);

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
    const session: PiSessionEngine = await openPiGatewaySession({
      request: prepared,
      onEvent: (ev, runId) => emitEvent(prepared.uiSessionId, ev, runId),
      onUiRequest: (request) => emitUiRequest(prepared.uiSessionId, request),
    });
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
      // 斜杠命令表缓存:让「扩展命令补发收尾」由命令来源精确判定,而非按 / 前缀猜。不 await——
      // 它只影响补发判定的精度（缺失时自动退回宽限窗兜底），不该拖慢开会话这条关键路径。
      void session.loadSlashCommands();
      return { uiSessionId: prepared.uiSessionId, sessionId, sessionFile };
    } catch (e) {
      session.stop();
      sessions.delete(prepared.uiSessionId);
      throw e instanceof Error ? e : new Error(String(e));
    }
  });

  // ── 运行时命令（均转发到对应 PiSessionEngine 方法）──────────────────────────
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
      // 清理研究/媒体生成/loop 工作流/自动化/日历 MCP 的 session 映射（下一次 pi:open 会重新
      // register）。pi 是长驻会话,不清的话映射会随开合累积;对自动化与日历还多一层意义——
      // 那两个 server 靠「sessionStateMap 里有没有」授权工具,留着等于留了一条权限尾巴。
      unregisterResearchSession(uiSessionId);
      unregisterMediaGenSession(uiSessionId);
      unregisterLoopWorkflowsSession(uiSessionId);
      unregisterAutomationSession(uiSessionId);
      unregisterCalendarSession(uiSessionId);
    }
  });
}

// 退出清理:终止所有 pi RPC 会话子进程（app window-all-closed / before-quit 调）。
export function killAllPiSessions(): void {
  for (const [uiSessionId, { session }] of sessions) {
    session.stop();
    // 同 pi:close:长驻会话的 per-session MCP 映射一并清掉,防退出前累积悬挂。
    unregisterResearchSession(uiSessionId);
    unregisterMediaGenSession(uiSessionId);
    unregisterLoopWorkflowsSession(uiSessionId);
    unregisterAutomationSession(uiSessionId);
    unregisterCalendarSession(uiSessionId);
  }
  sessions.clear();
}

// 供测试/诊断:当前活跃 pi 会话数。
export function piSessionCount(): number {
  return sessions.size;
}
