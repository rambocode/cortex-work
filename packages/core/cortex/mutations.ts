// Imperative cache mutations for Cortex Desktop. The user's send / approve
// actions optimistically write the conversation query cache; a fake Agent then
// "replies" after a delay via further cache writes (the demo's liveliness).
//
// Pure transforms (apply*) are split out so they're unit-testable without React.

import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Contact, Conversation, Message, RichText } from "../types";
import { conversationKeys } from "./queries";
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

// ── Hook ─────────────────────────────────────────────────────────────────
export interface CortexActions {
  sendMessage: (contactId: string, contact: Contact | undefined, text: string) => void;
  approveChange: (
    contactId: string,
    contact: Contact | undefined,
    msgUid: string,
    decision: Decision,
  ) => string; // returns a toast string for the caller to surface
}

export function useCortexActions(wsId: string, qcOverride?: QueryClient): CortexActions {
  const qcFromCtx = useQueryClient();
  const qc = qcOverride ?? qcFromCtx;

  const setConvo = useCallback(
    (contactId: string, updater: (prev: ConvoOrNull) => ConvoOrNull) => {
      qc.setQueryData(conversationKeys.detail(wsId, contactId), updater);
    },
    [qc, wsId],
  );

  const sendMessage = useCallback<CortexActions["sendMessage"]>(
    (contactId, contact, text) => {
      if (!text.trim()) return;
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
    [setConvo],
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

  return { sendMessage, approveChange };
}
