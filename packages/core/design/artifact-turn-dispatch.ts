// 「会话产物」入口的回合派发端口(设计稿与演示文稿共用)。
//
// **为什么需要这一层**:同一套设计工作台组件有两种宿主 ——
//   1) 独立设计工作台:回合走 design-run-manager 的 design:/slides: run,右栏就是它自己的对话;
//   2) 聊天会话的右侧产物面板:活是左侧会话的 agent 干的(runId `artifact:<kind>:`)。
// 面板内的动作(提纲审批、画布上的智能操作)不该知道自己被谁打开。会话侧面板挂载时在此注册
// 一个绑定了 (workspaceRoot, documentId) 的派发器,面板里的动作命中即回流发起会话;
// 没有注册(独立工作台)就回落到 design run。缺了它,用户在右栏点完按钮左侧会话毫无动静,
// 只能自己再手打一遍指令(用户实测)。
//
// 单例而非注册表:右栏一次只展示一个产物面板,多注册项只会掩盖「该清没清」的 bug。

/** 派发目标:一份产物由工作区根 + 文稿 id 唯一确定。 */
export interface ArtifactTurnTarget {
  workspaceRoot: string
  documentId: string
}

/** 一次要回流到会话的回合。 */
export interface ArtifactConversationTurn {
  /** 发给 agent 的正文,同时是会话流里显示的那句话 —— 必须是人话、短。 */
  text: string
  /**
   * 随本轮下发的附加 system prompt(提纲全文 / 智能操作的完整指令),不进会话流。
   * 省略时只带产物定位段(由宿主 hook 拼)。
   */
  systemPrompt?: string
}

export interface ArtifactTurnDispatcher extends ArtifactTurnTarget {
  /** 返回是否已发出;false = 宿主拒绝(会话已删/桥不可用),调用方据此提示用户。 */
  send(turn: ArtifactConversationTurn): Promise<boolean>
}

let current: ArtifactTurnDispatcher | null = null

export function setArtifactTurnDispatcher(dispatcher: ArtifactTurnDispatcher): void {
  current = dispatcher
}

/**
 * 按引用清除。**不能无条件置 null**:React 切换子树时先挂载新面板(注册新的)、再卸载旧面板,
 * 无条件清空会把刚注册的新派发器抹掉,表现为「换一份产物后动作又回流不到会话」。
 */
export function clearArtifactTurnDispatcher(dispatcher: ArtifactTurnDispatcher): void {
  if (current === dispatcher) current = null
}

/** 命中当前产物的派发器;宿主不是会话产物面板(或已切走)时返回 null。 */
export function resolveArtifactTurnDispatcher(
  target: ArtifactTurnTarget
): ArtifactTurnDispatcher | null {
  if (!current) return null
  if (current.workspaceRoot !== target.workspaceRoot || current.documentId !== target.documentId) {
    return null
  }
  return current
}
