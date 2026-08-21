// 团队分身（共享角色）会话流式核心（U8）。
//
// 本文件是 core 侧「面向服务端 realtime」的会话引擎，含两部分：
//   1) 纯函数（test-first）：帧保序/去重、代际丢弃、终态归一、帧→Message[] 渲染，
//      以及把「分身会话态」挂到 Conversation 上的读写辅助。这些纯函数被 mutations.ts /
//      queries.ts / ChatArea.tsx 共用，无副作用，便于就近单测。
//   2) AvatarSessionClient：浏览器 WebSocket 客户端。**core 包不碰 process.env / window**，
//      url 与 token 一律由构造参数注入（宿主壳按 apiConfig 派生 ws url + token）。协议逐字
//      对齐服务端 realtime 实测契约（GET /ws；首帧 auth；task scope 显式 subscribe；
//      封套 {type,payload,actor_id,actor_type}）。
//
// 跨包契约提醒：AvatarTaskMessageFrame 对齐服务端 task_message 行（snake_case，不转 camelCase，
// 见 api/types.ts AvatarTaskMessage）。WS 推送 payload 比 HTTP 行多一个 caller_id、少 id/created_at，
// 故此处的 Frame 把 id/created_at 放宽为可选并在需要时兜底。

import type { Conversation, Message } from "../types";
import type { AvatarSessionOutcome, AvatarSessionPhase } from "../desktop/avatar-types";
import type { AvatarConversationTurn, AvatarSessionSummary, AvatarTaskMessage } from "../api/types";

// ── 帧形状 ────────────────────────────────────────────────────────────────
// 服务端 task_message 行 + WS 定向帧的并集：seq/type 必有；id/created_at HTTP 路径才有；
// caller_id 仅 WS 推送带。渲染只依赖 type/tool/content/input，dedup 只依赖 seq。
export interface AvatarTaskMessageFrame {
  id?: string;
  task_id?: string;
  turn_id?: string;
  seq: number;
  type: "text" | "thinking" | "tool" | "tool_use" | "tool_result" | "avatar_status" | "result" | "error";
  tool?: string | null;
  content?: string | null;
  input?: unknown;
  output?: unknown;
  created_at?: string;
  caller_id?: string;
}

// 服务端 task 终态原始 status（agent_task_queue.status）。
export type AvatarTaskRawStatus = "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled";

// avatar:task_state 推送 payload（契约 §5）。
export interface AvatarTaskStatePayload {
  task_id: string;
  caller_id?: string;
  status: AvatarTaskRawStatus;
  failure_reason?: string;
  outcome?: string;
}

// ── 会话态（挂在 Conversation 上）─────────────────────────────────────────
// Conversation 类型（types/index.ts，U1 所有）不含分身字段，故这里以加性可选字段挂载，
// mutations（写）/ queries（写）/ ChatArea（读）三方通过下方读写辅助共享，避免各自造洞。
export interface AvatarSessionState {
  taskId: string | null; // 当前在途 task；null = 无在途（空会话或已终态收尾）
  conversationId: string | null; // 当前用户侧会话容器；取消/轮询走 conversation + turn 语义
  phase: AvatarSessionPhase | null; // 非终态阶段；终态时置 null
  outcome: AvatarSessionOutcome | null; // 终态（8 值）；进行中为 null
  generation: number; // 代际：每次发起 +1，迟到事件按此丢弃（防串场）
  lastSeq: number; // 已消费的最大 seq（HTTP 增量 since 用）
  rows: AvatarTaskMessageFrame[]; // 当前 task 的原始帧（保序去重后）
  replyAnchor: number; // Conversation.messages 中「当前回复」起始下标（其前为历史+用户提问）
}

// Conversation 的加性视图：avatarSession 为可选挂载字段。
type ConversationWithAvatar = Conversation & { avatarSession?: AvatarSessionState };

// 读：取 Conversation 上的分身会话态，无则 null。
export function getAvatarSession(convo: Conversation | null | undefined): AvatarSessionState | null {
  if (!convo) return null;
  return (convo as ConversationWithAvatar).avatarSession ?? null;
}

