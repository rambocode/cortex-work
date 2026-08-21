// Imperative cache mutations for Cortex Desktop. The user's send / approve
// actions optimistically write the conversation query cache; a fake Agent then
// "replies" after a delay via further cache writes (the demo's liveliness).
//
// Pure transforms (apply*) are split out so they're unit-testable without React.

import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Contact, Conversation, Message, RichText } from "../types";
import { ApiError, type ApiClient } from "../api/client";
import type { AvatarConversationTurn } from "../api/types";
import { useCoreContext } from "../provider";
import { useCortexUIStore } from "../store/ui";
import { useTeamUIStore } from "../store/team";
import { registerAvatarTask, unregisterAvatarTask } from "./task-registry";
import { conversationKeys, contactKeys } from "./queries";
import {
  applyTaskMessage,
  getAvatarSession,
  initAvatarSession,
  isSessionBusy,
  isStaleGeneration,
  messagesToConversation,
  withAvatarSession,
  type AvatarSessionState,
  type AvatarTaskMessageFrame,
} from "./session-stream";
import { nowHHMM, uid } from "./time";

type ConvoOrNull = Conversation | null | undefined;
type Decision = "approve" | "reject";

// ── Pure conversation transforms ─────────────────────────────────────────
function dropTyping(messages: Message[]): Message[] {
  return messages.filter((m) => m.kind !== "typing");
}

export function pushMessage(convo: Conversation, msg: Message): Conversation {
  return { ...convo, messages: [...convo.messages, msg] };
}

export function applySendMessage(convo: Conversation, text: string, time: string): Conversation {
  const myMsg: Message = { kind: "text", who: "me", time, text, uid: uid("u") };
  // Drop any standing typing indicator before adding my message.
  return { ...convo, messages: [...dropTyping(convo.messages), myMsg] };
}

export function replaceTypingWithReply(convo: Conversation, typingUid: string, reply: Message): Conversation {
  return { ...convo, messages: [...convo.messages.filter((m) => m.uid !== typingUid), reply] };
}

// Update the diff card preceding the approve card, then turn the approve card
// into an Agent execution log reflecting the decision.
export function applyApproveDecision(
  convo: Conversation,
  msgUid: string,
  decision: Decision,
  time: string,
): Conversation {
  const idx = convo.messages.findIndex((m) => m.uid === msgUid);
  if (idx < 0) return convo;

  const newMessages = [...convo.messages];

  // Walk back up to 4 messages to find the diff card and stamp its status.
  for (let i = idx - 1; i >= Math.max(0, idx - 4); i--) {
    const m = newMessages[i];
    if (m && m.kind === "diff") {
      newMessages[i] = { ...m, status: decision === "approve" ? "applied" : "rejected" };
      break;
    }
  }

  const target = newMessages[idx]!;
  const who = "who" in target ? target.who : "";
  if (decision === "approve") {
    newMessages[idx] = {
      kind: "agentLog",
      who,
      time,
      title: "已批准 · Agent 正在执行",
      active: true,
      uid: msgUid,
      items: [
        {
          ic: "check",
          text: { kind: "rich", parts: [{ t: "text", v: "已写入 3 个文件 · " }, { t: "path", v: "desktop/src/sidebar/*" }] },
        },
        {
          ic: "check",
          text: {
            kind: "rich",
            parts: [
              { t: "text", v: "已运行 " },
              { t: "code", v: "pnpm test --filter desktop" },
              { t: "text", v: " · 通过 (24/24)" },
            ],
          },
        },
        {
          ic: "check",
          text: {
            kind: "rich",
            parts: [
              { t: "text", v: "已提交到 " },
              { t: "code", v: "feat/contact-list" },
              { t: "text", v: " · commit " },
              { t: "code", v: "b1f4e7c" },
            ],
          },
        },
      ],
    };
  } else {
    newMessages[idx] = {
      kind: "agentLog",
      who,
      time,
      title: "已拒绝 · 变更已撤销",
      completed: true,
      uid: msgUid,
      items: [
        { ic: "check", text: "未写入任何文件" },
        { ic: "check", text: { kind: "rich", parts: [{ t: "text", v: "已重置工作树到 " }, { t: "code", v: "HEAD" }] } },
      ],
    };
  }

  return { ...convo, messages: newMessages };
}

