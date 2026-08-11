// pi RPC 长驻会话的「进程层」:维护 sessionId → pi 子进程（uiSessionId 复用个人会话 id）
// 的惰性开启 / 关闭与命令包装。纯进程/IPC 关注点,不碰 React Query 缓存——事件折叠在
// messages.ts 的 handlePiEvent（复用单发的 run / 折叠机制）。
//
// 与单发 startCli 的分工:claude/codex 每轮 spawn 一次性进程;pi 一个 UI 会话 = 一个长驻
// 进程,首轮惰性 piOpen（冷启 ~790ms,主进程经 get_state 探测就绪）,之后多轮复用,停止走
// piAbort（打断轮,进程存活）、编辑重发走 piFork（分支,替代 trimAgentSession）。

import type { DesktopBridge } from "../desktop/bridge";
import type { PiOpenRequest, PiOpenResult } from "../desktop/types";

interface PiSessionHandle {
  sessionId: string; // = uiSessionId = 个人会话 id
  piSessionId?: string; // pi 侧 sessionId（get_state 探测得到,诊断/恢复用）
  sessionFile?: string; // pi 侧磁盘 JSONL 路径（阶段4 恢复用;调用方据此持久到 SessionMeta）
  opening?: Promise<PiOpenResult>; // 开启中的在途 Promise,去重并发 ensure（防重复 spawn）
  closing?: Promise<void>; // 关闭中的在途 Promise，供后继世代串行等待（防迟到 piClose 误杀新进程）
  ready: boolean;
  // close/supersede 可以发生在 opening 任一 await 窗口。标记后该世代必须完成旧进程清理，
  // 但绝不能再调用 piOpen；若 open 已发出，则应在响应抵达后立即关闭迟到会话。
  cancelled: boolean;
  // 开会话时所用「extension 加载相关」开关的指纹。深度定制开关(审批/样例)只在冷启经 -e 加载,
  // 温会话改开关不生效——指纹漂移即关旧重开,使新 extension 真正加载（否则用户开了审批却裸奔）。
  fingerprint: string;
  // model/thinking 是可运行时切换的热配置，不能放进上面的冷启指纹。但 opening 尚未 ready 时
  // 运行时命令无处下发：若预热 A 期间 UI 已切到 B，ensure(B) 必须识别漂移并重开，不能复用 A。
  // ready 后 setModel/setThinking 成功会同步这里，使正常热切换仍走温会话快路径。
  model?: string;
  thinkingLevel?: string;
  // 阶段4 资源管理:最后活跃时间 + 空闲回收计时器（活动期不断重置→不触发,空闲后倒计时→关进程）。
  lastActiveAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const piSessions = new Map<string, PiSessionHandle>();

// 阶段4:会话级空闲回收阈值 + 多会话进程上限（LRU）。回收/逐出后下次 send 经 resumeFrom 恢复。
export const IDLE_RECLAIM_MS = 10 * 60_000; // 10min 无活动 → 关进程省内存
export const MAX_PI_SESSIONS = 5; // 长驻 pi 子进程上限,超则逐出最久未用

// 当前时间（可注入,便于测试 LRU 顺序;运行时用 Date.now）。
let nowFn: () => number = () => Date.now();
export function __setPiNowForTest(fn: () => number): void {
  nowFn = fn;
}

// 「该会话是否有活跃轮」谓词,由 messages.ts 注入（查 runningBySession;pi-session 进程层不能反向
// 依赖 store/QueryClient）。空闲回收/LRU 据此跳过繁忙会话——避免长工具静默期误杀正在跑的会话。
let isSessionBusy: (sessionId: string) => boolean = () => false;
// 回收前回调,由 messages.ts 注入（reapSessionRun:停看门狗/删 run/清 running）。万一回收到仍有 run
// 的会话（全忙时被迫逐出）→ 经此收尾 renderer 残余,避免 run 永挂 + 看门狗 interval 泄漏。
let onPiReclaim: (sessionId: string) => void = () => undefined;
export function setPiLifecycleHooks(hooks: {
  isBusy?: (sessionId: string) => boolean;
  onReclaim?: (sessionId: string) => void;
}): void {
  if (hooks.isBusy) isSessionBusy = hooks.isBusy;
  if (hooks.onReclaim) onPiReclaim = hooks.onReclaim;
}

// 活动刷新:更新 lastActiveAt + 重置空闲计时器。messages.ts 在 prompt/steer/每条事件/轮收尾时调。
// 活动持续 → 计时器不断重置不触发;活动停 IDLE_RECLAIM_MS 后 → closePiSession（空闲=无活跃 run,
// 故只关进程,无需 reapSessionRun;sessionFile 已在 SessionMeta,下次 send 恢复）。
export function touchPiSession(bridge: DesktopBridge | null, sessionId: string): void {
  const handle = piSessions.get(sessionId);
  // close 已开始的旧世代不能被迟到事件重新续命。否则它会在 Map 被新世代覆盖后留下一个
  // 按 sessionId 寻址的孤儿 timer，届时 closePiSession 会误关当前新进程。
  if (!handle || handle.cancelled || handle.closing) return;
  handle.lastActiveAt = nowFn();
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  handle.idleTimer = setTimeout(() => {
    // 到期时仍有活跃轮（长工具静默期无事件,但 run 在跑）→ 不回收,顺延一个周期,直到 run 结束。
    if (isSessionBusy(sessionId)) {
      touchPiSession(bridge, sessionId);
      return;
    }
    void closePiSession(bridge, sessionId);
  }, IDLE_RECLAIM_MS);
}

// LRU 逐出:已就绪会话数达上限时,关掉最久未用的。优先只在「无活跃 run」的会话里选 victim,避免
// 逐出正在跑的会话;全忙时才被迫逐出最久未用,并先 onPiReclaim 收尾 renderer run（防 run 永挂）。
function evictLruIfFull(bridge: DesktopBridge): void {
  const ready = [...piSessions.values()].filter((h) => h.ready);
  if (ready.length < MAX_PI_SESSIONS) return;
  const idle = ready.filter((h) => !isSessionBusy(h.sessionId));
  const pool = idle.length ? idle : ready;
  const victim = pool.reduce((a, b) => (a.lastActiveAt <= b.lastActiveAt ? a : b));
  if (isSessionBusy(victim.sessionId)) onPiReclaim(victim.sessionId); // 全忙被迫逐出 → 收尾 renderer run
  void closePiSession(bridge, victim.sessionId);
}

// 影响 extension 加载的指纹（审批工具集 / 样例工具 / 委派目录 / 供应商配置）。同设置→同指纹
//(字段定序稳定) → 改配置后温会话重开,新 extension 经 -e 真正加载（否则改了配置却不生效）。
// 注意:运行时态(thinkingLevel/model 实时切换)绝不进此指纹。
//
// 供应商部分在阶段② 后拆成两项:`providerId`（换供应商）与 `providerFingerprint`（同一供应商
// 下的 endpoint 覆盖 / 认证来源变化,由 modelCapabilities.providerConfigFingerprint 从
// ProviderAuthSnapshot 派生）。渲染端已不持有 baseUrl/apiKey,只能这样表达;
// 旧实现把 apiKey 与 per-model 能力标记直接塞进指纹,后者正是本次能力事故的输入端。
function extensionFingerprint(req: PiOpenRequest): string {
  return JSON.stringify({
    // 同一 UI 会话会在普通聊天与 design/slides 产物工作区之间切换。cwd/产物身份不进指纹会
    // 复用错误工作目录和能力集，既会写错位置，也可能把 slides 写工具带回普通聊天。
    cwd: req.cwd,
    artifactContext: req.artifactContext
      ? {
          kind: req.artifactContext.kind,
          documentId: req.artifactContext.documentId,
          workspaceRoot: req.artifactContext.workspaceRoot,
          entryPath: req.artifactContext.entryPath,
        }
      : null,
    toolApproval: !!req.enableToolApproval,
    approvalTools: req.approvalTools ?? null,
    // 运行模式 plan 档:只读工具白名单经 --tools 冷启注入,无运行时改工具集命令,改值必须重开会话
    //（切到/切出 plan）。排序确保顺序无关。
    toolWhitelist: req.toolWhitelist ? [...req.toolWhitelist].sort() : null,
    sampleTools: !!req.enableSampleTools,
    sampleCommands: !!req.enableSampleCommands,
    // 持久 system prompt（阶段4）:经 --append-system-prompt 冷启注入,无运行时命令,改值必须重开。
    appendSystemPrompt: req.appendSystemPrompt ?? null,
    // 插件 Skill（U5）:启用集经 --skill 冷启注入,无运行时命令,改值必须重开。已在装配层排序,
    // 此处再排序一次确保顺序无关（内容相同顺序不同不误重开）。
    skillPaths: [...(req.skillPaths ?? [])].sort(),
    // 扩展市场（U3）:启用集经 -e 冷启注入,同 skillPaths——启停/卸载改 extensionPaths → 指纹漂移
    // → 下一轮重开生效（否则禁用静默不生效"裸奔"）。keyed 完整解析路径,使重装/更新换路径也漂移。
    extensionPaths: [...(req.extensionPaths ?? [])].sort(),
    // 会话级联网:研究引擎 MCP 经桥接 extension 在 pi:open 时并入,pi 无运行时增删工具集的命令。
    // 不进指纹会让中途切开关复用温会话的旧工具集——开了却没有 web_search、或关了仍留着一套
    // 能出站的工具（后者是安全问题）。与 skillPaths 同类。
    webSearch: !!req.webSearch,
    // delegate MCP 也只在 open 时抓取 tools/list。角色的执行字段或本轮资源上限变化后必须
    // 重开，否则主模型看到的工具目录、child persona/模型或并发护栏仍会沿用旧值。展示专用的
    // color/avatar 不参与执行，避免纯 UI 调整白白冷启；按 id 排序使目录顺序无关。
    delegateRoles: req.delegateRoles
      ? [...req.delegateRoles]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, label, agent, model, effort, systemPrompt, toolPolicy }) => ({
            id,
            label,
            agent,
            model: model ?? null,
            effort: effort ?? null,
            systemPrompt: systemPrompt ?? null,
            toolPolicy: toolPolicy ?? null,
          }))
      : null,
    delegatePolicy: req.delegatePolicy
      ? {
          maxParallel: req.delegatePolicy.maxParallel,
          maxChildRuns: req.delegatePolicy.maxChildRuns,
        }
      : null,
    // 换供应商 → 指纹漂移 → 下一轮重开。
    providerId: req.providerId ?? null,
    // 同一供应商下的 endpoint 覆盖 / 认证来源变化。缺省（Web 端、旧壳、认证状态读失败）时
    // 退化为「只有换 id 才重开」—— 那种情况下改了自建网关要到下次冷启才生效。
    providerFingerprint: req.providerFingerprint ?? null,
  });
}

