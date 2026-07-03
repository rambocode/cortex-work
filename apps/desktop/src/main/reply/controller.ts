// reply 会话编排器（U7）：把 helper 事件 → 捕获 → 对话重建 → prompt 组装 → 默认 agent 生成 →
// 候选气泡 → 写回 的全链路串起来，围绕 ReplySession 的世代 token 做并发裁决（R1-R7、R14）。
//
// 分工：纯状态机 / token / 捕获与输出判据在 controller-state.ts（可单测）；本文件只做副作用编排
// （spawn helper 命令、推气泡、kill 在途 CLI、写回），故不单测，靠 controller-state + 手测覆盖。
//
// 跨状态回调（AX/OCR/日历/CLI 输出）一律在返回后先 session.isCurrent(token) 校验：token 因重入/
// 取消递增即静默丢弃——这是 R7 并发安全的唯一裁决点。

import { ReplyHelperClient, type HelperEvent } from "./helper-client";
import {
  openReplyBubble,
  pushReplyBubbleState,
  closeReplyBubble,
  setReplyBubbleActionHandler,
} from "./bubble-window";
import {
  ReplySession,
  looksLikeConversation,
  shouldAbortWriteBack,
} from "./controller-state";
import {
  generateDraft,
  resolveReplyProviderId,
  EmptyDraftError,
} from "./draft-generator";
import { replyDebugLog } from "./debug-log";
import { buildReplyPrompt, type ReplyPrompt } from "@cortex-work/core/reply/prompt-builder";
import { ConversationLayoutBuilder } from "@cortex-work/core/reply/conversation-layout";
import type { OCRTextBlock } from "@cortex-work/core/reply/types";
import { availabilityContext } from "@cortex-work/core/reply/calendar-slots";
import { composeUserProfile, emptyMemoryState } from "@cortex-work/core/reply/memory";
import type {
  ReplyBubbleAction,
  ReplyBubbleErrorKind,
  ReplyBubbleState,
  ReplyDebugEntry,
  ReplyRect,
  ReplySyncSnapshot,
} from "../ipc/reply-types";

// ── OCR 对话重建的噪声表（移植源项目 ScreenTextReader 微信噪声 / 系统事件前缀）───────────────
// 输入框占位符 / 语音时长 / 系统事件气泡等在重建前剔除，避免污染「对方/我」分说话人。
const OCR_NOISE_MARKERS = ["输入文字", "按住Fn使用语音输入", "Type a message", "转文字"] as const;
const OCR_SYSTEM_EVENT_PREFIXES = [
  "已取消",
  "对方已取消",
  "已拒绝",
  "对方已拒绝",
  "未接听",
  "对方无应答",
  "通话时长",
  "位置共享",
  "你撤回了一条消息",
  "撤回了一条消息",
] as const;

/** 写回后回填延迟（源项目 150ms）：等被吞的回车事件结束再粘贴，避免焦点竞争。 */
const WRITE_BACK_DELAY_MS = 150;
/** 后台预生成翻牌候选条数（源项目常量）。 */
const PREGENERATE_COUNT = 2;

/** 一次捕获的归一化结果（AX 或 OCR 重建）。 */
interface CaptureResult {
  conversation: string;
  pid: number | null;
  frame: ReplyRect | null;
  appName: string;
  appBundleId: string;
  source: "ax" | "ocr";
  axText: string;
  ocrText: string;
}

/** 当前会话的已捕获上下文（供首条生成 / 预生成 / 翻牌 / 重试复用，不重复捕获）。 */
interface PendingContext {
  conversation: string;
  voiceIntent?: string;
  calendarContext: string;
  composedProfile: string;
  capture: CaptureResult;
}

/** 写回成功后回调 U10 学习管线的信息。 */
export interface DraftAcceptedInfo {
  draft: string;
  conversation: string;
  appName: string;
  appBundleId: string;
}

export interface ReplyControllerLogger {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
}

