// 组装起草回复的 system / user 消息。源自 ReplyClone ReplyPromptBuilder.swift 移植，
// 后经立场协议（stance）与 IM 风格约束增强。
// 段落序固定：档案记忆 → 可见对话 → 意图（typed 压制 voice）→ 日历 → 避重 → 定向立场 → 收尾指令。
//
// 缓存约束（费用敏感，勿破坏）：直连供应商普遍支持自动前缀缓存（OpenAI ≥1024 token 前缀、
// DeepSeek 上下文缓存），命中判据是请求 token 前缀逐字节一致。一轮会话要发多次请求
// （首条 + 定向立场 ×3 + 翻牌 ×N），它们共享 system+档案+对话+意图+日历 大前缀——因此：
//   1) SYSTEM_PROMPT 必须是单一静态常量，禁止按调用类型插值改写；
//   2) 随调用变化的内容（avoidReplies / requestedStance）只能排在 user 消息尾部；
//   3) prompt 内不得引入时间戳 / 随机序。

import type { ReplyStance } from "./stance";

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
  /**
   * 对话级记忆段（composeConversationMemory 组装的成文）：与当前对话对象的既往互动要点
   * 或最近采纳回复。一轮会话内恒定，紧随 userProfile 注入，不破坏轮内前缀缓存。
   */
  conversationMemory?: string | null;
  /** 对方身份（从窗口标题解析，如「张玲玲-财务」）；非空时随可见对话段注入，让回复贴合具体对象。 */
  counterpartName?: string | null;
  /** 翻牌避重列表：已给过的候选，要求模型换角度重写。空白项会被过滤。 */
  avoidReplies?: readonly string[];
  /**
   * 定向立场（决策点场景的预生成 / 立场卡翻牌用）：非空时在尾部追加「按此立场写」指令，
   * 候选立场由调用方指定而非依赖模型回显。null / 缺省 = 模型自判（首条推荐回复）。
   */
  requestedStance?: ReplyStance | null;
}

// system prompt 的语义必须交代「我 / 对方」标签，让模型以用户身份接话，
// 否则容易把双方说过的话混为一谈、不知道以谁的身份续写。
// 「最新话题优先」段：真实对话常横跨多个话题，早前话题往往已在更早的「我：」里回应过、已了结；
// 若不强调聚焦最新一条，模型会回到旧话题（如已答复的服务器/链接），产出无参考价值的建议。
// 「Style」段：压制 AI 味（套话 / 长段 / bullet），要求贴合用户既有口吻——质量反馈的主要整改点。
// 「Stance protocol」段：要求首行输出机器可读立场标记（决策点判定 + 推荐立场），协议解析
// 见 stance.ts 的 parseStanceLine；标记行会被剥离，正文约束与旧版「Output only the reply text」等价。
// 注意：本常量必须保持静态（缓存约束见文件头），任何 per-call 差异走 user 消息尾部段落。
const SYSTEM_PROMPT = `You help the user reply to the visible conversation. In the transcript, lines prefixed "我：" are messages the user has already sent; lines prefixed "对方：" are from the other person. Bracketed lines like "[6月3日 22:17]" are timestamps or system notices separating message groups; use them only as context.

Draft the user's next message, continuing the "我" side in the user's voice. Only reply to what the other person said; never repeat or rephrase the user's own previous messages. The transcript may span several topics, and earlier ones are often already resolved by the user's own later messages — prioritize the other person's most recent message or topic and address its core ask directly. When no explicit intent is given, reply to their latest message and do not resurface older, settled topics.

Style: write like a real instant message — short, natural, conversational. Mirror the user's tone and wording habits from the profile and their earlier "我：" lines. One or two short sentences are usually enough. No greetings, no sign-offs, no filler phrases such as "您好", "希望这能帮到你" or "Hope this helps", no bullet points, and no emoji unless the user's own messages use them.

Stance protocol: first decide whether the other person's latest message is a decision point — a request, proposal, or question that asks the user to commit to something (take on work, confirm a time, approve a plan, provide something). Your reply must start with exactly one machine-readable tag on its own first line: if it is a decision point, output [stance:agree], [stance:reject], or [stance:unsure] matching the stance your reply takes (unsure means the user should ask the key clarifying question before deciding); otherwise output [stance:none]. These four tags are the only valid values — never invent others such as [stance:question]. The tag line is read by the app and stripped; everything after it must be only the reply text itself — no preamble, no quotes, no explanation, no speaker prefix. Match the conversation language. Never send messages automatically.`;

// 定向立场指令（requestedStance 段用）：三档各配一句语义说明，让模型明确该立场下回复该做什么。
const STANCE_DIRECTIVES: Record<ReplyStance, string> = {
  agree: "agree — accept the request and commit to it",
  reject: "reject — politely but clearly decline the request",
  unsure:
    "unsure — do not commit yet; ask the single most important clarifying question before deciding",
};

/**
 * 组装起草回复的 system / user 消息；avoidReplies 传入已有候选（翻牌避重），
 * requestedStance 非空时要求模型按指定立场重写（决策点场景的定向候选）。
 */
export function buildReplyPrompt(input: ReplyPromptInput): ReplyPrompt {
  const sections: string[] = [];

  const profile = trimmedForPrompt(input.userProfile);
  if (profile.length > 0) {
    sections.push(`User profile:\n${profile}`);
  }

  // 对话级记忆段（成文已含「与谁」的中文标注，此处不再加英文标题前缀以免语言混杂）。
  // 位置契约：profile 之后、可见对话之前——轮内多请求（首条/立场/翻牌）该段恒定，前缀缓存安全。
  const conversationMemory = trimmedForPrompt(input.conversationMemory);
  if (conversationMemory.length > 0) {
    sections.push(conversationMemory);
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

  // ── 以下为随调用变化的尾部段落（缓存约束：新增变量段只能加在这之后）──────────────

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

  // 定向立场段：决策点场景要求模型按指定立场写（立场由调用方指定，不依赖模型自判）。
  const stance = input.requestedStance;
  if (stance != null) {
    sections.push(
      `Required stance for this reply — the other person's latest message is a decision point, and the reply must take this stance: ${STANCE_DIRECTIVES[stance]}.`,
    );
  }

  sections.push(
    "First line: the stance tag. Then one concise IM-style reply the user can paste directly.",
  );
  return { system: SYSTEM_PROMPT, user: sections.join("\n\n") };
}

/** 去首尾空白；null / undefined 归一为空串（对应 Swift trimmedForPrompt）。 */
function trimmedForPrompt(value: string | null | undefined): string {
  return (value ?? "").trim();
}