/** 判断请求的热配置是否就是当前进程已接收的配置。undefined 也有语义（使用启动默认值）。 */
function runtimeConfigMatches(handle: PiSessionHandle, req: PiOpenRequest): boolean {
  return handle.model === req.model && handle.thinkingLevel === req.thinkingLevel;
}

/** 该会话的 pi 进程是否已就绪（U3 据此决定 setModel 是否实时下发）。 */
export function isPiSessionOpen(sessionId: string): boolean {
  return piSessions.get(sessionId)?.ready ?? false;
}

/**
 * 当前环境是否提供完整 Pi RPC 能力。
 *
 * UI 双向通道也属于必需能力：即使当前是 auto，Computer Use、自动化与日历写工具仍可能被
 * 强制审批。只检查 open/prompt/event 会让旧 preload 成功启动，却把 confirm 永久挂在无人订阅的
 * `pi:uiRequest` 上。`onPiUiCancel` 同样必需：child 可在对话框待答时超时/取消，
 * 旧 preload 若不能撤销该 id 会留下无效弹窗。`piAbort`/`piClose` 也不是可选清理：缺少
 * 任一项时停止父轮或关闭会话都无法级联终止 child 与写工具。缺任一项都在写入用户消息前响亮失败。
 */
export function piRpcAvailable(bridge: DesktopBridge | null | undefined): boolean {
  return !!bridge?.piOpen &&
    !!bridge?.piPrompt &&
    !!bridge?.onPiEvent &&
    !!bridge?.onPiUiRequest &&
    !!bridge?.onPiUiCancel &&
    !!bridge?.piUiResponse &&
    !!bridge?.piAbort &&
    !!bridge?.piClose;
}