// 写：返回带新会话态的 Conversation 浅拷贝（不改原引用，符合缓存不可变约定）。
export function withAvatarSession(convo: Conversation, state: AvatarSessionState): Conversation {
  return { ...convo, avatarSession: state } as ConversationWithAvatar;
}

// 新建一次会话的初始态：受理（accepted）、指定代际、无终态。
export function initAvatarSession(generation: number): AvatarSessionState {
  return {
    taskId: null,
    conversationId: null,
    phase: "accepted",
    outcome: null,
    generation,
    lastSeq: 0,
    rows: [],
    replyAnchor: 0,
  };
}

// 会话是否进行中（非终态）：有 phase 且无 outcome —— UI 据此禁用输入并显示取消。
export function isSessionBusy(state: AvatarSessionState | null | undefined): boolean {
  return !!state && state.phase !== null && state.outcome === null;
}

// 已经出现可见正文，但服务端 task 尚未终态时，用于 UI 把“思考中”降噪为“收尾中”。
// 注意：这不等于任务完成；真正能开放下一轮发送的信号仍然只能是 outcome 非空。
export function hasVisibleAvatarReply(rows: AvatarTaskMessageFrame[]): boolean {
  return rows.some((r) => {
    if (r.type !== "text" && r.type !== "result" && r.type !== "error") return false;
    return typeof r.content === "string" && r.content.trim().length > 0;
  });
}

