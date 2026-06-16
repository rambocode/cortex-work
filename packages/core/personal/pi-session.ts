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
  opening?: Promise<PiOpenResult>; // 开启中的在途 Promise,去重并发 ensure（防重复 spawn）
  ready: boolean;
}

const piSessions = new Map<string, PiSessionHandle>();

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
export async function ensurePiSession(bridge: DesktopBridge, req: PiOpenRequest): Promise<PiOpenResult> {
  const existing = piSessions.get(req.uiSessionId);
  if (existing?.ready && existing.piSessionId) {
    return { uiSessionId: req.uiSessionId, sessionId: existing.piSessionId };
  }
  if (existing?.opening) return existing.opening;
  if (!bridge.piOpen) throw new Error("当前环境不支持 pi RPC 会话");

  const handle: PiSessionHandle = { sessionId: req.uiSessionId, ready: false };
  const opening = bridge
    .piOpen(req)
    .then((res) => {
      handle.ready = true;
      handle.piSessionId = res.sessionId;
      handle.opening = undefined;
      return res;
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
  piSessions.delete(sessionId);
  if (bridge?.piClose) await bridge.piClose(sessionId).catch(() => undefined);
}

/** 关闭全部 pi 会话（视图卸载兜底;app 退出另有主进程 killAllPiSessions）。 */
export async function closeAllPiSessions(bridge: DesktopBridge | null): Promise<void> {
  const ids = [...piSessions.keys()];
  piSessions.clear();
  if (bridge?.piClose) await Promise.all(ids.map((id) => bridge.piClose!(id).catch(() => undefined)));
}

/** 崩溃事件 → 摘除登记（不发 piClose:进程已死;下次 send 触发重开）。由 handlePiEvent 调。 */
export function markPiSessionGone(sessionId: string): void {
  piSessions.delete(sessionId);
}

export function __resetPiSessionsForTest(): void {
  piSessions.clear();
}