// ── Reply scripting ──────────────────────────────────────────────────────
const REPLY_TEMPLATES: { who: (id: string) => string; text: RichText }[] = [
  { who: (id) => `${id}-agent`, text: "收到,我去看一下,稍等。" },
  { who: (id) => id, text: "好的,我让 Agent 处理 👌" },
  {
    who: (id) => `${id}-agent`,
    text: {
      kind: "rich",
      parts: [
        { t: "text", v: "已记录到我的待办,会在 " },
        { t: "code", v: "feat/contact-list" },
        { t: "text", v: " 分支上跟进。" },
      ],
    },
  },
];

function pickReply(contactId: string): Message {
  const tpl = REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)]!;
  return { kind: "text", who: tpl.who(contactId), time: nowHHMM(), text: tpl.text, uid: uid("r") };
}

// ── 团队分身（共享角色）真实调用：invoke + 流式 + 取消 ──────────────────────────
// 说明：core 侧的会话流式引擎（保序/去重/终态/渲染）在 session-stream.ts；这里只做「发起 → 写
// 缓存 → 驱动传输」的编排。传输选型（M1）：HTTP 轮询 conversation turn messages（内容 + 终态）。
// task queue 只是服务端/owner daemon 的内部执行单元；用户侧聊天只依赖 conversation/turn API。

// 分身回复消息的作者标识：用 role_label 作 who（whoMeta 兜底为该名 + 「?」头像，M1 可接受；
// 更贴合的头像映射留后续）。
function avatarWho(contact: Contact | undefined): string {
  return contact?.role || contact?.name || "avatar";
}

// 轮询间隔与上限：1s 一拍，最多 ~5min（与主进程/渲染端看门狗量级一致，防孤儿轮询长跑）。
const AVATAR_POLL_MS = 1000;
const AVATAR_POLL_MAX_TICKS = 300;

export interface AvatarPollingTransportSnapshot {
  frames: AvatarTaskMessageFrame[];
  turn: AvatarConversationTurn;
  conversationId: string;
}

export async function loadAvatarPollingSnapshot(
  api: ApiClient,
  conversationId: string,
  turnId: string,
  sinceSeq: number,
): Promise<AvatarPollingTransportSnapshot> {
  const result = await api.getAvatarConversationTurn(conversationId, turnId, sinceSeq || undefined);
  return {
    frames: result.turn.messages as AvatarTaskMessageFrame[],
    turn: result.turn,
    conversationId: result.conversation_id,
  };
}

export interface AvatarPollingSnapshot {
  contact: Contact | undefined;
  generation: number;
  frames: AvatarTaskMessageFrame[];
  next: {
    taskId: string;
    conversationId?: string;
    phase: AvatarSessionState["phase"];
    outcome: AvatarSessionState["outcome"];
  };
}

export interface AvatarPollingSnapshotResult {
  conversation: ConvoOrNull;
  terminal: boolean;
  terminalConversationId?: string;
}

export function applyAvatarPollingSnapshot(
  prev: ConvoOrNull,
  snapshot: AvatarPollingSnapshot,
): AvatarPollingSnapshotResult {
  if (!prev) return { conversation: prev, terminal: false };
  const cur = getAvatarSession(prev);
  // 代际丢弃：更晚的发起已接管本会话，忽略这批迟到帧（防串场）。
  if (cur && isStaleGeneration(cur.generation, snapshot.generation)) {
    return { conversation: prev, terminal: false };
  }

  let rows = cur?.rows ?? [];
  for (const f of snapshot.frames) rows = applyTaskMessage(rows, f);
  const anchor = cur?.replyAnchor ?? prev.messages.length;
  const lastSeq = rows.reduce((max, r) => Math.max(max, r.seq), cur?.lastSeq ?? 0);
  // time 留空：避免每拍轮询用 nowHHMM() 刷新导致回复时间戳抖动（与 buildAvatarConversation 一致）。
  const reply = messagesToConversation(rows, { who: avatarWho(snapshot.contact) });
  const messages = [...prev.messages.slice(0, anchor), ...reply];
  const terminal = snapshot.next.outcome !== null;
  const state: AvatarSessionState = {
    taskId: terminal ? null : snapshot.next.taskId,
    conversationId: snapshot.next.conversationId ?? cur?.conversationId ?? null,
    phase: terminal ? null : snapshot.next.phase,
    outcome: snapshot.next.outcome,
    generation: snapshot.generation,
    lastSeq,
    rows,
    replyAnchor: anchor,
    // 服务器工作区加性字段：id 沿承；排队计数只在仍处 queued 阶段时保留（开跑即清）。
    serverWorkspaceId: cur?.serverWorkspaceId,
    queuedBehind: !terminal && snapshot.next.phase === "queued" ? cur?.queuedBehind : undefined,
  };
  return {
    conversation: withAvatarSession({ ...prev, messages }, state),
    terminal,
    terminalConversationId: terminal ? snapshot.next.conversationId : undefined,
  };
}

