// pi 长驻会话的 IPC 层。registry 维护 uiSessionId → PiSessionEngine,
// pi:open 建、pi:close 销;命令转发到会话方法,归一化事件经 pi:event 推回 renderer。
// claude/codex 仍走 cli.ts 单发管线,与本通道互不影响。
//
// ── 两条引擎路径（迁移期并存，见 docs/plans/2026-08-05-001-refactor-pi-inprocess-migration-plan.md）──
//   · binary（默认）：spawn `resources/pi` 的 bun 二进制 + `--mode rpc` 手抄协议 —— `PiRpcSession`；
//   · in-process：主进程内直接调 pi-coding-agent 的 `createAgentSession` —— `PiInProcSession`。
// 二者都实现 `PiSessionEngine`，故本文件除 `pi:open` 的构造分支外**不含任何引擎分支**：
// registry、命令转发、UI 回写、清理路径全部只依赖该契约。`PiRpcSession extends PiSessionEngine`
// 有编译期断言守着（见 pi-inproc/session.ts），改签名会编译失败而非运行时静默失效。

import { randomUUID } from "crypto";
import { existsSync, promises as fsp } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve, sep } from "path";

import { app, ipcMain, type WebContents } from "electron";

import { buildRpcArgs, spawnPiRpc, PiRpcSession, type PiImageContent, type RpcResponse } from "../agents/pi-rpc";
import {
  openPiInProcSession,
  shouldUsePiInProcEngine,
  type PiInProcDeps,
  type PiInProcModelSelection,
  type PiSessionEngine,
} from "../agents/pi-inproc";
// 类型侧 import：编译期擦除，不会把纯 ESM 的 pi 包拖进主进程的 CJS chunk（KTD1）。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiNativeHooks } from "../agents/pi-inproc/native-hooks";
import { createMcpInProcTools } from "../agents/pi-mcp-inproc";
import { resolveComputerUseInproc } from "../capabilities/computer-use/inproc";
import { getPiInprocModelRuntime, resolvePiInprocModel } from "../providers/pi-inproc-models";
import { readImageBytes } from "./image";
import { chatBranchesDir, chatImagesRoot } from "../paths";
import { writePiExtension } from "../agents/pi-providers";
import { resolvePiSessionProvider } from "../providers/custom-provider-runtime";
import {
  writeApprovalExtension,
  writeAskQuestionExtension,
  writeCustomToolExtension,
  writeSlashCommandExtension,
  writeTodoExtension,
} from "../agents/pi-extensions";
import { assertSpawnCwd, resolveSpawnCwd, spawnEnvFor } from "./cli";
import { getPersistedState } from "./store";
import { buildBrowserMcpServerConfig } from "../capabilities/browser/inject";
import { buildAgentBrowserMcpServerConfig, migrateLegacyAgentBrowserMcp } from "../capabilities/agent-browser/inject";
import { resolveAgentBrowserBinary } from "../capabilities/agent-browser/locate";
import { buildDocExtractMcpServerConfig } from "../capabilities/doc-extract/mcp";
import { buildKnowledgeMcpServerConfig } from "../capabilities/knowledge/inject";
import { resolveComputerUse } from "../capabilities/computer-use/inject";
import { buildResearchMcpServerConfig } from "../capabilities/research/inject";
import { unregisterResearchSession } from "../capabilities/research/server";
import { buildMediaGenMcpServerConfig, unregisterMediaGenSession } from "../capabilities/media-gen/server";
import { buildLoopWorkflowsMcpServerConfig, unregisterLoopWorkflowsSession } from "../capabilities/loop-workflows/server";
import { buildAutomationMcpServerConfig, unregisterAutomationSession } from "../capabilities/automation/server";
import { buildCalendarMcpServerConfig, unregisterCalendarSession } from "../capabilities/calendar/server";
import { loadWorkflows } from "../workflow/store";
import { collectBridgeServers, writeMcpBridgeExtension } from "../agents/pi-mcp-bridge";
import type { PiOpenRequest, PiOpenResult, PiSessionEvent, PiUiRequest, PiUiResponsePayload } from "./types";
import { recordAgentTrace, recordStreamDelta } from "./agent-trace";
import { createLogger } from "../log";

