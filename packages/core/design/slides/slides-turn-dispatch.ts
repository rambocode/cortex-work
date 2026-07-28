// 演示文稿「会话产物」入口的回合派发端口。
//
// **为什么需要这一层**:同一个 SlidesWorkspace 有两种宿主 ——
//   1) 独立设计工作台:回合走 design-run-manager 的 `slides:` run,右栏就是它自己的对话;
//   2) 聊天会话的右侧产物面板:活是左侧会话的 agent 干的(runId `artifact:slides:`)。
// 面板内的审批按钮不该知道自己被谁打开。会话侧面板挂载时在此注册一个绑定了
// (workspaceRoot, deckId) 的派发器,面板里的动作命中即回流发起会话;没有注册(独立工作台)
// 就回落到 design run。缺了它,用户在右栏点完「批准」后左侧会话毫无动静,只能再手打一遍
// 「已批准,开始生成」(用户实测)。
//
// 单例而非注册表:右栏一次只展示一个产物面板,多注册项只会掩盖「该清没清」的 bug。

/** 派发目标:一份 deck 由工作区根 + deckId 唯一确定(与 SlidesDeckChangedEvent 同一对键)。 */
export interface SlidesTurnTarget {
  workspaceRoot: string
  deckId: string
}

/** 一次要回流到会话的 slides 回合。 */
export interface SlidesConversationTurn {
  /** 发给 agent 的正文,同时是会话流里显示的那句话 —— 必须是人话、短。 */
  text: string
  /** 随本轮下发的附加 system prompt(提纲全文/阶段指令),不进会话流。 */
  systemPrompt: string
}

export interface SlidesTurnDispatcher extends SlidesTurnTarget {
  /** 返回是否已发出;false = 宿主拒绝(会话已删/桥不可用),调用方据此提示用户。 */
  send(turn: SlidesConversationTurn): Promise<boolean>
}

let current: SlidesTurnDispatcher | null = null

export function setSlidesTurnDispatcher(dispatcher: SlidesTurnDispatcher): void {
  current = dispatcher
}

/**
 * 按引用清除。**不能无条件置 null**:React 切换子树时先挂载新面板(注册新的)、再卸载旧面板,
 * 无条件清空会把刚注册的新派发器抹掉,表现为「换一份演示文稿后审批又回流不到会话」。
 */
export function clearSlidesTurnDispatcher(dispatcher: SlidesTurnDispatcher): void {
  if (current === dispatcher) current = null
}

/** 命中当前 deck 的派发器;宿主不是会话产物面板(或已切走)时返回 null。 */
export function resolveSlidesTurnDispatcher(target: SlidesTurnTarget): SlidesTurnDispatcher | null {
  if (!current) return null
  if (current.workspaceRoot !== target.workspaceRoot || current.deckId !== target.deckId) return null
  return current
}
