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
  ready: boolean;
  // 开会话时所用「extension 加载相关」开关的指纹。深度定制开关(审批/样例)只在冷启经 -e 加载,
  // 温会话改开关不生效——指纹漂移即关旧重开,使新 extension 真正加载（否则用户开了审批却裸奔）。
  fingerprint: string;
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

// 活动刷新:更新 lastActiveAt + 重置空闲计时器。messages.ts 在 prompt/steer/每条事件/轮收尾时调。
// 活动持续 → 计时器不断重置不触发;活动停 IDLE_RECLAIM_MS 后 → closePiSession（空闲=无活跃 run,
// 故只关进程,无需 reapSessionRun;sessionFile 已在 SessionMeta,下次 send 恢复）。
export function touchPiSession(bridge: DesktopBridge | null, sessionId: string): void {
  const handle = piSessions.get(sessionId);
  if (!handle) return;
  handle.lastActiveAt = nowFn();
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  handle.idleTimer = setTimeout(() => {
    void closePiSession(bridge, sessionId);
  }, IDLE_RECLAIM_MS);
}

// LRU 逐出:已就绪会话数达上限时,关掉 lastActiveAt 最小的（最久未用;它若在跑会有近活跃时间,
// 自然不会被选中）。在 ensurePiSession spawn 新会话前调。
function evictLruIfFull(bridge: DesktopBridge): void {
  const ready = [...piSessions.values()].filter((h) => h.ready);
  if (ready.length < MAX_PI_SESSIONS) return;
  const victim = ready.reduce((a, b) => (a.lastActiveAt <= b.lastActiveAt ? a : b));
  void closePiSession(bridge, victim.sessionId);
}

// 影响 extension 加载的开关指纹（审批工具集 / 样例工具 / 样例命令）。同设置→同指纹(字段定序稳定)。
function extensionFingerprint(req: PiOpenRequest): string {
  return JSON.stringify({
    toolApproval: !!req.enableToolApproval,
    approvalTools: req.approvalTools ?? null,
    sampleTools: !!req.enableSampleTools,
    sampleCommands: !!req.enableSampleCommands,
  });
}

/** 该会话的 pi 进程是否已就绪（U3 据此决定 setModel 是否实时下发）。 */
export function isPiSessionOpen(sessionId: string): boolean {
  return piSessions.get(sessionId)?.ready ?? false;
}

/** 当前环境是否提供 pi RPC 能力（web/旧壳无 → 退回单发或隐藏运行时控制）。 */
export function piRpcAvailable(bridge: DesktopBridge | null | undefined): boolean {
  return !!bridge?.piOpen && !!bridge?.piPrompt && !!bridge?.onPiEvent;
}

/**
 * 惰性开启 pi 会话:已就绪直接返回缓存的 sessionId;开启中复用同一 Promise（去重并发 send,
 * 防重复 spawn）；开启失败摘除登记,下次 send 可重试。
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
  if (existing?.ready && existing.piSessionId) {
    // 深度定制开关(审批/样例)未变 → 复用温会话（不恢复,内存态在）。
    if (existing.fingerprint === fp)
      return { uiSessionId: req.uiSessionId, sessionId: existing.piSessionId, sessionFile: existing.sessionFile };
    // 开关变了(如中途打开「工具执行审批」)→ 关旧重开,让新 extension 经 -e 真正加载（否则裸奔）。
    await closePiSession(bridge, req.uiSessionId);
  } else if (existing?.opening) {
    return existing.opening; // 开启中复用(指纹漂移的并发极少,忽略)
  }
  if (!bridge.piOpen) throw new Error("当前环境不支持 pi RPC 会话");
  evictLruIfFull(bridge); // 阶段4 上限:spawn 新会话前若达上限,逐出最久未用。

  const handle: PiSessionHandle = {
    sessionId: req.uiSessionId,
    ready: false,
    fingerprint: fp,
    lastActiveAt: nowFn(),
  };
  const opening = bridge
    .piOpen(req)
    .then(async (res) => {
      // 空/假 sessionId 视作未就绪失败:否则 ready 判定（看 piSessionId）会反复穿透重复 spawn。
      if (!res.sessionId) throw new Error("pi 会话未返回 sessionId");
      // 恢复:重开后切到旧 sessionFile（best-effort,坏文件→pi 静默起空会话仍可用;cwd 缺→reject 忽略）。
      // switchSession 后 sessionFile/sessionId 变成恢复会话的值,再取一次 get_state 校准。
      let restored = res;
      if (opts?.resumeFrom && opts.resumeFrom !== res.sessionFile && bridge.piSwitchSession) {
        try {
          await bridge.piSwitchSession(req.uiSessionId, opts.resumeFrom);
          const state = bridge.piGetState
            ? ((await bridge.piGetState(req.uiSessionId)) as { sessionId?: string; sessionFile?: string } | undefined)
            : undefined;
          restored = {
            uiSessionId: req.uiSessionId,
            sessionId: state?.sessionId ?? res.sessionId,
            sessionFile: state?.sessionFile ?? opts.resumeFrom,
          };
        } catch {
          // cwd 缺失等硬错:保持新会话（已可用,UI 历史不受影响）。
        }
      }
      handle.ready = true;
      handle.piSessionId = restored.sessionId;
      handle.sessionFile = restored.sessionFile; // 阶段4 恢复用,调用方持久到 SessionMeta
      handle.opening = undefined;
      return restored;
    })
    .catch((e) => {
      piSessions.delete(req.uiSessionId);
      throw e instanceof Error ? e : new Error(String(e));
    });
  handle.opening = opening;
  piSessions.set(req.uiSessionId, handle);
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

/** 发起一轮 prompt（response 是 preflight 即时 ack,任务结束由 result 事件表达）。 */
export function promptPi(bridge: DesktopBridge, sessionId: string, message: string): Promise<unknown> {
  requireReady(sessionId);
  return requireCap(bridge.piPrompt, "pi prompt")(sessionId, message);
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
  return requireCap(bridge.piSetModel, "pi setModel")(sessionId, provider, modelId);
}

/** 显式关闭会话:摘除登记 + 终止子进程（幂等,piClose 缺失时只清本地登记）。 */
export async function closePiSession(bridge: DesktopBridge | null, sessionId: string): Promise<void> {
  const handle = piSessions.get(sessionId);
  if (!handle) return;
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  piSessions.delete(sessionId);
  if (bridge?.piClose) await bridge.piClose(sessionId).catch(() => undefined);
}

/** 关闭全部 pi 会话（视图卸载兜底;app 退出另有主进程 killAllPiSessions）。 */
export async function closeAllPiSessions(bridge: DesktopBridge | null): Promise<void> {
  const ids = [...piSessions.keys()];
  for (const h of piSessions.values()) if (h.idleTimer) clearTimeout(h.idleTimer);
  piSessions.clear();
  if (bridge?.piClose) await Promise.all(ids.map((id) => bridge.piClose!(id).catch(() => undefined)));
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
}