const log = createLogger("pi-session");

interface SessionEntry {
  session: PiSessionEngine; // 两条引擎路径的共同契约,registry 不关心底下是子进程还是 in-process
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
  // ⚠️ 安全:req 是 renderer 经 IPC 传来的对象,而下面这两个字段是**主进程内部填充**的
  // 子进程环境变量。不先清空的话,renderer 可以直接传
  // `customProviderEnv: { PATH: "/tmp/evil", NODE_OPTIONS: "--require /tmp/x.js" }` ——
  // 它们在 spawnEnvFor 里以 Object.assign 合并在 buildEnv() **之后**,足以劫持 pi 子进程。
  // 类型注释写了「renderer 不传」,但注释拦不住任何人,必须在边界上真删。
  delete prepared.customProviderEnv;
  delete prepared.computerUseEnv;
  // cwd 归一放在最前:空串会让 spawn 继承 Electron 自己的工作目录
  //(dev 下 = apps/desktop/,agent 产物写进程序目录)。见 cli.resolveSpawnCwd。
  prepared.cwd = resolveSpawnCwd(prepared.cwd);
  // 供应商解析:renderer 只给 providerId,endpoint 与密钥从「Catalog + provider-prefs + 凭据金库」取。
  // 这里是 pi 主会话与三段编排子会话的共同入口,放这一处即两条路径都覆盖。
  // 不接的话,§5 清掉 providerSettings 后 provider 恒为 undefined —— pi 会静默退回自己的默认
  // provider,用户以为在用选定的模型,实际不是。
  //
  // 三段式解析（Catalog → 自定义 → 响亮失败）收在 resolvePiSessionProvider 里。解析不出时
  // 它直接抛错 —— 本函数在 spawnPiRpc **之前**执行,故 pi 进程根本不会被拉起来,
  // 用户拿到的是「供应商未配置」而不是 pi 兜底换模型后那句毫不相干的下游报错。
  if (!prepared.provider && prepared.providerId) {
    const resolved = await resolvePiSessionProvider(prepared.providerId);
    if (resolved.kind === "builtin") {
      prepared.provider = resolved.provider;
      prepared.piExtensionPath = resolved.extensionPath;
    } else {
      prepared.piExtensionPath = resolved.runtime.extensionPath;
      // Secret 真值只走子进程 env（extension 文件里只有 ${CORTEX_PI_SECRET_N} 占位）。
      prepared.customProviderEnv = resolved.runtime.secretEnv;
      // 合成一个「只承载 id」的 provider:buildRpcArgs 据它下发 `--provider`,
      // 没有它 pi 会拿到孤立的 --model 并走自己的兜底链选模型（本次事故的直接成因）。
      // baseUrl/models 留空、apiKey 缺省 —— 真配置全在上面那份 extension 里,
      // 且 spawnEnvFor 不会因此注入 CORTEX_PI_KEY。
      prepared.provider = { id: resolved.runtime.providerId, baseUrl: "", models: [] };
    }
  } else if (prepared.provider) {
    // provider 由调用方（编排子会话）直接给定时,沿用既有内建渲染路径。
    prepared.piExtensionPath = writePiExtension(prepared.provider);
  }

  // 引擎选路在本函数内多处影响「能力以何种形态交付」：binary 生成 .js extension 文件并 `-e` 加载，
  // in-process 改为原生对象（customTools / extensionFactories / additionalExtensionPaths）。
  // 判定取一次并贯穿全函数，避免同一次准备里前后不一致。
  const useInProc = shouldUsePiInProcEngine();