/** pi RPC 缺失能力列表,用于旧 preload / web 环境给出可诊断提示。 */
export function piRpcMissingCapabilities(bridge: DesktopBridge | null | undefined): string[] {
  if (!bridge) return ["desktopBridge"];
  const missing: string[] = [];
  if (!bridge.piOpen) missing.push("piOpen");
  if (!bridge.piPrompt) missing.push("piPrompt");
  if (!bridge.onPiEvent) missing.push("onPiEvent");
  if (!bridge.onPiUiRequest) missing.push("onPiUiRequest");
  if (!bridge.onPiUiCancel) missing.push("onPiUiCancel");
  if (!bridge.piUiResponse) missing.push("piUiResponse");
  if (!bridge.piAbort) missing.push("piAbort");
  if (!bridge.piClose) missing.push("piClose");
  return missing;
}

/** 面向用户的 pi RPC 不可用说明。返回 null 表示能力完整。 */
export function piRpcUnavailableMessage(bridge: DesktopBridge | null | undefined): string | null {
  const missing = piRpcMissingCapabilities(bridge);
  if (missing.length === 0) return null;
  return `当前 Desktop 桥缺少 pi RPC 能力（缺少 ${missing.join(", ")}）。请完整重启 Cortex Desktop 以加载最新 preload；如果当前是在浏览器 Web 页面中使用，请切换到 Desktop 应用。`;
}