export interface ReplyControllerDeps {
  /** events + one-shot 的 helper 客户端（U4）。 */
  helper: ReplyHelperClient;
  /** 默认 agent / 记忆 / 触发键快照（renderer 经 reply:syncSettings 推送，main 侧缓存）。 */
  getSnapshot: () => ReplySyncSnapshot | null;
  /** 写回成功后的学习回调（U10 蒸馏接线；默认 no-op）。 */
  onDraftAccepted?: (info: DraftAcceptedInfo) => void;
  /** 「去设置」动作（agentNotConfigured 引导）：聚焦主窗口。 */
  onOpenSettings?: () => void;
  logger?: ReplyControllerLogger;
}

const NOOP_LOGGER: ReplyControllerLogger = { warn: () => {}, info: () => {} };

/** Promise 化延迟。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * reply 会话编排器。单例经 initReplyController 创建；helper 事件与气泡动作分发到本类方法。
 */
export class ReplyController {
  private readonly helper: ReplyHelperClient;
  private readonly getSnapshot: () => ReplySyncSnapshot | null;
  private readonly onDraftAccepted?: (info: DraftAcceptedInfo) => void;
  private readonly onOpenSettings?: () => void;
  private readonly log: ReplyControllerLogger;

  private readonly session = new ReplySession();
  // 当前在途生成的 abort（esc / 重入时 abort → kill 在途 CLI）。
  private abort: AbortController | null = null;
  // 当前会话已捕获的上下文（生成/翻牌/重试复用）。
  private pending: PendingContext | null = null;
  // 后台预生成是否仍在进行（驱动气泡圆点「逐个出现」动画）。
  private preGenActive = false;
  // 翻牌单飞：避免同一会话并发追加多条。
  private flipBusy = false;

  constructor(deps: ReplyControllerDeps) {
    this.helper = deps.helper;
    this.getSnapshot = deps.getSnapshot;
    this.onDraftAccepted = deps.onDraftAccepted;
    this.onOpenSettings = deps.onOpenSettings;
    this.log = deps.logger ?? NOOP_LOGGER;
  }

  // ── helper 事件入口 ───────────────────────────────────────────────────────────

  /** 分发一条 helper events 事件（draft-gesture / voice-start / voice-end / key-event）。 */
  handleEvent(event: HelperEvent): void {
    switch (event.event) {
      case "draft-gesture":
        void this.startDraftSession();
        break;
      case "voice-start":
        this.onVoiceStart();
        break;
      case "voice-end":
        this.onVoiceEnd();
        break;
      case "key-event":
        this.onKey(String((event as { key?: unknown }).key ?? ""));
        break;
      default:
        break;
    }
  }

  /** 分发气泡渲染端上行的鼠标动作。 */
  handleBubbleAction(action: ReplyBubbleAction): void {
    switch (action.type) {
      case "flip":
        void this.flip();
        break;
      case "retry":
        void this.retry();
        break;
      case "close":
        this.cancel();
        break;
      case "select":
        if (this.session.phase === "presenting") {
          this.session.setIndex(action.index);
          this.pushPresenting();
        }
        break;
      case "openSettings":
        this.onOpenSettings?.();
        break;
      default:
        break;
    }
  }

  // ── 键盘（helper 吞键转发）────────────────────────────────────────────────────

  /** 处理被吞的候选键（enter/escape/left/right/tab）。仅在相应阶段有意义。 */
  private onKey(key: string): void {
    switch (key) {
      case "left":
        if (this.session.phase === "presenting") {
          this.session.cycle(-1);
          this.pushPresenting();
        }
        break;
      case "right":
        if (this.session.phase === "presenting") {
          this.session.cycle(1);
          this.pushPresenting();
        }
        break;
      case "enter":
        void this.writeBack();
        break;
      case "escape":
        this.cancel();
        break;
      case "tab":
        void this.flip();
        break;
      default:
        break;
    }
  }

  // ── 起草主链路 ────────────────────────────────────────────────────────────────