// 把一次会话的流式帧折进会话缓存：读当前缓存 → 代际校验 → 合帧 → 重渲当前回复 → 回写。
// 返回是否已终态（供轮询决定是否停止）。纯写缓存，不做网络。
// 导出给 cortex/realtime.ts：WS 定向帧与 HTTP 轮询共用同一折叠路径（seq 去重保证交叠安全）。
export function foldSessionIntoCache(
  qc: QueryClient,
  wsId: string,
  contactId: string,
  contact: Contact | undefined,
  generation: number,
  frames: AvatarTaskMessageFrame[],
  next: {
    taskId: string;
    conversationId?: string;
    phase: AvatarSessionState["phase"];
    outcome: AvatarSessionState["outcome"];
  },
): Pick<AvatarPollingSnapshotResult, "terminal" | "terminalConversationId"> {
  let terminal = false;
  let terminalConversationId: string | undefined;
  qc.setQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId), (prev) => {
    const result = applyAvatarPollingSnapshot(prev, { contact, generation, frames, next });
    terminal = result.terminal;
    terminalConversationId = result.terminalConversationId;
    return result.conversation;
  });
  return { terminal, terminalConversationId };
}

export function restoreAvatarBusySession(convo: ConvoOrNull): ConvoOrNull {
  if (!convo) return convo;
  const cur = getAvatarSession(convo);
  if (!cur || cur.outcome !== null || !cur.taskId) return convo;
  return withAvatarSession(convo, { ...cur, phase: cur.phase ?? "running" });
}

// ── Hook ─────────────────────────────────────────────────────────────────
export interface CortexActions {
  sendMessage: (contactId: string, contact: Contact | undefined, text: string) => void;
  approveChange: (
    contactId: string,
    contact: Contact | undefined,
    msgUid: string,
    decision: Decision,
  ) => string; // returns a toast string for the caller to surface
  // 团队分身：取消在途会话（原路 kill 拥有者机 CLI）；mock/无 apiClient 时为 no-op。
  cancelSession: (contactId: string, contact: Contact | undefined) => void;
}