/**
 * 关闭指定世代的句柄。只有它仍是当前登记时才摘除 Map，避免旧世代的异步收口误删后来者；
 * 指纹漂移重开时，新世代会先占位，再用本函数等待旧进程真正关闭后启动新进程。
 */
function closePiSessionHandle(bridge: DesktopBridge | null, handle: PiSessionHandle): Promise<void> {
  if (handle.closing) return handle.closing;
  handle.cancelled = true;
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = undefined;
  }
  const closing = (async () => {
    if (handle.opening && !handle.ready) {
      // opening 自己负责：若 piOpen 尚未发出就停止；若已发出则等响应后关闭。这里必须等它收口，
      // 让随后同 uiSessionId 的新世代串行在旧代之后启动，避免迟到 piClose 误杀新进程。
      await handle.opening.catch(() => undefined);
    } else if (handle.ready && bridge?.piClose) {
      await bridge.piClose(handle.sessionId).catch(() => undefined);
    }
    // close 在途期间理论上 touch 已因 cancelled 被拦；结束时再清一次，防调用栈内已排队的旧活动
    // 或未来新增入口绕过 touch 守卫后留下跨世代 timer。
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = undefined;
    }
    if (piSessions.get(handle.sessionId) === handle) piSessions.delete(handle.sessionId);
  })();
  handle.closing = closing;
  return closing;
}

/**
 * 惰性开启 pi 会话:已就绪直接返回缓存的 sessionId;同指纹开启中复用同一 Promise（去重并发
 * send,防重复 spawn）；开启期间指纹漂移则串行关闭旧世代并按新配置重开。
 */