  /**
   * 起草手势 / 兜底快捷键 / 语音意图入口。重入即取消旧会话（abort 在途 CLI + beginCapture 递增
   * token）后重捕获。voiceIntent 存在时作为「口述意图」注入 prompt。
   */
  async startDraftSession(voiceIntent?: string): Promise<void> {
    this.abortInFlight();
    const token = this.session.beginCapture();
    this.pending = null;
    this.flipBusy = false;
    // 吞键在会话全程开启：generating 期的 esc 也需被吞掉才能取消生成。
    this.helper.setIntercept(true);
    openReplyBubble(null);
    this.pushGenerating();

    const capture = await this.capture(token);
    if (!this.session.isCurrent(token)) return; // 重入/取消：本轮回调过期
    if (!capture) {
      // 捕获失败 / 权限缺失：不静默回 idle，推错误态引导（R2）。
      this.pushError("generationFailed", "未能读取当前窗口内容，请确认已授权辅助功能 / 屏幕录制。");
      return;
    }
    this.session.setCapturedPid(capture.pid);
    // 拿到焦点输入框 frame 后重锚定气泡（capture 前锚点为 null → 鼠标兜底）。
    openReplyBubble(capture.frame);

    const calendarContext = await this.calendarContext(token);
    if (!this.session.isCurrent(token)) return;

    const snapshot = this.getSnapshot();
    const composedProfile = composeUserProfile({
      userProfile: snapshot?.settings.userProfile,
      memory: snapshot?.memory ?? emptyMemoryState(),
      capturedApp: { bundleId: capture.appBundleId, name: capture.appName },
    });

    this.session.toGenerating();
    this.pending = {
      conversation: capture.conversation,
      voiceIntent,
      calendarContext,
      composedProfile,
      capture,
    };
    await this.generateFirst(token);
  }

  /** 捕获前台对话：AX「像对话」直接用，否则 OCR + U1 重建，两者都不像则回退 AX 文本。 */
  private async capture(token: number): Promise<CaptureResult | null> {
    let axRes: Record<string, unknown> | null = null;
    try {
      axRes = await this.helper.axCapture();
    } catch (err) {
      this.log.warn("[reply] ax-capture 失败", err);
    }
    if (!this.session.isCurrent(token)) return null;

    const pid = typeof axRes?.pid === "number" ? (axRes.pid as number) : null;
    const frame = parseRect(axRes?.focusedFrame);
    const appName = typeof axRes?.appName === "string" ? (axRes.appName as string) : "";
    const appBundleId = typeof axRes?.appBundleId === "string" ? (axRes.appBundleId as string) : "";
    const axText =
      axRes?.ok === true && typeof axRes.text === "string" ? (axRes.text as string) : "";

    // AX 文本「像对话」（helper 侧已算 meaningful）→ 直接采用
    if (axRes?.ok === true && axRes.meaningful === true) {
      return { conversation: axText, pid, frame, appName, appBundleId, source: "ax", axText, ocrText: "" };
    }

    // 降级 OCR：截屏 + Vision → U1 对话重建
    let ocrText = "";
    let ocrRes: Record<string, unknown> | null = null;
    try {
      ocrRes = await this.helper.ocr(pid ?? undefined);
    } catch (err) {
      this.log.warn("[reply] ocr 失败", err);
    }
    if (!this.session.isCurrent(token)) return null;

    if (ocrRes?.ok === true && Array.isArray(ocrRes.blocks)) {
      const blocks = parseOcrBlocks(ocrRes.blocks);
      const transcript = new ConversationLayoutBuilder({
        noiseMarkers: OCR_NOISE_MARKERS as unknown as string[],
        systemEventPrefixes: OCR_SYSTEM_EVENT_PREFIXES as unknown as string[],
      }).transcript(blocks);
      ocrText = transcript;
      if (looksLikeConversation(transcript)) {
        return { conversation: transcript, pid, frame, appName, appBundleId, source: "ocr", axText, ocrText };
      }
    }

    // AX 与 OCR 都不像对话：回退 AX 文本（有内容才用），否则彻底失败。
    if (axText.trim().length > 0) {
      return { conversation: axText, pid, frame, appName, appBundleId, source: "ax", axText, ocrText };
    }
    return null;
  }

