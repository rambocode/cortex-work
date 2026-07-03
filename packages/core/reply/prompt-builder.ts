// 组装起草回复的 system / user 消息。逐函数移植自 ReplyClone ReplyPromptBuilder.swift。
// 段落序固定：档案记忆 → 可见对话 → 意图（typed 压制 voice）→ 日历 → 避重 → 收尾指令。

/** 起草回复的双段 prompt 结果。 */
export interface ReplyPrompt {
  readonly system: string;
  readonly user: string;
}

/** build() 入参；未提供的上下文段落会被静默跳过。 */
export interface ReplyPromptInput {
  conversation: string;
  /** 键入意图；非空时压制 voiceIntent（typed 优先）。 */
  typedIntent?: string | null;
  /** 语音意图；仅在 typedIntent 空白时生效。 */
  voiceIntent?: string | null;
  calendarContext?: string | null;
  userProfile?: string | null;
  /** 对方身份（从窗口标题解析，如「张玲玲-财务」）；非空时随可见对话段注入，让回复贴合具体对象。 */
  counterpartName?: string | null;
  /** 翻牌避重列表：已给过的候选，要求模型换角度重写。空白项会被过滤。 */
  avoidReplies?: readonly string[];
}

// system prompt 的语义必须交代「我 / 对方」标签，让模型以用户身份接话，
// 否则容易把双方说过的话混为一谈、不知道以谁的身份续写。语义照 R3 与源项目一致。
// 「最新话题优先」句：真实对话常横跨多个话题，早前话题往往已在更早的「我：」里回应过、已了结；
// 若不强调聚焦最新一条，模型会回到旧话题（如已答复的服务器/链接），产出无参考价值的建议。
const SYSTEM_PROMPT = `You help the user reply to the visible conversation. In the transcript, lines prefixed "我：" are messages the user has already sent; lines prefixed "对方：" are from the other person. Bracketed lines like "[6月3日 22:17]" are timestamps or system notices separating message groups; use them only as context. Draft the user's next message, continuing the "我" side in the user's voice. Only reply to what the other person said; never repeat or rephrase the user's own previous messages. The transcript may span several topics, and earlier ones are often already resolved by the user's own later messages — prioritize the other person's most recent message or topic. When no explicit intent is given, reply to their latest message and do not resurface older, settled topics. Output only the reply text: no preamble, no quotes, no explanation, no speaker prefix. Match the conversation language. Never send messages automatically.`;

/**
 * 组装起草回复的 system / user 消息；avoidReplies 传入已有候选，
 * 用于「翻牌」时要求模型给出角度 / 措辞明显不同的新回复。
 */
export function buildReplyPrompt(input: ReplyPromptInput): ReplyPrompt {
  const sections: string[] = [];

  const profile = trimmedForPrompt(input.userProfile);
  if (profile.length > 0) {
    sections.push(`User profile:\n${profile}`);
  }

  // 对方身份随可见对话段注入（同段而非独立 section，保持既有段落序契约不变）：
  // 让模型知道「对方」是谁，回复更贴合具体对象；解析不到名称时退回泛化「对方」。
  const counterpart = trimmedForPrompt(input.counterpartName);
  const conversationHeader =
    counterpart.length > 0
      ? `Visible conversation (the other person "对方" is: ${counterpart}):`
      : "Visible conversation:";
  sections.push(`${conversationHeader}\n${trimmedForPrompt(input.conversation)}`);

  // typed 优先压制 voice：仅当 typedIntent 空白时才回退到语音意图
  const typed = trimmedForPrompt(input.typedIntent);
  const voice = trimmedForPrompt(input.voiceIntent);
  if (typed.length > 0) {
    sections.push(`Typed intent, highest priority:\n${typed}`);
  } else if (voice.length > 0) {
    sections.push(`Spoken intent, highest priority:\n${voice}`);
  }

  const calendar = trimmedForPrompt(input.calendarContext);
  if (calendar.length > 0) {
    sections.push(`Calendar availability context:\n${calendar}`);
  }

  // 翻牌场景：列出已给过的候选，强制模型换角度重写而非微调措辞
  const previous = (input.avoidReplies ?? [])
    .map((reply) => trimmedForPrompt(reply))
    .filter((reply) => reply.length > 0);
  if (previous.length > 0) {
    const list = previous.map((reply) => `- ${reply}`).join("\n");
    sections.push(
      `Already suggested replies. Write a clearly different alternative with a different opening, wording, or angle. Do not repeat any of these:\n${list}`,
    );
  }

  sections.push("Return a concise reply that the user can paste directly.");
  return { system: SYSTEM_PROMPT, user: sections.join("\n\n") };
}

/** 去首尾空白；null / undefined 归一为空串（对应 Swift trimmedForPrompt）。 */
function trimmedForPrompt(value: string | null | undefined): string {
  return (value ?? "").trim();
}