export async function ensurePiSession(
  bridge: DesktopBridge,
  req: PiOpenRequest,
  // 阶段4 恢复:重开后从该 sessionFile switchSession 恢复上下文（best-effort）。仅冷启新进程时生效;
  // 复用温会话不恢复（上下文还在内存）。
  opts?: { resumeFrom?: string },
): Promise<PiOpenResult> {
  const fp = extensionFingerprint(req);
  const existing = piSessions.get(req.uiSessionId);
  const sameColdConfig = existing?.fingerprint === fp;
  const sameRuntimeConfig = existing ? runtimeConfigMatches(existing, req) : false;
  if (existing && !existing.cancelled && sameColdConfig && sameRuntimeConfig) {
    // 冷配置和已生效的热配置都未变 → 复用温会话或同一在途 opening。
    if (existing.ready && existing.piSessionId)
      return { uiSessionId: req.uiSessionId, sessionId: existing.piSessionId, sessionFile: existing.sessionFile };
    if (existing.opening) return existing.opening;
  }
  if (!bridge.piOpen) throw new Error("当前环境不支持 pi RPC 会话");

  const handle: PiSessionHandle = {
    sessionId: req.uiSessionId,
    ready: false,
    cancelled: false,
    fingerprint: fp,
    model: req.model,
    thinkingLevel: req.thinkingLevel,
    lastActiveAt: nowFn(),
  };
  // 先登记再执行 opening：async IIFE 会同步运行到首个 await；若登记放在末尾，首开会把自己
  // 误判成“已被替换”并直接取消。
  piSessions.set(req.uiSessionId, handle);
  const opening = (async () => {
    if (existing) {
      // 新世代先写入 Map；随后等待旧 opening 收口并关闭旧进程，确保新配置不会复用旧 extension，
      // 也不会在旧 piClose 尚未完成时抢先 piOpen 同一个 uiSessionId。热配置漂移也走这里：
      // opening 期间无法 set_model/set_thinking，必须让 B 按自己的启动参数冷启。
      // 若旧句柄已被显式 close，即使 B/C 配置相同也必须等其 closing；否则 C 会在迟到
      // piClose 之前提前 open，随后被旧关闭请求误杀。正常指纹漂移则允许 A 按原语义完成，
      // B 再关闭它；不能把预热调用方无端改成 reject。
      if (existing.cancelled) {
        await closePiSessionHandle(bridge, existing);
      } else {
        if (existing.opening) await existing.opening.catch(() => undefined);
        if (existing.ready) await closePiSessionHandle(bridge, existing);
      }
    }
    // A→B→C 或显式 close 都可能在上面的 await 期间替换/取消本世代。B 仍应帮忙收口 A，
    // 但不能随后再打开一个已经无人登记的进程；C 会等待 B.opening 后自行启动。
    if (handle.cancelled || piSessions.get(req.uiSessionId) !== handle) {
      throw new Error("pi 会话开启已取消");
    }
    evictLruIfFull(bridge); // 阶段4 上限:spawn 新会话前若达上限,逐出最久未用。
    return bridge.piOpen!(req);
  })()
    .then(async (res) => {
      if (handle.cancelled) {
        // close 发生在 piOpen IPC 已发出之后。此时主进程可能已经建立会话；必须等到应答后
        // 立即按同一 uiSessionId 关闭，再让等待本 opening 的下一世代继续。
        await bridge.piClose?.(req.uiSessionId).catch(() => undefined);
        throw new Error("pi 会话开启已取消");
      }
      // 空/假 sessionId 视作未就绪失败:否则 ready 判定（看 piSessionId）会反复穿透重复 spawn。
      if (!res.sessionId) throw new Error("pi 会话未返回 sessionId");
      // 恢复:重开后切到旧 sessionFile（best-effort,坏文件→pi 静默起空会话仍可用;cwd 缺→reject 忽略）。
      let restored = res;
      if (opts?.resumeFrom && opts.resumeFrom !== res.sessionFile && bridge.piSwitchSession) {
        try {
          await bridge.piSwitchSession(req.uiSessionId, opts.resumeFrom);
          // switchSession 成功 = pi 已切到旧上下文。sessionFile 至少兜底为 resumeFrom（旧文件）,
          // 决不退回 res 的新空文件;sessionId 沿用 piOpen 的 live id（温会话复用守卫需真值）。
          // get_state 仅用于「校准」,**单独 try**:它失败（大会话刚重建上下文,30s getState 偶发超时）
          // 不能让整轮回退成新空会话——否则空文件被持久回 SessionMeta,旧历史指针永久丢失。
          let restoredSessionId = res.sessionId;
          let restoredFile = opts.resumeFrom;
          try {
            const state = bridge.piGetState
              ? ((await bridge.piGetState(req.uiSessionId)) as { sessionId?: string; sessionFile?: string } | undefined)
              : undefined;
            restoredSessionId = state?.sessionId ?? restoredSessionId;
            restoredFile = state?.sessionFile ?? restoredFile;
          } catch {
            // get_state 超时/瞬错:不影响恢复结论,沿用 resumeFrom 作 sessionFile、live id 作 sessionId。
          }
          restored = { uiSessionId: req.uiSessionId, sessionId: restoredSessionId, sessionFile: restoredFile };
        } catch {
          // 仅 switchSession 本身硬错（cwd 缺失等）才保持新会话（已可用,UI 历史不受影响）。
        }
      }
      if (handle.cancelled) {
        // close 也可能发生在 piOpen 已应答、但 switchSession/getState 恢复尚在 await 的窗口。
        // close helper 此时正在等同一 opening，不会再走 ready 分支；因此必须在恢复后二次
        // 检查并主动关掉已建进程，否则 Promise 返回后 Map 被删但主进程会留孤儿。
        await bridge.piClose?.(req.uiSessionId).catch(() => undefined);
        throw new Error("pi 会话开启已取消");
      }
      handle.ready = true;
      handle.piSessionId = restored.sessionId;
      handle.sessionFile = restored.sessionFile; // 阶段4 恢复用,调用方持久到 SessionMeta
      handle.opening = undefined;
      return restored;
    })
    .catch((e) => {
      // opening 期间可能已有不同指纹的新世代占位；旧 Promise 的延迟 reject 只能摘除自己，
      // 否则会把已经成功打开的新会话从登记表误删，下一轮又重复 spawn。
      if (piSessions.get(req.uiSessionId) === handle) piSessions.delete(req.uiSessionId);
      throw e instanceof Error ? e : new Error(String(e));
    });
  handle.opening = opening;
  return opening;
}