export function useCortexActions(wsId: string, qcOverride?: QueryClient): CortexActions {
  const qcFromCtx = useQueryClient();
  const qc = qcOverride ?? qcFromCtx;
  // apiClient 存在 = 真实后端在线 → 分身走真实 invoke/流式；null = 回落 mock（行为不变）。
  const { apiClient } = useCoreContext();

  const setConvo = useCallback(
    (contactId: string, updater: (prev: ConvoOrNull) => ConvoOrNull) => {
      qc.setQueryData(conversationKeys.detail(wsId, contactId), updater);
    },
    [qc, wsId],
  );

  // 轮询驱动一次分身会话流：直到终态或超上限；每拍合帧写缓存，终态后失效通讯录（daily_used 变化）。
  const pollAvatarSession = useCallback(
    async (
      contactId: string,
      contact: Contact | undefined,
      conversationId: string,
      turnId: string,
      generation: number,
      api: ApiClient,
    ) => {
      for (let tick = 0; tick < AVATAR_POLL_MAX_TICKS; tick++) {
        // 代际早退：期间有更晚的发起接管本会话即停。
        const curState = getAvatarSession(qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId)));
        if (curState && isStaleGeneration(curState.generation, generation)) return;
        try {
          const sinceSeq = curState?.lastSeq ?? 0;
          const { frames, turn, conversationId: resolvedConversationId } = await loadAvatarPollingSnapshot(
            api,
            conversationId,
            turnId,
            sinceSeq,
          );
          const outcome = turn.outcome ?? null;
          const phase = turn.phase ?? "running";
          const { terminal } = foldSessionIntoCache(
            qc,
            wsId,
            contactId,
            contact,
            generation,
            frames,
            {
              taskId: turn.turn_id || turn.task_id || turnId,
              conversationId: resolvedConversationId,
              phase,
              outcome,
            },
          );
          if (terminal) {
            // 终态：当前会话走权威历史 refetch 补齐可能漏掉的末帧；通讯录在线态 / 今日已用次数也失效重取。
            unregisterAvatarTask(turnId); // WS 定向订阅随之退订（幂等，另一路终态先到也安全）
            void qc.invalidateQueries({ queryKey: conversationKeys.detail(wsId, contactId) });
            void qc.invalidateQueries({ queryKey: contactKeys.list(wsId) });
            return;
          }
        } catch {
          // 单拍网络抖动忽略，继续轮询；持续失败由上限兜底停止。
        }
        await new Promise((r) => setTimeout(r, AVATAR_POLL_MS));
      }
      // 轮询上限耗尽仍未见终态：不能伪造一个 8 值 outcome(与服务端终态契约逐字对齐,
      // 见 avatar-types.ts 注释——服务端任务可能仍在跑,也可能是孤儿 task,并非真已终态)。
      // 仿 handleInvokeError 的「非终态失败」分支:解除 busy 放行用户重试/重发,并用 toast
      // 显式告知,而非让 UI 静默永久卡在「思考中」(此前的 bug:循环耗尽后直接 return,
      // 缓存里 phase 仍非空、outcome 仍为 null,isSessionBusy 永远为真)。
      const curState = getAvatarSession(qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId)));
      unregisterAvatarTask(turnId);
      if (curState && !isStaleGeneration(curState.generation, generation) && isSessionBusy(curState)) {
        useCortexUIStore.getState().pushToast("长时间未收到分身响应，已停止等待（任务可能仍在后台执行）", { kind: "error" });
        setConvo(contactId, (prev) => {
          if (!prev) return prev;
          const cur = getAvatarSession(prev);
          if (!cur || isStaleGeneration(cur.generation, generation)) return prev;
          return withAvatarSession(prev, { ...cur, taskId: null, phase: null });
        });
      }
    },
    [qc, wsId, setConvo],
  );

  // 受理失败呈现：429 → 超限终态横幅；409 → 忙碌 toast 并解禁输入；503/其它 → toast + 解禁。
  const handleInvokeError = useCallback(
    (contactId: string, generation: number, err: unknown, previousConvo?: ConvoOrNull) => {
      const toast = useCortexUIStore.getState().pushToast;
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "conversation_busy") {
        toast("上一轮仍在服务端收尾，请稍候再试", { kind: "error" });
        if (previousConvo !== undefined) {
          setConvo(contactId, () => restoreAvatarBusySession(previousConvo));
        } else {
          setConvo(contactId, (prev) => {
            if (!prev) return prev;
            const cur = getAvatarSession(prev);
            if (!cur || isStaleGeneration(cur.generation, generation)) return prev;
            return null;
          });
        }
        void qc.invalidateQueries({ queryKey: conversationKeys.detail(wsId, contactId) });
        void qc.invalidateQueries({ queryKey: contactKeys.list(wsId) });
        return;
      }
      // 终态化：超限（受理即拒，无 task）落 rejected_quota 横幅。
      if (code === "quota_exceeded" || code === "caller_quota_exceeded") {
        setConvo(contactId, (prev) => {
          if (!prev) return prev;
          const cur = getAvatarSession(prev);
          if (!cur || isStaleGeneration(cur.generation, generation)) return prev;
          return withAvatarSession(prev, { ...cur, taskId: null, phase: null, outcome: "rejected_quota" });
        });
        return;
      }
      // 非终态失败：解除 busy（phase=null）让用户可重试，并 toast 说明。
      const msg =
        code === "avatar_offline"
            ? "分身已离线，无法应答"
            : code === "avatar_unavailable"
              ? "分身在线但本机 CLI 不可用"
              : "发起失败，请稍后重试";
      toast(msg, { kind: "error" });
      setConvo(contactId, (prev) => {
        if (!prev) return prev;
        const cur = getAvatarSession(prev);
        if (!cur || isStaleGeneration(cur.generation, generation)) return prev;
        return withAvatarSession(prev, { ...cur, taskId: null, phase: null });
      });
    },
    [qc, setConvo, wsId],
  );

  // 分身真实发起：乐观插入用户消息 → invoke → 存 task/代际 → 轮询流式；受理失败按 code 呈现。
  const invokeAvatar = useCallback(
    async (contactId: string, contact: Contact, text: string, api: ApiClient) => {
      const runtimeId = contact.runtimeId ?? contact.id;
      // 串行约束（R11）：已有在途会话时禁止再发（UI 亦禁用输入，此处双重兜底）。
      const existing = getAvatarSession(qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId)));
      if (isSessionBusy(existing)) {
        useCortexUIStore.getState().pushToast("当前对话进行中，请等回答结束后再发送", { kind: "info" });
        return;
      }
      // 乐观插入用户消息，并以 messages 末尾为 replyAnchor（其后渲染分身回复）。
      // 首次向该分身提问时缓存可能为 null（mock 无此会话）→ 兜底建空会话，否则乐观插入会被丢弃。
      const generation = (existing?.generation ?? 0) + 1;
      const previousConvo = qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId));
      setConvo(contactId, (prev) => {
        const seed: Conversation = prev ?? { headerStatus: { dot: "online", text: "" }, metaRow: [], messages: [] };
        const withUser = applySendMessage(seed, text, nowHHMM());
        return withAvatarSession(withUser, { ...initAvatarSession(generation), replyAnchor: withUser.messages.length });
      });

      try {
        const { conversation_id, turn_id, task_id, approval_required } = await api.invokeAvatar(runtimeId, text);
        const turnId = turn_id || task_id;
        if (!conversation_id || !turnId) {
          throw new Error("avatar invoke response missing conversation_id or turn_id");
        }
        setConvo(contactId, (prev) => {
          if (!prev) return prev;
          const cur = getAvatarSession(prev);
          if (!cur) return prev;
          return withAvatarSession(prev, {
            ...cur,
            taskId: turnId,
            conversationId: conversation_id,
            phase: approval_required ? "waiting_approval" : "running",
          });
        });
        // 登记在途任务：realtime 层据此订阅 WS task scope 实时折帧（轮询兜底并行，seq 去重安全）。
        registerAvatarTask(turnId, { contactId, contact, generation, conversationId: conversation_id });
        void pollAvatarSession(contactId, contact, conversation_id, turnId, generation, api);
      } catch (err) {
        handleInvokeError(contactId, generation, err, previousConvo);
      }
    },
    [qc, wsId, setConvo, pollAvatarSession, handleInvokeError],
  );

  // 服务器工作区发起：与 invokeAvatar 同构（乐观插入 + 代际 + 轮询流式），差异只有三点——
  // ① 打 /api/server-workspaces/{id}/invoke（body 带 runtime_id）；② 排队不是错误：受理响应
  // queue_position>0 → phase="queued"（BusyComposer 显示排队提示，任务开跑后由轮询/WS 纠正）；
  // ③ 错误码集合不同（instance_provisioning / runtime_offline）。会话容器/流式管道与分身共用，
  // 故轮询与取消路径原样复用。
  const invokeServerWorkspace = useCallback(
    async (
      contactId: string,
      contact: Contact,
      text: string,
      api: ApiClient,
      sel: { runtimeId: string; serverWorkspaceId: string },
    ) => {
      const existing = getAvatarSession(qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId)));
      if (isSessionBusy(existing)) {
        useCortexUIStore.getState().pushToast("当前对话进行中，请等回答结束后再发送", { kind: "info" });
        return;
      }
      const generation = (existing?.generation ?? 0) + 1;
      const previousConvo = qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId));
      setConvo(contactId, (prev) => {
        const seed: Conversation = prev ?? { headerStatus: { dot: "online", text: "" }, metaRow: [], messages: [] };
        const withUser = applySendMessage(seed, text, nowHHMM());
        return withAvatarSession(withUser, {
          ...initAvatarSession(generation),
          replyAnchor: withUser.messages.length,
          serverWorkspaceId: sel.serverWorkspaceId,
        });
      });

      try {
        const { conversation_id, turn_id, task_id, queue_position } = await api.invokeServerWorkspace(
          sel.serverWorkspaceId,
          { prompt: text, runtime_id: sel.runtimeId },
        );
        const turnId = turn_id || task_id;
        if (!conversation_id || !turnId) {
          throw new Error("server workspace invoke response missing conversation_id or turn_id");
        }
        setConvo(contactId, (prev) => {
          if (!prev) return prev;
          const cur = getAvatarSession(prev);
          if (!cur) return prev;
          return withAvatarSession(prev, {
            ...cur,
            taskId: turnId,
            conversationId: conversation_id,
            phase: queue_position > 0 ? "queued" : "running",
            queuedBehind: queue_position > 0 ? queue_position : undefined,
          });
        });
        registerAvatarTask(turnId, { contactId, contact, generation, conversationId: conversation_id });
        void pollAvatarSession(contactId, contact, conversation_id, turnId, generation, api);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : undefined;
        // 专属错误码呈现；其余（含 conversation_busy/quota）沿用分身的统一处理。
        if (code === "instance_provisioning") {
          useCortexUIStore.getState().pushToast("你的专属工作树正在服务器上准备，稍候重试", { kind: "info" });
          setConvo(contactId, () => restoreAvatarBusySession(previousConvo));
          return;
        }
        if (code === "runtime_offline" || code === "server_workspace_not_ready") {
          useCortexUIStore.getState().pushToast(
            code === "runtime_offline" ? "服务器执行节点离线" : "服务器工作区尚未就绪", { kind: "error" });
          setConvo(contactId, () => restoreAvatarBusySession(previousConvo));
          return;
        }
        handleInvokeError(contactId, generation, err, previousConvo);
      }
    },
    [qc, wsId, setConvo, pollAvatarSession, handleInvokeError],
  );

  const sendMessage = useCallback<CortexActions["sendMessage"]>(
    (contactId, contact, text) => {
      if (!text.trim()) return;
      // 团队分身 + 真实后端 → 走 invoke/流式；否则回落 mock（个人/演示/无后端）。
      // 会话目标选定了服务器工作区（useTeamUIStore 客户端态）→ 改走服务器工作区 invoke，
      // 在服务器上的持久 checkout 里执行；未选择 → 维持分身直连（拥有者机器）语义。
      if (apiClient && contact?.kind === "avatar") {
        const sel = useTeamUIStore.getState().selection[contactId];
        if (sel) {
          void invokeServerWorkspace(contactId, contact, text, apiClient, sel);
        } else {
          void invokeAvatar(contactId, contact, text, apiClient);
        }
        return;
      }
      setConvo(contactId, (prev) => (prev ? applySendMessage(prev, text, nowHHMM()) : prev));

      // Fake Agent reply for non-self contacts: typing indicator, then a reply.
      if (contact && contact.id !== "me") {
        const typingUid = uid("t");
        setTimeout(() => {
          setConvo(contactId, (prev) =>
            prev
              ? pushMessage(prev, {
                  kind: "typing",
                  who: contact.id,
                  text: `${contact.name} · Agent 正在思考…`,
                  uid: typingUid,
                })
              : prev,
          );
        }, 350);
        setTimeout(() => {
          setConvo(contactId, (prev) => (prev ? replaceTypingWithReply(prev, typingUid, pickReply(contact.id)) : prev));
        }, 1800);
      }
    },
    [setConvo, apiClient, invokeAvatar],
  );

  // 取消在途分身会话：调 conversation turn cancel（服务端 → daemon → kill CLI 进程组），本地立即落
  // canceled 终态（保留已流式的 partial 输出，AE9）；轮询侧观察到 cancelled 亦幂等一致。
  const cancelSession = useCallback<CortexActions["cancelSession"]>(
    (contactId, contact) => {
      if (!apiClient || contact?.kind !== "avatar") return;
      const cur = getAvatarSession(qc.getQueryData<Conversation | null>(conversationKeys.detail(wsId, contactId)));
      const turnId = cur?.taskId;
      const conversationId = cur?.conversationId;
      if (!turnId || !conversationId) return;
      unregisterAvatarTask(turnId);
      void apiClient.cancelAvatarTurn(conversationId, turnId).catch(() => {
        useCortexUIStore.getState().pushToast("取消请求发送失败，请重试", { kind: "error" });
      });
      setConvo(contactId, (prev) => {
        if (!prev) return prev;
        const s = getAvatarSession(prev);
        if (!s) return prev;
        return withAvatarSession(prev, { ...s, taskId: null, phase: null, outcome: "canceled" });
      });
      void qc.invalidateQueries({ queryKey: contactKeys.list(wsId) });
    },
    [apiClient, qc, wsId, setConvo],
  );

  const approveChange = useCallback<CortexActions["approveChange"]>(
    (contactId, contact, msgUid, decision) => {
      setConvo(contactId, (prev) => (prev ? applyApproveDecision(prev, msgUid, decision, nowHHMM()) : prev));

      // Agent follow-up text after a short delay.
      setTimeout(() => {
        if (!contact) return;
        const reply =
          decision === "approve"
            ? "🎉 干完了,合并请求已发到 #frontend-core,你看看要不要直接合。"
            : "好的,我会再调一版,有想法随时叫我。";
        setConvo(contactId, (prev) =>
          prev ? pushMessage(prev, { kind: "text", who: contact.id, time: nowHHMM(), text: reply, uid: uid("r") }) : prev,
        );
      }, 1500);

      return decision === "approve" ? "已批准变更 · Agent 开始执行" : "已拒绝变更";
    },
    [setConvo],
  );

  return { sendMessage, approveChange, cancelSession };
}