  /** 读日历忙碌区间 → U1 计算空闲摘要（未授权 / 无空闲静默跳段）。 */
  private async calendarContext(token: number): Promise<string> {
    let res: Record<string, unknown> | null = null;
    try {
      res = await this.helper.calendar();
    } catch {
      return "";
    }
    if (!this.session.isCurrent(token)) return "";
    if (res?.ok !== true || !Array.isArray(res.busy)) return "";
    const windowStart = Date.parse(String(res.windowStart));
    const windowEnd = Date.parse(String(res.windowEnd));
    if (Number.isNaN(windowStart) || Number.isNaN(windowEnd)) return "";
    const busy = (res.busy as unknown[])
      .map((b) => {
        const rec = b as Record<string, unknown>;
        return {
          start: Date.parse(String(rec.start)),
          end: Date.parse(String(rec.end)),
          title: typeof rec.title === "string" ? rec.title : "Busy",
        };
      })
      .filter((e) => !Number.isNaN(e.start) && !Number.isNaN(e.end));
    return availabilityContext({ start: windowStart, end: windowEnd }, busy);
  }

  // ── 生成 ──────────────────────────────────────────────────────────────────────

  /** 首条候选：默认 agent 单发 → presenting → 后台预生成 2 条避重候选。 */
  private async generateFirst(token: number): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const snapshot = this.getSnapshot();
    const providerId = resolveReplyProviderId(snapshot);
    if (!providerId) {
      // 默认 agent 未配置：推错误态引导去设置（不静默回 idle）。
      this.pushError("agentNotConfigured");
      return;
    }
    const prompt = this.buildPrompt(pending, []);
    this.abort = new AbortController();
    try {
      const text = await generateDraft(
        { prompt, providerId, model: snapshot?.model, signal: this.abort.signal },
      );
      if (!this.session.isCurrent(token)) return;
      this.recordDebug(pending, prompt, text, null);
      this.session.presentFirst(text);
      this.preGenActive = true;
      this.pushPresenting();
      void this.pregenerate(token, providerId, snapshot?.model);
    } catch (err) {
      if (!this.session.isCurrent(token)) return; // 过期（重入 / esc）静默丢弃
      const message = err instanceof Error ? err.message : String(err);
      this.recordDebug(pending, prompt, "", message);
      if (err instanceof EmptyDraftError) this.pushError("emptyCandidates");
      else this.pushError("generationFailed", message);
    }
  }

  /** 后台串行预生成翻牌候选（每条避开已有全部候选）；过期 / 非展示态 / 失败即停。 */
  private async pregenerate(token: number, providerId: string, model?: string): Promise<void> {
    for (let i = 0; i < PREGENERATE_COUNT; i += 1) {
      if (!this.session.isCurrent(token) || this.session.phase !== "presenting") break;
      const pending = this.pending;
      if (!pending) break;
      const prompt = this.buildPrompt(pending, this.session.avoidList());
      try {
        const text = await generateDraft(
          { prompt, providerId, model, signal: this.abort?.signal },
        );
        if (!this.session.isCurrent(token)) return;
        this.recordDebug(pending, prompt, text, null);
        this.session.appendPreGenerated(text);
        this.pushPresenting();
      } catch (err) {
        if (this.session.isCurrent(token)) {
          const message = err instanceof Error ? err.message : String(err);
          this.recordDebug(pending, prompt, "", message);
        }
        break; // 预生成失败静默放弃，不打扰主流程
      }
    }
    this.preGenActive = false;
    if (this.session.isCurrent(token) && this.session.phase === "presenting") this.pushPresenting();
  }

  /** 「翻牌」：追加一条避开已有候选的新草稿并聚焦；会话捕获为空则退化为重新起草。 */
  private async flip(): Promise<void> {
    if (this.session.phase !== "presenting") return;
    const pending = this.pending;
    if (!pending) return;
    if (pending.conversation.trim().length === 0) {
      void this.startDraftSession();
      return;
    }
    if (this.flipBusy) return;
    this.flipBusy = true;
    const token = this.session.token;
    const snapshot = this.getSnapshot();
    const providerId = resolveReplyProviderId(snapshot);
    if (!providerId) {
      this.flipBusy = false;
      this.pushError("agentNotConfigured");
      return;
    }
    const prompt = this.buildPrompt(pending, this.session.avoidList());
    try {
      const text = await generateDraft(
        { prompt, providerId, model: snapshot?.model, signal: this.abort?.signal },
      );
      if (!this.session.isCurrent(token)) return;
      this.recordDebug(pending, prompt, text, null);
      this.session.appendFlip(text);
      this.pushPresenting();
    } catch (err) {
      if (this.session.isCurrent(token)) {
        const message = err instanceof Error ? err.message : String(err);
        this.recordDebug(pending, prompt, "", message);
      }
    } finally {
      this.flipBusy = false;
    }
  }

  /**
   * 错误态重试：已捕获上下文存在（生成失败 / 空候选 / 未配置 agent）→ 复用上下文重生成，不重捕获；
   * 捕获失败态无上下文 → 整轮重来（重新捕获）。
   */
  private async retry(): Promise<void> {
    if (this.session.phase === "idle") return;
    if (!this.pending) {
      await this.startDraftSession();
      return;
    }
    await this.generateFirst(this.session.token);
  }

  private buildPrompt(pending: PendingContext, avoidReplies: string[]): ReplyPrompt {
    return buildReplyPrompt({
      conversation: pending.conversation,
      voiceIntent: pending.voiceIntent,
      calendarContext: pending.calendarContext,
      userProfile: pending.composedProfile,
      avoidReplies,
    });
  }

  // ── 写回 ──────────────────────────────────────────────────────────────────────

  /** ↩ 写回：关气泡 + 关吞键 → 延迟 → pid 校验（变则中止）→ ax-activate + paste → 学习回调。 */
  private async writeBack(): Promise<void> {
    if (this.session.phase !== "presenting") return;
    const draft = this.session.currentDraft;
    if (draft.trim().length === 0) return;
    const capturedPid = this.session.capturedPid;
    const pending = this.pending;

    this.session.toWriting();
    closeReplyBubble();
    this.helper.setIntercept(false);
    await delay(WRITE_BACK_DELAY_MS);

    // pid 校验（R6）：目标 app 变更则中止，绝不盲粘。
    const currentPid = await this.frontmostPid();
    if (shouldAbortWriteBack(capturedPid, currentPid)) {
      this.log.warn("[reply] 目标应用已变更，中止写回", { capturedPid, currentPid });
      this.session.reset();
      this.pending = null;
      return;
    }

    try {
      if (capturedPid != null) await this.helper.axActivate(capturedPid);
      await this.helper.paste(draft);
    } catch (err) {
      this.log.warn("[reply] 写回失败", err);
      this.session.reset();
      this.pending = null;
      return;
    }

    // 写回成功 → 触发学习管线（U10；未接线时为 no-op）。
    if (pending) {
      this.onDraftAccepted?.({
        draft,
        conversation: pending.conversation,
        appName: pending.capture.appName,
        appBundleId: pending.capture.appBundleId,
      });
    }
    this.session.reset();
    this.pending = null;
  }

  /** 探测当前前台应用 pid（写回 pid 校验用）。ax-capture 只读、不激活，不改变前台。 */
  private async frontmostPid(): Promise<number | null> {
    try {
      const res = await this.helper.axCapture();
      return typeof res.pid === "number" ? (res.pid as number) : null;
    } catch {
      return null;
    }
  }

  // ── 语音（U8 在此基础上接转写）────────────────────────────────────────────────

  /** voice-start：进入 recording，弹「聆听中」气泡（转写在渲染端由 U8 驱动）。 */
  private onVoiceStart(): void {
    this.abortInFlight();
    this.session.beginRecording();
    this.helper.setIntercept(true);
    openReplyBubble(null);
    this.pushRecording();
  }

  /**
   * voice-end：录音停止与转写在气泡渲染端（U8），转写文本经 submitVoiceIntent 回来触发起草。
   * U7 侧保持 recording 态等待，不在此转 idle（避免抢在 U8 转写前提前收尾）。
   */
  private onVoiceEnd(): void {
    // 由 U8 接线：voice-end → 渲染端停止 MediaRecorder → 转写 → submitVoiceIntent。
  }

  /** 语音转写结果回填（U8 调用）：非空作为口述意图起草，空则提示后回 idle。 */
  submitVoiceIntent(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      this.cancel();
      return;
    }
    void this.startDraftSession(trimmed);
  }

  // ── 收尾 / 取消 ───────────────────────────────────────────────────────────────

  /** esc / 关闭：abort 在途 CLI、回 idle、关吞键、关气泡。 */
  cancel(): void {
    this.abortInFlight();
    this.session.reset();
    this.helper.setIntercept(false);
    closeReplyBubble();
    this.pending = null;
    this.preGenActive = false;
    this.flipBusy = false;
  }

  /** abort 当前在途生成（kill 在途 CLI）。 */
  private abortInFlight(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** 释放：取消会话、解绑气泡动作处理器。 */
  dispose(): void {
    this.cancel();
  }

  // ── 气泡状态推送 ──────────────────────────────────────────────────────────────

  private pushGenerating(): void {
    this.push({ phase: "generating", candidates: [], currentIndex: 0, preGenerating: true });
  }

  private pushRecording(): void {
    this.push({ phase: "recording", candidates: [], currentIndex: 0 });
  }

  private pushPresenting(): void {
    this.push({
      phase: "presenting",
      candidates: [...this.session.candidates],
      currentIndex: this.session.currentIndex,
      preGenerating: this.preGenActive,
    });
  }

  private pushError(errorKind: ReplyBubbleErrorKind, errorDetail?: string): void {
    this.push({
      phase: "error",
      candidates: [...this.session.candidates],
      currentIndex: this.session.currentIndex,
      errorKind,
      errorDetail,
    });
  }

  private push(state: ReplyBubbleState): void {
    pushReplyBubbleState(state);
  }

  // ── 调试记录 ──────────────────────────────────────────────────────────────────

  private recordDebug(
    pending: PendingContext,
    prompt: ReplyPrompt,
    output: string,
    error: string | null,
  ): void {
    const entry: ReplyDebugEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      source: pending.capture.source,
      axText: pending.capture.axText || undefined,
      ocrText: pending.capture.ocrText || undefined,
      systemPrompt: prompt.system,
      userPrompt: prompt.user,
      output: output || undefined,
      error: error ?? undefined,
    };
    replyDebugLog.add(entry);
  }
}

