// reply 会话状态机 + 世代 token + 若干捕获/输出纯逻辑（U7）。
//
// 本模块**不 import electron / helper-client / bubble-window**——全部是可脱离宿主单测的
// 纯逻辑（仿 hotkey.ts / controller 拆分惯例）。真正的副作用编排（spawn helper、推气泡、
// kill 在途 CLI）在 controller.ts 里调用本模块的裁决结果执行。
//
// 并发安全（R7）唯一裁决机制：每次「新一轮捕获」或「取消/关闭」都递增世代 token；所有跨状态
// 回调（AX/OCR/日历/CLI 输出）在 spawn 时记住当时 token，回来时用 isCurrent(token) 校验，
// 不符即静默丢弃。见 High-Level Technical Design 的状态机图。

/** 会话阶段（与气泡可视子集对应；idle 表示无进行中的会话）。 */
export type ReplyPhase =
  | "idle"
  | "recording"
  | "capturing"
  | "generating"
  | "presenting"
  | "writing";

/**
 * 单个 reply 会话的纯状态容器。持有当前阶段、世代 token、候选列表与捕获目标 pid，
 * 并暴露状态机转移方法。所有转移都不产生副作用，只改内部状态并（必要时）返回 token。
 */
export class ReplySession {
  private _phase: ReplyPhase = "idle";
  private _token = 0;
  private _candidates: string[] = [];
  private _index = 0;
  private _capturedPid: number | null = null;

  get phase(): ReplyPhase {
    return this._phase;
  }
  get token(): number {
    return this._token;
  }
  get candidates(): readonly string[] {
    return this._candidates;
  }
  get currentIndex(): number {
    return this._index;
  }
  /** 当前展示（并将被写回）的草稿正文；无候选时为空串。 */
  get currentDraft(): string {
    return this._candidates[this._index] ?? "";
  }
  get capturedPid(): number | null {
    return this._capturedPid;
  }

  /**
   * 携带 token 的回调是否仍属当前会话。token 一旦递增（新捕获 / 取消 / 关闭），
   * 旧回调即过期——这是过期回调丢弃、重入取消、esc kill 生效的统一判据。
   */
  isCurrent(token: number): boolean {
    return token === this._token;
  }

  /**
   * 开始新一轮捕获：idle→capturing、recording(voice-end)→capturing、以及
   * generating/presenting 的重入取消→capturing 都走此入口。递增 token 作废上一轮遗留回调，
   * 清空候选与捕获目标。返回新 token 供本轮所有异步回调携带。
   */
  beginCapture(): number {
    this._token += 1;
    this._phase = "capturing";
    this._candidates = [];
    this._index = 0;
    this._capturedPid = null;
    return this._token;
  }

  /**
   * voice-start：进入 recording（等待松开语音键）。递增 token 作废上一轮遗留回调 / 提示定时器，
   * 清空候选与捕获目标——每次按住语音键都是一轮全新会话。返回新 token。
   */
  beginRecording(): number {
    this._token += 1;
    this._phase = "recording";
    this._candidates = [];
    this._index = 0;
    this._capturedPid = null;
    return this._token;
  }

  /**
   * 错误态重试重生成：递增 token 作废在途回调，回到 generating 并清空候选，
   * 但**保留 capturedPid**——与 beginCapture 的唯一区别。错误态 retry 复用 controller 侧
   * 已捕获的 pending 上下文与本会话 capturedPid，不重新捕获；递增 token 是重试单飞的裁决点：
   * 连点重试时旧一轮生成回调因 token 过期被丢弃，配合 controller 的 abortInFlight 只留一个在跑。
   */
  beginRegenerate(): number {
    this._token += 1;
    this._phase = "generating";
    this._candidates = [];
    this._index = 0;
    return this._token;
  }

  /** 记录捕获到的目标应用 pid（写回前 pid 校验用；AX 取不到时为 null）。 */
  setCapturedPid(pid: number | null): void {
    this._capturedPid = pid;
  }

  /** 捕获完成（AX 或 OCR 重建成功）→generating。 */
  toGenerating(): void {
    this._phase = "generating";
  }

  /** 首条候选到达→presenting（候选置为单元素、索引归零）。 */
  presentFirst(text: string): void {
    this._candidates = [text];
    this._index = 0;
    this._phase = "presenting";
  }

  /**
   * 后台预生成候选追加：去重、**不移动当前索引**（用户正看的候选不被打断）。
   * 仅在 presenting 阶段接受；返回是否真正入列（重复则忽略）。
   */
  appendPreGenerated(text: string): boolean {
    if (this._phase !== "presenting") return false;
    if (this._candidates.includes(text)) return false;
    this._candidates.push(text);
    return true;
  }

  /**
   * 「翻牌」候选追加：入列并把当前索引移到新候选（避重由 prompt 侧 avoidReplies 保证，
   * 故此处不去重——即便偶发雷同也让用户看到「翻了一张」的反馈）。
   */
  appendFlip(text: string): void {
    this._candidates.push(text);
    this._index = this._candidates.length - 1;
  }