// 命令前置:会话未就绪即抛错（调用方转成 ⚠️ 提示,不静默吞）。
function requireReady(sessionId: string): void {
  if (!piSessions.get(sessionId)?.ready) throw new Error(`pi 会话未就绪: ${sessionId}`);
}

// 桥能力前置:可选方法缺失即抛错（web/旧壳）。
function requireCap<T>(fn: T | undefined, name: string): T {
  if (!fn) throw new Error(`当前环境不支持 ${name}`);
  return fn;
}

/** 发起一轮 prompt（response 是 preflight 即时 ack,任务结束由 result 事件表达）。runId 阶段4 代际。
 *  imagePaths:本轮上传图片的绝对路径,主进程读盘转 base64 注入 RPC prompt.images。 */
export function promptPi(
  bridge: DesktopBridge,
  sessionId: string,
  message: string,
  runId?: string,
  imagePaths?: string[],
): Promise<unknown> {
  requireReady(sessionId);
  return requireCap(bridge.piPrompt, "pi prompt")(sessionId, message, runId, imagePaths);
}

/** 运行中插话:把引导注入当前轮。 */
export function steerPi(bridge: DesktopBridge, sessionId: string, message: string): Promise<unknown> {
  requireReady(sessionId);
  return requireCap(bridge.piSteer, "pi steer")(sessionId, message);
}

/** 优雅打断当前轮（不杀长驻进程,进程存活待下一轮）。 */
export function abortPi(bridge: DesktopBridge, sessionId: string): Promise<unknown> {
  requireReady(sessionId);
  return requireCap(bridge.piAbort, "pi abort")(sessionId);
}

/** 编辑重发:在 entryId 处分支（替代单发的 trimAgentSession 截断会话文件）。 */
export function forkPi(bridge: DesktopBridge, sessionId: string, entryId: string): Promise<unknown> {
  requireReady(sessionId);
  return requireCap(bridge.piFork, "pi fork")(sessionId, entryId);
}

/** 取可分支的历史消息（editResend 定位分支点用）。 */
export function getForkMessagesPi(bridge: DesktopBridge, sessionId: string): Promise<unknown> {
  requireReady(sessionId);
  return requireCap(bridge.piGetForkMessages, "pi getForkMessages")(sessionId);
}