  const extra: string[] = [...(prepared.extraExtensionPaths ?? [])];
  // ⚠️ 以下四类 extension 在 in-process 路径下由 pi-inproc/native-hooks.ts 原生注册，
  // 这里必须跳过——否则同一份能力会注册两遍（审批弹窗弹两次、todo_write 重名冲突）。
  if (!useInProc) {
    if (prepared.enableToolApproval) extra.push(writeApprovalExtension(prepared.approvalTools));
    if (prepared.enableSampleTools) extra.push(writeCustomToolExtension());
    if (prepared.enableSampleCommands) extra.push(writeSlashCommandExtension());
  }

  const askQuestionSentinel =
    prepared.askQuestionSentinel ?? `@@CORTEX_ASKQ:${randomUUID()}@@`;
  prepared.askQuestionSentinel = askQuestionSentinel;
  if (!useInProc) {
    extra.push(writeAskQuestionExtension(askQuestionSentinel));
    // 任务清单工具 todo_write(常驻):pi 无原生 TodoWrite,经此补齐。事件在 pi-rpc.ts mapPiEvent
    // 特判转成 todo 整表快照事件,渲染端折叠成任务清单卡片。
    extra.push(writeTodoExtension());
  }

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
    const bridgeServers = collectBridgeServers(bridgeInputs, browserServer);
    // 收集规则两条路径共用（一处定义两处复用）；只有「怎么交给 pi」不同：
    // binary 烘焙成 .js extension 文件，in-process 留结构化配置、稍后原生注册成 customTools。
    prepared.bridgeServers = bridgeServers;
    if (!useInProc && bridgeServers.length) extra.push(writeMcpBridgeExtension(bridgeServers));
  } catch (e) {
    log.warn(`MCP 桥接扩展生成失败: ${String(e)}`);
  }

  // Computer Use（pi-computer-use package,操作真实桌面 GUI）。
  // 独立 try 而非并进上面那块:它不是 MCP 桥接,混进去会让失败日志张冠李戴。
  // 只在这条 RPC 路径注入——单发路径无审批 UI,详见 capabilities/computer-use/inject.ts 的说明。
  try {
    const gs = (await getPersistedState()).generalSettings;
    if (useInProc) {
      // in-process：五门控判定完全复用（inproc.ts 只调 resolveComputerUse 拿结论），
      // 差别只在交付形态——路径给 additionalExtensionPaths 由 SDK 的 jiti 链路加载，
      // grounding 模型的 env 由 resolveComputerUseInproc 就地写进主进程（没有子进程可传 env）。
      const cu = await resolveComputerUseInproc(gs?.computerUse);
      if (cu.additionalExtensionPaths.length) prepared.inProcExtensionPaths = cu.additionalExtensionPaths;
    } else {
      const cu = await resolveComputerUse(gs?.computerUse);
      if (cu.path) {
        extra.push(cu.path);
        // env 经 prepared 传到下面的 spawnPiRpc（pi 无对应 CLI flag,只能走环境变量）。
        if (Object.keys(cu.env).length) prepared.computerUseEnv = cu.env;
      }
    }
  } catch (e) {
    log.warn(`Computer Use 注入决策失败,本轮不注入: ${String(e)}`);
  }

  prepared.extraExtensionPaths = extra;
  prepared.extensionPaths = filterLoadableExtensionPaths(prepared.extensionPaths);
  return prepared;
}

/**
 * `PiOpenRequest` → in-process 引擎的模型选择。这是引擎层与 Provider 模块之间的接缝：
 * 引擎层刻意不做 provider 解析，而 `resolvePiInprocModel` 要求 providerId 必填，
 * 偏偏 `PiOpenRequest.providerId` 是可选的（renderer 未显式选供应商时就没有）。
 *
 * 缺 providerId 时**不猜**具体模型（与 `providers/default-model.ts` 的「两段必须成套、
 * 只有 providerId 没有 modelId 时不猜第一个模型」同源），但仍然要注入 modelRuntime——
 * 它承载的是**整个注册表**（自定义 Provider + baseUrl 覆盖），不只是被选中的那一个。
 * 漏注入会让自定义供应商与 endpoint 覆盖在 in-process 路径上静默失效，表现为
 * 「设置里明明配好了却还是走官方地址」。与 binary 路径缺省 `--provider` 时的语义对齐。
 */