// ── 数值解析辅助 ──────────────────────────────────────────────────────────────

/** 把 helper 输出的 focusedFrame（可能为 null）解析为 ReplyRect；缺字段返回 null。 */
function parseRect(value: unknown): ReplyRect | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number"
  ) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  return null;
}

/** 把 helper 输出的 OCR blocks 解析为 U1 的 OCRTextBlock[]（脏项丢弃）。 */
function parseOcrBlocks(raw: unknown[]): OCRTextBlock[] {
  const out: OCRTextBlock[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === "string" ? rec.text : "";
    const box = rec.boundingBox as Record<string, unknown> | undefined;
    if (!text || !box) continue;
    if (
      typeof box.x === "number" &&
      typeof box.y === "number" &&
      typeof box.width === "number" &&
      typeof box.height === "number"
    ) {
      out.push({ text, boundingBox: { x: box.x, y: box.y, width: box.width, height: box.height } });
    }
  }
  return out;
}

// ── 模块单例 + 接线 ──────────────────────────────────────────────────────────────

let controller: ReplyController | null = null;

/** 创建 reply 编排器单例并接管气泡动作分发（index.ts 在 mac 平台调用）。 */
export function initReplyController(deps: ReplyControllerDeps): ReplyController {
  controller = new ReplyController(deps);
  setReplyBubbleActionHandler((action) => controller?.handleBubbleAction(action));
  return controller;
}

/** 当前 reply 编排器单例（helper.onEvent / IPC triggerDraft 惰性取用）。 */
export function getReplyController(): ReplyController | null {
  return controller;
}

/** 手动触发起草（兜底 accelerator / IPC reply:triggerDraft 调用）。 */
export function triggerReplyDraft(): void {
  void controller?.startDraftSession();
}

/** 读调试记录（IPC reply:getDebugLog 调用）——环形缓冲仅内存。 */
export function getReplyDebugEntries(): ReplyDebugEntry[] {
  return replyDebugLog.list();
}

/** 释放单例（应用退出时调用）。 */
export function disposeReplyController(): void {
  controller?.dispose();
  controller = null;
  setReplyBubbleActionHandler(null);
}