/** 运行时切模型（会话已开启时实时生效）。 */
export function setModelPi(
  bridge: DesktopBridge,
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<unknown> {
  requireReady(sessionId);
  const handle = piSessions.get(sessionId)!;
  const request = requireCap(bridge.piSetModel, "pi setModel")(sessionId, provider, modelId);
  return request.then((result) => {
    // 只更新发起命令时的同一世代。命令在途期间若已因冷配置漂移重开，旧响应不能污染新句柄。
    if (piSessions.get(sessionId) === handle) handle.model = modelId;
    return result;
  });
}

/** 运行时切思考强度（会话已开启时实时生效;set_thinking_level 是运行时命令,不进指纹、不重开）。 */
export function setThinkingLevelPi(bridge: DesktopBridge, sessionId: string, level: string): Promise<unknown> {
  requireReady(sessionId);
  const handle = piSessions.get(sessionId)!;
  const request = requireCap(bridge.piSetThinking, "pi setThinking")(sessionId, level);
  return request.then((result) => {
    // 与 setModelPi 相同，成功后才声明热配置已生效，并用世代守卫隔离迟到响应。
    if (piSessions.get(sessionId) === handle) handle.thinkingLevel = level;
    return result;
  });
}

/** 手动触发上下文压缩（一次 LLM 调用;compaction start/end 事件会回流,点亮 messages.ts 已有的
 *  「压缩上下文…」运行时状态——无需此处另维护状态）。仅在会话就绪且空闲时由 UI 调用。 */
export function compactPi(
  bridge: DesktopBridge,
  sessionId: string,
  customInstructions?: string,
): Promise<unknown> {
  requireReady(sessionId);
  return requireCap(bridge.piCompact, "pi compact")(sessionId, customInstructions);
}

/** 分支切换:温会话实时 switchSession 到指定磁盘 JSONL,并同步句柄缓存的 sessionFile——
 *  否则下一轮 sendPiTurn 会把句柄里的旧文件路径回写 SessionMeta,分支指针被静默污染。
 *  切换后经 get_state 校准(pi 可能落到别的文件;校准失败沿用目标路径)。
 *  会话未就绪时抛错(调用方走「只改 SessionMeta 指针,下次冷启经 resumeFrom 恢复」的冷路径)。 */
export async function switchPiToSessionFile(
  bridge: DesktopBridge,
  sessionId: string,
  sessionFile: string,
): Promise<string> {
  requireReady(sessionId);
  await requireCap(bridge.piSwitchSession, "pi switchSession")(sessionId, sessionFile);
  const handle = piSessions.get(sessionId);
  let live = sessionFile;
  try {
    const state = bridge.piGetState
      ? ((await bridge.piGetState(sessionId)) as { sessionId?: string; sessionFile?: string } | undefined)
      : undefined;
    live = state?.sessionFile ?? live;
    if (handle && state?.sessionId) handle.piSessionId = state.sessionId;
  } catch {
    // get_state 偶发超时:不影响切换结论,沿用目标路径。
  }
  if (handle) handle.sessionFile = live;
  return live;
}

/** fork 后校准 live sessionFile(fork 可能原地 rewind 也可能换文件,协议未约定):
 *  经 get_state 取真值并同步句柄。未就绪/无能力/失败返回 undefined,调用方沿用现有指针。 */
export async function calibratePiSessionFile(bridge: DesktopBridge, sessionId: string): Promise<string | undefined> {
  const handle = piSessions.get(sessionId);
  if (!handle?.ready || !bridge.piGetState) return undefined;
  try {
    const state = (await bridge.piGetState(sessionId)) as { sessionFile?: string } | undefined;
    if (state?.sessionFile) {
      handle.sessionFile = state.sessionFile;
      return state.sessionFile;
    }
  } catch {
    // 校准失败:沿用现有指针。
  }
  return undefined;
}

/** 显式关闭会话:摘除登记 + 终止子进程（幂等,piClose 缺失时只清本地登记）。 */
export async function closePiSession(bridge: DesktopBridge | null, sessionId: string): Promise<void> {
  const handle = piSessions.get(sessionId);
  if (!handle) return;
  await closePiSessionHandle(bridge, handle);
}

/** 关闭全部 pi 会话（视图卸载兜底;app 退出另有主进程 killAllPiSessions）。 */
export async function closeAllPiSessions(bridge: DesktopBridge | null): Promise<void> {
  // 不能先 clear Map 再只发 piClose：opening 可能尚未进入主进程，当前 close 先返回后它
  // 会迟到 open 成孤儿。统一走世代 close helper，先标记 cancelled，再等每个 opening 自行收口。
  await Promise.all([...piSessions.values()].map((handle) => closePiSessionHandle(bridge, handle)));
}

/** 崩溃事件 → 摘除登记（不发 piClose:进程已死;下次 send 触发重开）。由 handlePiEvent 调。 */
export function markPiSessionGone(sessionId: string): void {
  const handle = piSessions.get(sessionId);
  if (handle?.idleTimer) clearTimeout(handle.idleTimer);
  piSessions.delete(sessionId);
}

export function __resetPiSessionsForTest(): void {
  for (const h of piSessions.values()) if (h.idleTimer) clearTimeout(h.idleTimer);
  piSessions.clear();
  nowFn = () => Date.now();
  isSessionBusy = () => false;
  onPiReclaim = () => undefined;
}