// ── 纯函数：保序 / 去重 ────────────────────────────────────────────────────
// 按 seq 升序插入一帧；已存在同 seq 则幂等忽略（服务端插入序即时序，seq 唯一单调）。
// 返回新数组（不原地改），调用方可安全放进 React 状态/缓存。
export function applyTaskMessage(
  rows: AvatarTaskMessageFrame[],
  incoming: AvatarTaskMessageFrame,
): AvatarTaskMessageFrame[] {
  // 去重：同 seq 视为重复投递（WS 重连回放 / HTTP catch-up 与 WS 交叠都可能重复）。
  if (rows.some((r) => r.seq === incoming.seq)) return rows;
  const next = [...rows, incoming];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

// ── 纯函数：代际丢弃 ────────────────────────────────────────────────────────
// incoming 代际 < 当前代际 → 过期（上一轮会话的迟到帧），丢弃。
export function isStaleGeneration(current: number, incoming: number): boolean {
  return incoming < current;
}

// ── 纯函数：终态归一（契约 §1 映射表）────────────────────────────────────────
// 注意：rejected_quota 不建 task（受理即拒），永不经此函数，由 mutations 依 invoke 429 直接置态。
const FAILURE_REASON_OUTCOME: Record<string, AvatarSessionOutcome> = {
  runtime_offline: "interrupted",
  runtime_recovery: "interrupted",
  share_revoked: "interrupted",
  approval_rejected: "rejected_approval",
  approval_timeout: "timeout_approval",
};

export function mapTaskStateToOutcome(
  status: AvatarTaskRawStatus,
  failureReason: string | undefined,
  result: unknown,
): AvatarSessionOutcome | null {
  switch (status) {
    case "completed": {
      // completed 默认 done；result JSON 显式标注 unanswerable 时细分（分身明确无法回答，AE5）。
      const outcome = (result as { outcome?: unknown } | null)?.outcome;
      return outcome === "unanswerable" ? "unanswerable" : "done";
    }
    case "cancelled":
      return "canceled";
    case "failed":
      // failure_reason 细分：基础设施故障（掉线/取消共享）→ interrupted，与真·执行失败区分。
      return (failureReason && FAILURE_REASON_OUTCOME[failureReason]) || "failed";
    default:
      // queued/dispatched/running 等非终态 → 尚无 outcome。
      return null;
  }
}

// ── 纯函数：帧 → Message[] 渲染 ─────────────────────────────────────────────
// 复用现有 Message 判别联合，尽量不加新 kind：
//   thinking → reasoning；tool → agentLog（一步一 item）；text/result → 一条 text 气泡；
//   avatar_status.waiting_approval → text 气泡 +「等待拥有者确认」提示。
// 排版策略（M1）：收集后按「思考 → 工具 → 状态 → 正文」定序输出，保证确定性与可测；正文按 seq
// 顺序拼接 text 增量，result 仅在无增量时兜底为最终答案（避免与增量重复）。
export function messagesToConversation(
  rows: AvatarTaskMessageFrame[],
  opts: { who?: string; time?: string } = {},
): Message[] {
  const who = opts.who ?? "avatar";
  const time = opts.time ?? "";

  let thinking = "";
  let waiting = false;
  let textDelta = "";
  let resultText = "";
  const toolItems: { ic: "check"; text: string }[] = [];

  // rows 已由 applyTaskMessage 维持 seq 升序；这里仍按顺序遍历以保证正文拼接稳定。
  for (const r of rows) {
    switch (r.type) {
      case "thinking":
        thinking += r.content ?? "";
        break;
      case "text":
        textDelta += r.content ?? "";
        break;
      case "result":
        resultText += r.content ?? "";
        break;
      case "tool":
      case "tool_use":
        toolItems.push({ ic: "check", text: r.tool || "工具调用" });
        break;
      case "tool_result":
        break;
      case "error":
        if (r.content) resultText += r.content;
        break;
      case "avatar_status": {
        const state = (r.input as { state?: unknown } | null)?.state;
        if (state === "waiting_approval") waiting = true;
        break;
      }
    }
  }

  const out: Message[] = [];
  if (thinking.trim()) {
    out.push({ kind: "reasoning", who, time, text: thinking, completed: true, uid: `av-think` });
  }
  if (toolItems.length > 0) {
    out.push({ kind: "agentLog", who, time, title: "分身执行过程", completed: true, items: toolItems, uid: `av-tools` });
  }
  if (waiting) {
    out.push({ kind: "text", who, time, text: "等待拥有者确认…", uid: `av-waiting` });
  }
  // 正文：优先用 text 增量拼接；无增量时用 result 兜底最终答案。
  const body = textDelta || resultText;
  if (body) {
    out.push({ kind: "text", who, time, text: body, uid: `av-answer` });
  }
  return out;
}

// ── 终态横幅文案（契约 §ChatArea：8 终态映射，done 无横幅）──────────────────────
// 面向调用者的会话终态提示。放 core 便于就近单测「8 条互不雷同」，由 ChatArea 消费渲染。
// done 返回 null = 正常完成不打扰（无横幅）。
const OUTCOME_BANNER: Record<Exclude<AvatarSessionOutcome, "done">, string> = {
  unanswerable: "分身无法回答此问题",
  rejected_quota: "今日调用次数已达上限",
  rejected_approval: "拥有者拒绝了本次调用",
  timeout_approval: "拥有者未响应，已自动拒绝",
  canceled: "已取消，部分输出已保留",
  interrupted: "执行中断（拥有者掉线或取消共享），可重新提问",
  failed: "执行失败，请稍后重试",
};

export function avatarOutcomeBanner(outcome: AvatarSessionOutcome | null | undefined): string | null {
  if (!outcome || outcome === "done") return null;
  return OUTCOME_BANNER[outcome] ?? null;
}

// ── 会话历史组装（queries.conversationOptions 用）────────────────────────────
// 把「最近一轮 session 摘要 + 其保序帧」组装成完整 Conversation，并挂上分身会话态：
//   messages = [用户提问] + [分身回复渲染]；replyAnchor=1（用户提问后即回复）。
//   会话态：终态则 taskId/phase 置空、outcome 落定；非终态保留 taskId/phase（供取消，M1 不恢复流式）。
export function buildAvatarConversation(
  session: AvatarSessionSummary,
  rows: AvatarTaskMessage[],
  opts: { who?: string } = {},
): Conversation {
  let folded: AvatarTaskMessageFrame[] = [];
  for (const r of rows) folded = applyTaskMessage(folded, r as AvatarTaskMessageFrame);
  const lastSeq = folded.reduce((max, r) => Math.max(max, r.seq), 0);
  const terminal = session.outcome !== null;

  const userMsg: Message = { kind: "text", who: "me", time: "", text: session.prompt, uid: "av-prompt" };
  const reply = messagesToConversation(folded, { who: opts.who ?? "avatar" });
  const base: Conversation = {
    headerStatus: { dot: "online", text: "" },
    metaRow: [],
    messages: [userMsg, ...reply],
  };
  const state: AvatarSessionState = {
    taskId: terminal ? null : session.task_id,
    conversationId: session.conversation_id,
    phase: terminal ? null : session.phase,
    outcome: session.outcome,
    generation: 1,
    lastSeq,
    rows: folded,
    replyAnchor: 1,
  };
  return withAvatarSession(base, state);
}

// 多轮会话历史组装（migration 100，caller 侧刷新重建用）：把「会话下所有轮」拼成完整 Conversation。
//   messages = 逐轮 [用户提问 + 该轮回复渲染]；replyAnchor 落在**最后一轮**用户提问之后
//   （foldSessionIntoCache 直播时 slice(0, anchor) + 重建最后一轮回复，故 anchor 必须指向最后一轮）。
//   会话态：最后一轮非终态 → 保留其 taskId/phase（供取消 + 增量续拉）；否则 outcome 落定、taskId 置空。
//   rows/lastSeq 取自最后一轮（直播只续接在途的最后一轮，历史轮已定稿冻结在 messages 里）。
export function buildAvatarConversationFromTurns(
  turns: AvatarConversationTurn[],
  opts: { who?: string; conversationId?: string } = {},
): Conversation {
  const who = opts.who ?? "avatar";
  const messages: Message[] = [];
  let lastUserIndex = 0;
  let lastFolded: AvatarTaskMessageFrame[] = [];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;

  for (const turn of turns) {
    const turnId = turn.turn_id || turn.task_id || "unknown";
    lastUserIndex = messages.length; // 本轮用户提问的下标
    messages.push({ kind: "text", who: "me", time: "", text: turn.prompt, uid: `av-prompt-${turnId}` });
    let folded: AvatarTaskMessageFrame[] = [];
    for (const r of turn.messages) folded = applyTaskMessage(folded, r as AvatarTaskMessageFrame);
    messages.push(...messagesToConversation(folded, { who }));
    lastFolded = folded;
  }

  const base: Conversation = { headerStatus: { dot: "online", text: "" }, metaRow: [], messages };
  const terminal = !lastTurn || lastTurn.outcome !== null;
  const lastSeq = lastFolded.reduce((max, r) => Math.max(max, r.seq), 0);
  const state: AvatarSessionState = {
    taskId: terminal ? null : (lastTurn?.turn_id || lastTurn?.task_id || null),
    conversationId: opts.conversationId ?? null,
    phase: terminal ? null : (lastTurn?.phase ?? null),
    outcome: lastTurn?.outcome ?? null,
    generation: 1,
    lastSeq,
    rows: lastFolded,
    replyAnchor: lastTurn ? lastUserIndex + 1 : 0,
  };
  return withAvatarSession(base, state);
}

// ── AvatarSessionClient：面向服务端 realtime 的 WS 客户端 ──────────────────────
// core 包不碰 process.env / window：url（含 ?workspace_id=）与 token 均由构造参数注入。
// 协议（服务端实测契约，逐字）：连接 → 首帧 {"type":"auth","payload":{"token"}} → 等 auth_ack →
// 对每个已登记 task 发 {"type":"subscribe","payload":{"scope":"task","id"}}；断线重连后重放订阅
// （服务端不持久化订阅）。收 avatar:task_message / avatar:task_state 经回调透出（纯函数在外处理）。

export interface AvatarSessionClientOptions {
  url: string; // 完整 ws 端点（含 ?workspace_id=<uuid> 或 ?workspace_slug=），由壳派生
  token: string; // JWT 或 mul_ 前缀 PAT（首帧鉴权）
  socketFactory?: (url: string) => WebSocket; // 注入点：默认 globalThis.WebSocket（测试注入 fake）
  onTaskMessage?: (payload: AvatarTaskMessageFrame) => void;
  onTaskState?: (payload: AvatarTaskStatePayload) => void;
  onAvatarUpdated?: (payload: { runtime_id: string }) => void;
  reconnect?: boolean; // 断线是否自动重连（默认 true）；测试可关
}

// 服务端统一推送封套（listeners.go）：{type,payload,actor_id,actor_type}。
interface Envelope {
  type: string;
  payload?: unknown;
  actor_id?: string;
  actor_type?: string;
}

export class AvatarSessionClient {
  private readonly opts: AvatarSessionClientOptions;
  private socket: WebSocket | null = null;
  private authed = false;
  // 已登记的 task 订阅集合：auth_ack 后逐一 subscribe；断线重连后重放。
  private readonly tasks = new Set<string>();
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000; // 指数退避起点

  constructor(opts: AvatarSessionClientOptions) {
    this.opts = opts;
  }

  // 建立连接并挂事件；重复调用是幂等的（已连即忽略）。
  connect(): void {
    if (this.socket) return;
    this.closedByUser = false;
    const factory = this.opts.socketFactory ?? ((url: string) => new WebSocket(url));
    const sock = factory(this.opts.url);
    this.socket = sock;
    this.authed = false;

    sock.onopen = () => {
      // 首帧必须是 auth（WS 无法带自定义 header，浏览器/桌面走首帧鉴权）。
      this.send({ type: "auth", payload: { token: this.opts.token } });
    };
    sock.onmessage = (ev) => this.handleMessage(ev.data);
    sock.onclose = () => this.handleClose();
    sock.onerror = () => {
      // 错误交由 onclose 统一走重连；此处不额外动作，避免双触发。
    };
  }

  // 登记并（若已鉴权）立即订阅一个 task scope；未鉴权时先入集合，auth_ack 后补发。
  subscribeTask(taskId: string): void {
    this.tasks.add(taskId);
    if (this.authed) this.send({ type: "subscribe", payload: { scope: "task", id: taskId } });
  }

  // 取消订阅并从重放集合移除（离开会话时调用）。
  unsubscribeTask(taskId: string): void {
    this.tasks.delete(taskId);
    if (this.authed) this.send({ type: "unsubscribe", payload: { scope: "task", id: taskId } });
  }

  // 主动关闭：不再重连。
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.authed = false;
  }

  private send(obj: unknown): void {
    try {
      this.socket?.send(JSON.stringify(obj));
    } catch {
      // 发送失败（socket 已关）忽略；重连后会重放订阅。
    }
  }

  private handleMessage(data: unknown): void {
    let env: Envelope;
    try {
      env = JSON.parse(typeof data === "string" ? data : String(data)) as Envelope;
    } catch {
      return; // 非 JSON 帧忽略（前向兼容）
    }
    switch (env.type) {
      case "auth_ack":
        // 鉴权通过：补发所有已登记订阅（连接即自动订阅 workspace/user scope，task 须显式订阅）。
        this.authed = true;
        this.reconnectDelay = 1000;
        for (const id of this.tasks) this.send({ type: "subscribe", payload: { scope: "task", id } });
        break;
      case "avatar:task_message":
        this.opts.onTaskMessage?.(env.payload as AvatarTaskMessageFrame);
        break;
      case "avatar:task_state":
        this.opts.onTaskState?.(env.payload as AvatarTaskStatePayload);
        break;
      case "avatar:updated":
        this.opts.onAvatarUpdated?.(env.payload as { runtime_id: string });
        break;
      // pong / subscribe_ack / subscribe_error / 未知 type：静默忽略（前向兼容）。
    }
  }

  private handleClose(): void {
    this.socket = null;
    this.authed = false;
    if (this.closedByUser || this.opts.reconnect === false) return;
    // 指数退避重连；重连成功后 auth_ack 分支会重放订阅。
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
