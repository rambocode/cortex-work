// cortex-slides MCP 的会话状态注册表:sessionId → 当前回合被授权操作的 deck 上下文。
// 隔离契约:
//   - 只有 Slides Workspace 发起的回合(runId 前缀 `slides:<documentId>:`)会注册;
//     普通聊天/写作/普通 Design 回合取不到 state → 工具不注册(只剩 ping)。
//   - state 只存 documentId + workspaceRoot(deck 根由二者推导),不持有任何 fs 句柄;
//     一切文件操作仍走 workspace.ts 的路径校验与原子写。
//   - 回合结束(exit/error)、cli:kill 与 app 退出都必须 unregister,防跨 deck 泄漏。

export interface SlidesSessionState {
  sessionId: string;
  runId: string;
  /** deck id == 设计稿 documentId。 */
  documentId: string;
  /** 设计工作区根(绝对路径,= cli:start 的 cwd)。 */
  workspaceRoot: string;
}

const sessions = new Map<string, SlidesSessionState>();

/** 解析独立工作台或会话产物的 slides runId → documentId；其它回合返回 null。 */
export function parseSlidesRunId(runId: string): string | null {
  const m = /^(?:slides:|artifact:slides:)([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}):/.exec(runId);
  return m ? m[1] : null;
}

export function isSlidesRunId(runId: string): boolean {
  return parseSlidesRunId(runId) !== null;
}

export function registerSlidesSession(state: SlidesSessionState): void {
  sessions.set(state.sessionId, state);
}

export function unregisterSlidesSession(
  sessionId: string,
  expectedState?: SlidesSessionState,
): void {
  // Pi 长驻会话按 prompt 建新代；旧回合的 settled/crash 可能迟到。只有当前 map 仍指向
  // 调用方持有的 state 时才允许按代注销，避免旧回合撤掉新回合的 deck 写权限。
  // 未传 expectedState 保留 app 退出与 CLI 单发路径的强制清理语义。
  if (expectedState && sessions.get(sessionId) !== expectedState) return;
  sessions.delete(sessionId);
}

export function getSlidesSession(sessionId: string | null): SlidesSessionState | undefined {
  return sessionId ? sessions.get(sessionId) : undefined;
}

/** app 退出清理:清空全部会话状态。 */
export function clearAllSlidesSessions(): void {
  sessions.clear();
}