async function resolveInProcModel(req: PiOpenRequest): Promise<PiInProcModelSelection> {
  const providerId = req.providerId?.trim();
  if (!providerId) return { modelRuntime: await getPiInprocModelRuntime() };
  return resolvePiInprocModel({ providerId, modelId: req.model });
}

/**
 * 组装 in-process 引擎的依赖：把各能力的**原生**产物汇成一份 `PiInProcDeps`。
 *
 * 对应关系（左：binary 路径生成 .js 文件经 `-e` 加载；右：本函数产出的原生对象）：
 *   审批 hook / todo / askquestion / 样例  → native-hooks 的 extensionFactories + customTools
 *   MCP 桥（十几个 capability server）       → pi-mcp-inproc 的 customTools
 *   Computer Use（磁盘上的第三方包）        → additionalExtensionPaths（SDK 的 jiti 链路加载）
 *   自定义 Provider                         → resolveInProcModel（密钥请求时才解，不落盘）
 *
 * `hasUiOutlet` 必须如实反映本会话有没有 UI 回写通道：in-process 下 pi 的 `ctx.hasUI` 恒为 true
 * （uiContext 总是被 rebind 传进去），照抄旧判据会让无 UI 的路径从「放行」翻转成「全部 block」。
 *
 * 返回的 `disposeMcp` 必须在会话 stop 时调用——MCP 的 stdio 子进程与在途 HTTP 请求
 * 不会随会话对象被 GC，漏调即连接泄漏累积。
 */
async function buildInProcDeps(
  prepared: PiOpenRequest,
  hasUiOutlet: boolean,
): Promise<{ deps: PiInProcDeps; disposeMcp: () => Promise<void> }> {
  const hooks = createPiNativeHooks({
    enableToolApproval: prepared.enableToolApproval,
    approvalTools: prepared.approvalTools,
    hasUiOutlet: () => hasUiOutlet,
    uiSessionId: prepared.uiSessionId,
    enableSampleTools: prepared.enableSampleTools,
    enableSampleCommands: prepared.enableSampleCommands,
    askQuestionSentinel: prepared.askQuestionSentinel,
  });

  // MCP 单 server 失败只跳过该 server（createMcpInProcTools 内部保证不抛），整体失败才降级为无桥。
  let mcpTools: ToolDefinition[] = [];
  let disposeMcp = async (): Promise<void> => {};
  const servers = prepared.bridgeServers ?? [];
  if (servers.length) {
    try {
      const bridge = await createMcpInProcTools(servers);
      mcpTools = bridge.tools;
      disposeMcp = () => bridge.dispose();
      if (bridge.failed.length) {
        log.warn(`[in-process] MCP 接入失败 ${bridge.failed.length} 个: ${bridge.failed.map((f) => f.id).join("、")}`);
      }
    } catch (e) {
      log.warn(`[in-process] MCP 桥整体失败,本会话无 MCP 工具: ${String(e)}`);
    }
  }

  return {
    deps: {
      resolveModel: resolveInProcModel,
      customTools: [...hooks.customTools, ...mcpTools],
      extensionFactories: hooks.extensionFactories,
      ...(prepared.inProcExtensionPaths?.length
        ? { additionalExtensionPaths: prepared.inProcExtensionPaths }
        : {}),
    },
    disposeMcp,
  };
}