  /** 直接跳到某候选（点击圆点）；越界忽略。 */
  setIndex(index: number): void {
    if (index >= 0 && index < this._candidates.length) this._index = index;
  }

  /** ←/→ 循环切换当前候选（空列表 no-op）。 */
  cycle(delta: number): void {
    const n = this._candidates.length;
    if (n === 0) return;
    this._index = (((this._index + delta) % n) + n) % n;
  }

  /** 翻牌避重列表 = 当前所有候选（要求模型换角度重写）。 */
  avoidList(): string[] {
    return [...this._candidates];
  }

  /** ↩ 写回：presenting→writing（写回期间 token 不变，pre-gen 回调仍可被 phase 门控丢弃）。 */
  toWriting(): void {
    this._phase = "writing";
  }

  /**
   * 回到 idle（写回完成 / esc 取消 / 生成失败 / 关闭）。递增 token 作废所有在途回调，
   * 清空候选与捕获目标。返回失效前后无关的新 token（调用方一般不需要）。
   */
  reset(): number {
    this._token += 1;
    this._phase = "idle";
    this._candidates = [];
    this._index = 0;
    this._capturedPid = null;
    return this._token;
  }
}

// ── 捕获与写回的纯判据 ────────────────────────────────────────────────────────

/** AX / OCR 文本里需要先排除的输入框占位符（移植源项目 AccessibilityBridge.isPlaceholder）。 */
const CONVERSATION_PLACEHOLDERS = [
  "输入文字",
  "按住Fn使用语音输入",
  "输入文字，或按住Fn使用语音输入",
  "Type a message",
];

/**
 * 启发式判断一段文本「像不像一段对话」，决定是否需要从 AX 降级到 OCR、以及 OCR 重建后
 * 是否可用（移植源项目 meaningfulConversation）。判据：足够长、非占位符、且含换行 / 冒号
 * （说话人分隔）或整体较长。
 */
export function looksLikeConversation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) return false;
  if (CONVERSATION_PLACEHOLDERS.some((p) => trimmed.includes(p))) return false;
  return (
    trimmed.includes("\n") ||
    trimmed.includes("：") ||
    trimmed.includes(":") ||
    trimmed.length >= 30
  );
}

/**
 * 写回前 pid 校验（R6：目标 app 变了则中止，绝不盲粘）：
 * - 捕获时未拿到 pid（AX 完全失败）→ 保守中止，避免把草稿粘到未知应用；
 * - 当前前台 pid 与捕获时不一致 → 用户已切走，中止。
 */
export function shouldAbortWriteBack(
  capturedPid: number | null,
  currentPid: number | null,
): boolean {
  if (capturedPid == null) return true;
  return currentPid !== capturedPid;
}

// ── agent 输出清洗 ────────────────────────────────────────────────────────────

// 本地 / 小模型常见的特殊 token 残渣（移植源项目 cleanLocalModelArtifacts）。
const ARTIFACT_MARKERS = ["<|repo_name|>", "<|im_start|>", "<|im_end|>"];
// 出现在开头时应整体剥离的角色前缀。
const ROLE_PREFIXES = ["assistant\n", "user\n"];

/**
 * 清洗 agent CLI 输出为可直接粘贴的回复正文（prompt 收尾硬约束的兜底）：
 * 依次剥离 markdown 代码围栏、特殊 token 残渣、开头角色前缀、常见开场白行、成对包裹引号。
 * 保守处理——只削「明显不是正文」的外壳，避免误伤真实内容。
 */
export function cleanAgentOutput(raw: string): string {
  let s = raw.trim();

  // 1) 去 markdown 代码围栏（```lang\n...\n```）；仅当整体被围栏包裹时取内层
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1] != null) s = fence[1].trim();

  // 2) 特殊 token 残渣：截断其后内容
  for (const marker of ARTIFACT_MARKERS) {
    const idx = s.indexOf(marker);
    if (idx >= 0) s = s.slice(0, idx);
  }
  // 3) 开头角色前缀：整段剥离
  for (const prefix of ROLE_PREFIXES) {
    if (s.startsWith(prefix)) s = s.slice(prefix.length);
  }

  // 4) 常见开场白行（「好的，这是回复：」/「Here's a reply:」）——仅当其独占首行、以冒号收尾、
  //    且后面还有正文时才剥离，避免把正文首句误删。
  s = s.replace(
    /^\s*(好的[，,：:\s]*)?(这是|以下是|here(?:'s| is)|sure[，,\s]*here)[^\n]*[:：]\s*\n+/i,
    "",
  );

  // 5) 成对包裹引号（整体被一层引号包住时脱壳）
  s = s.trim();
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["「", "」"],
    ["“", "”"],
  ];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      const inner = s.slice(open.length, s.length - close.length).trim();
      // 内层不再含同种包裹符时才脱壳，避免把含引号的正文越扒越短
      if (!inner.includes(open) && !inner.includes(close)) {
        s = inner;
      }
      break;
    }
  }

  return s.trim();
}