/**
 * in-process 路径下**仍未迁移**的能力做一次响亮告警。
 *
 * 审批 / todo / askquestion / MCP 桥 / Computer Use / 自定义 Provider 都已原生化，
 * 只剩「扩展市场装的第三方扩展」还没有 in-process 形态——它们是用户自己装的任意
 * npm/git 包，交付形态与 Computer Use 同类（磁盘目录），但需要逐个过信任门，另案处理。
 *
 * 不告警的话，开关一开这些能力会**静默消失**，而日志里没有任何线索。
 */
function warnUnmigratedCapabilities(prepared: PiOpenRequest): void {
  if (prepared.extensionPaths?.length) {
    log.warn(
      `[in-process] 扩展市场的 ${prepared.extensionPaths.length} 个扩展尚未迁移到原生加载,本会话不生效`,
    );
  }
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
    assertSpawnCwd(prepared.cwd);

    // 引擎选路。这是本文件**唯一**的引擎分支：构造出 PiSessionEngine 之后，下方所有
    // 命令转发 / 事件回推 / 清理路径对两条路径完全一致。
    const useInProc = shouldUsePiInProcEngine();
    const args = useInProc ? [] : buildRpcArgs(prepared);
    recordAgentTrace({
      scope: "pi",
      phase: "open",
      summary: "pi open",
      sessionId: prepared.uiSessionId,
      agent: "pi",
      // model:调试跟踪需能直读会话启动模型(缺省 = pi 自身默认;运行时可经 pi:setModel 切换)。
      // engine:灰度期两条路径并存,出问题时第一件事就是确认这次会话走的哪条。
      data: {
        cwd: prepared.cwd,
        model: prepared.model ?? "(默认)",
        engine: useInProc ? "in-process" : "binary",
        argCount: args.length,
        providerId: prepared.provider?.id,
      },
    });

    let session: PiSessionEngine;
    let disposeMcp: (() => Promise<void>) | undefined;
    if (useInProc) {
      warnUnmigratedCapabilities(prepared);
      // hasUiOutlet=true：本路径总是接了 emitUiRequest（渲染端在监听 pi:uiRequest）。
      // 无 UI 的是单发/编排那些路径，它们各自传 false。
      const built = await buildInProcDeps(prepared, true);
      disposeMcp = built.disposeMcp;
      session = await openPiInProcSession({
        request: prepared,
        onEvent: (ev, runId) => emitEvent(prepared.uiSessionId, ev, runId),
        onUiRequest: (request) => emitUiRequest(prepared.uiSessionId, request),
        askQuestionSentinel: prepared.askQuestionSentinel,
        deps: built.deps,
      });
      // MCP 的释放挂在 stop() 上而不是在各个清理点各写一遍：本文件有 5 处会停会话
      // （重开 / sender destroyed / ready 失败 / pi:close / crashed），逐处补调迟早漏一处，
      // 而漏掉的表现是 stdio 子进程与在途 HTTP 静默泄漏、越积越多。
      const rawStop = session.stop.bind(session);
      session.stop = () => {
        rawStop();
        void disposeMcp?.().catch((e: unknown) => log.warn(`[in-process] MCP 释放失败: ${String(e)}`));
      };
    } else {
      const transport = spawnPiRpc(args, {
        cwd: prepared.cwd,
        // computerUseEnv 由 preparePiOpenRequest 填充（Computer Use 的 grounding 模型）;
        // 后合并使其覆盖同名基础变量,缺省为空对象、不影响原行为。
        // customProviderEnv 走 spawnEnvFor（而非在此后合并）:它与 CORTEX_PI_KEY 同属
        // 「供应商密钥注入」职责,放一处便于日后统一审计。
        env: {
          ...spawnEnvFor({
            agent: "pi",
            provider: prepared.provider,
            customProviderEnv: prepared.customProviderEnv,
          }),
          ...prepared.computerUseEnv,
        },
      });
      session = new PiRpcSession(
        transport,
        (ev, runId) => emitEvent(prepared.uiSessionId, ev, runId),
        (request) => emitUiRequest(prepared.uiSessionId, request),
        prepared.askQuestionSentinel,
      );
    }
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
