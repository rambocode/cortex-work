// reply 会话编排器（U7）：把 helper 事件 → 捕获 → 对话重建 → prompt 组装 → 模型直连生成 →
// 候选气泡 → 写回 的全链路串起来，围绕 ReplySession 的世代 token 做并发裁决（R1-R7、R14）。
//
// 分工：纯状态机 / token / 捕获与输出判据在 controller-state.ts（可单测）；本文件只做副作用编排
// （spawn helper 命令、推气泡、abort 在途生成请求、写回），故不单测，靠 controller-state + 手测覆盖。
//
// 跨状态回调（AX/OCR/日历/生成输出）一律在返回后先 session.isCurrent(token) 校验：token 因重入/
// 取消递增即静默丢弃——这是 R7 并发安全的唯一裁决点。

import { ReplyHelperClient, type HelperEvent } from "./helper-client";
import {
  openReplyBubble,
  pushReplyBubbleState,
  closeReplyBubble,
  setReplyBubbleActionHandler,
  setReplyBubbleVoiceResultHandler,
  sendReplyBubbleVoice,
} from "./bubble-window";
import { decideVoiceIntent, VOICE_PROMPT_DISMISS_MS } from "./voice-intent";
import {
  ReplySession,
  looksLikeConversation,
  shouldAbortWriteBack,
  selectReplyAnchorFrame,
  type ReplyCandidate,
} from "./controller-state";
import {
  generateDraft,
  generateDraftStream,
  EmptyDraftError,
  REPLY_TEMPERATURES,
  type StancedDraft,
} from "./draft-generator";
import type { ReplyStance } from "@cortex-work/core/reply/stance";
import type { ResolvedReplyModel } from "./resolve-model";
import { replyDebugLog } from "./debug-log";
import { buildReplyPrompt, type ReplyPrompt } from "@cortex-work/core/reply/prompt-builder";
import { ConversationLayoutBuilder } from "@cortex-work/core/reply/conversation-layout";
import {
  filterOcrBlocksForVisibleConversation,
  shouldPreferOcrForVisibleConversation,
} from "@cortex-work/core/reply/ocr-conversation-region";
import type { OCRTextBlock } from "@cortex-work/core/reply/types";
import { availabilityContext } from "@cortex-work/core/reply/calendar-slots";
import { composeUserProfile, emptyMemoryState, type MemoryState } from "@cortex-work/core/reply/memory";
import type {
  ReplyBubbleAction,
  ReplyBubbleErrorKind,
  ReplyBubbleState,
  ReplyBubbleVoiceResult,
  ReplyDebugEntry,
  ReplyRect,
  ReplySyncSnapshot,
} from "../ipc/reply-types";
import type { AsrSettings } from "../ipc/types";

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
/** 非决策场景的后台预生成翻牌候选条数（源项目常量）。 */
const PREGENERATE_COUNT = 2;
/**
 * 决策点场景的定向立场预生成序（首条推荐回复解析出立场 ⇒ 后台按此固定序各生成一条带 chip 候选）。
 * 固定序保证圆点顺序稳定可预期；多样性由立场定向保证，故温度用低温 first 求表达质量。
 */
const STANCE_PREGENERATE_ORDER: readonly ReplyStance[] = ["agree", "reject", "unsure"];

/** 一次捕获的归一化结果（AX 或 OCR 重建）。 */
interface CaptureResult {
  conversation: string;
  pid: number | null;
  frame: ReplyRect | null;
  /** 光标插入点矩形（输入法候选窗同款锚点,AXBoundsForRange）：比元素 frame 更精确,优先用于气泡锚定。 */
  caretFrame: ReplyRect | null;
  /** helper 在 AX 树中推断的输入首行锚点；微信等拿不到光标时优先于 focusedFrame。 */
  inputAnchorFrame: ReplyRect | null;
  /** 焦点窗口 frame；输入框 frame 缺失时气泡兜底锚定到窗口底部（微信等 AX 不完整场景）。 */
  windowFrame: ReplyRect | null;
  appName: string;
  appBundleId: string;
  /** 对方身份（窗口标题解析，如「张玲玲-财务」）；无则空串，prompt 退回泛化「对方」。 */
  counterpart: string;
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
  /** 对话级记忆段（唤起时按 app+counterpart 读一次，一轮内恒定——前缀缓存安全）。 */
  conversationMemory: string;
  capture: CaptureResult;
}

/** 写回成功后回调下游消费者（U10 学习管线 / 历史落盘 / 对话记忆）的信息。 */
export interface DraftAcceptedInfo {
  draft: string;
  conversation: string;
  appName: string;
  appBundleId: string;
  /** 对方身份（窗口标题解析；IM 常为空串）——对话级记忆按 app+counterpart 分桶。 */
  counterpart: string;
  /** 当轮全部候选草稿快照（含翻牌追加的），历史存档用。 */
  candidates: { text: string; stance: ReplyStance | null }[];
  /** 被采纳候选在 candidates 中的下标。 */
  acceptedIndex: number;
}

export interface ReplyControllerLogger {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
}

export interface ReplyControllerDeps {
  /** events + one-shot 的 helper 客户端（U4）。 */
  helper: ReplyHelperClient;
  /** 设置 / 记忆 / 触发键快照（renderer 经 reply:syncSettings 推送，main 侧缓存），供 prompt 组装用。 */
  getSnapshot: () => ReplySyncSnapshot | null;
  /**
   * 解析当前 reply 生成模型（KTD3）：每次唤起时现解析（读最新 reply 设置 + 持久化 providerSettings），
   * 设置变更即时生效；null → 未配置生成模型，推「modelNotConfigured」气泡引导去设置（不回退 agent CLI）。
   */
  resolveModel: () => Promise<ResolvedReplyModel | null>;
  /**
   * 读当前 ASR 配置（U8 语音意图转写用；从持久化态异步读取）。返回 null / 未提供 → 语音不可用，
   * onVoiceStart 直接提示。与 getSnapshot 分开注入：ASR 属独立设置分片，避免塞进 reply 快照。
   */
  getAsrSettings?: () => Promise<AsrSettings | null>;
  /** 写回成功后的学习回调（U10 蒸馏接线；默认 no-op）。 */
  onDraftAccepted?: (info: DraftAcceptedInfo) => void;
  /**
   * 读对话级记忆的注入段（conversation-store.getComposed；未接线 / 无记录 → 空串跳段）。
   * 每次唤起按捕获到的 app+counterpart 现读，保证设置页清空后即时生效。
   */
  getConversationMemory?: (appBundleId: string, counterpart: string) => Promise<string>;
  /**
   * 读全局分区记忆（KTD6 修订：main-owned memory-store，快照不再携带 memory）。
   * 未接线 / 读失败 → 空记忆降级（prompt 只少记忆段，不阻断起草）。
   */
  getMemoryState?: () => Promise<MemoryState>;
  /** 「去设置」动作（modelNotConfigured 引导）：聚焦主窗口。 */
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
  private readonly resolveModel: () => Promise<ResolvedReplyModel | null>;
  private readonly getAsrSettings?: () => Promise<AsrSettings | null>;
  private readonly onDraftAccepted?: (info: DraftAcceptedInfo) => void;
  private readonly getConversationMemory?: (appBundleId: string, counterpart: string) => Promise<string>;
  private readonly getMemoryState?: () => Promise<MemoryState>;
  private readonly onOpenSettings?: () => void;
  private readonly log: ReplyControllerLogger;

  private readonly session = new ReplySession();
  // 当前在途生成的 abort（esc / 重入时 abort → 中止在途直连请求）。
  private abort: AbortController | null = null;
  // 当前会话已捕获的上下文（生成/翻牌/重试复用）。
  private pending: PendingContext | null = null;
  // 后台预生成是否仍在进行（驱动气泡圆点「逐个出现」动画）。
  private preGenActive = false;
  // 翻牌单飞：避免同一会话并发追加多条。
  private flipBusy = false;
  // 首条正在流式输出：期间正文是中间态，↩ 写回与翻牌被门控（避免粘贴半截草稿 / 避重列表含半截文本）。
  private firstStreaming = false;
  // 语音录音是否已真正在气泡端启动（ASR 缺失时不录音，voice-end 松开应被忽略）。
  private voiceActive = false;
  // 语音「启动窗口内到达的松开」标记（与录音会话 token 绑定）：onVoiceStart 在 await getAsrSettings
  // 期间 voiceActive 仍为 false，此窗口内到达的 voice-end 无法立即停麦，先在此登记其 token；
  // onVoiceStart await 返回后据此判定「快按快松」，不启动录音，干净回到非录音态（修复麦克风常开竞态）。
  private voicePendingStopToken: number | null = null;

  constructor(deps: ReplyControllerDeps) {
    this.helper = deps.helper;
    this.getSnapshot = deps.getSnapshot;
    this.resolveModel = deps.resolveModel;
    this.getAsrSettings = deps.getAsrSettings;
    this.onDraftAccepted = deps.onDraftAccepted;
    this.getConversationMemory = deps.getConversationMemory;
    this.getMemoryState = deps.getMemoryState;
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
        void this.onVoiceStart();
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
   * 起草手势 / 兜底快捷键 / 语音意图入口。重入即取消旧会话（abort 在途请求 + beginCapture 递增
   * token）后重捕获。voiceIntent 存在时作为「口述意图」注入 prompt。
   */
  async startDraftSession(voiceIntent?: string): Promise<void> {
    this.abortInFlight();
    const token = this.session.beginCapture();
    this.pending = null;
    this.flipBusy = false;
    this.firstStreaming = false;
    // 吞键在会话全程开启：generating 期的 esc 也需被吞掉才能取消生成。
    this.helper.setIntercept(true);
    // 定位好再显示（deferShow）：捕获期间不显示气泡——否则会先按鼠标兜底位闪现、
    // 捕获完成后再跳到光标处（用户观察到的定位漂移）。语音「聆听中」除外（无锚可等,即时反馈优先）。
    openReplyBubble(null, null, { deferShow: true });
    this.pushGenerating();

    // 日历查询与捕获并行：两者互不依赖，且 one-shot 命令各自独立 spawn helper 进程；
    // 串行会让首条候选白等 EventKit（可达数百 ms）。await 挪到捕获成功之后。
    const startedAt = Date.now();
    const calendarPromise = this.calendarContext(token);
    const capture = await this.capture(token);
    const captureMs = Date.now() - startedAt;
    if (!this.session.isCurrent(token)) return; // 重入/取消：本轮回调过期
    if (!capture) {
      // 捕获失败 / 权限缺失：不静默回 idle，推错误态引导（R2）。
      // 无锚可用——放行显示门控,错误气泡按鼠标兜底位显示（否则错误态永远不可见）。
      openReplyBubble(null);
      this.pushError("generationFailed", "未能读取当前窗口内容，请确认已授权辅助功能 / 屏幕录制。");
      return;
    }
    this.session.setCapturedPid(capture.pid);
    // 拿到焦点输入框 frame 后重锚定气泡；输入框 frame 缺失（微信等 AX 不完整）时用窗口 frame 兜底锚定
    // 到窗口底部输入区，仍取不到才回落鼠标位置。
    // 锚点链:光标插入点(输入法式,最精确)→ helper 推断输入首行 → 焦点输入框 frame → 窗口 frame。
    openReplyBubble(
      selectReplyAnchorFrame({
        caretFrame: capture.caretFrame,
        inputAnchorFrame: capture.inputAnchorFrame,
        focusedFrame: capture.frame,
      }),
      capture.windowFrame,
    );

    const calendarContext = await calendarPromise;
    if (!this.session.isCurrent(token)) return;
    // 分段耗时（诊断「响应慢」用）：capture 含 AX + 可能的 OCR 降级；calendarWait 是并行后的净等待。
    this.log.info("[reply] 起草前置耗时", {
      captureMs,
      calendarWaitMs: Date.now() - startedAt - captureMs,
      source: capture.source,
    });

    const snapshot = this.getSnapshot();
    // 全局分区记忆：KTD6 修订后由 main-owned memory-store 现读（快照不携带 memory）。
    // 读失败降级空记忆——prompt 只少记忆段，不阻断起草。
    let memoryState = emptyMemoryState();
    if (this.getMemoryState) {
      try {
        memoryState = await this.getMemoryState();
      } catch (err) {
        this.log.warn("[reply] 读分区记忆失败，按空记忆组装", err);
      }
      if (!this.session.isCurrent(token)) return; // 读盘期间重入/取消：本轮过期
    }
    const composedProfile = composeUserProfile({
      userProfile: snapshot?.settings.userProfile,
      memory: memoryState,
      capturedApp: { bundleId: capture.appBundleId, name: capture.appName },
    });

    // 对话级记忆：按捕获到的 app+counterpart 读注入段（本地文件读，毫秒级；失败不阻断起草）。
    let conversationMemory = "";
    if (this.getConversationMemory) {
      try {
        conversationMemory = await this.getConversationMemory(capture.appBundleId, capture.counterpart);
      } catch (err) {
        this.log.warn("[reply] 读对话记忆失败，跳过注入", err);
      }
      if (!this.session.isCurrent(token)) return; // 读盘期间重入/取消：本轮过期
    }

    this.session.toGenerating();
    this.pending = {
      conversation: capture.conversation,
      voiceIntent,
      calendarContext,
      composedProfile,
      conversationMemory,
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
    // 光标矩形与焦点元素 frame 独立解析:AX 文本不像对话走 OCR 时,光标锚点依旧有效。
    const caretFrame = parseRect(axRes?.caretFrame);
    // Swift helper 主动扫描 AX 树推断的输入首行锚点:微信拿不到 caret/focusedFrame 时仍可贴输入框。
    const inputAnchorFrame = parseRect(axRes?.inputAnchorFrame);
    // 可变:AX 取不到窗口 frame 时,后面用 OCR 返回的被截窗口 bounds 兜底(坐标系一致,左上原点 point)。
    let windowFrame = parseRect(axRes?.windowFrame);
    const appName = typeof axRes?.appName === "string" ? (axRes.appName as string) : "";
    const appBundleId = typeof axRes?.appBundleId === "string" ? (axRes.appBundleId as string) : "";
    const axText =
      axRes?.ok === true && typeof axRes.text === "string" ? (axRes.text as string) : "";
    // 对方身份：窗口标题去空白后，仅当非空且与应用名不同才采用——IM 会话窗标题即联系人名
    // （如「张玲玲-财务」），但若标题就是应用名（如「微信」）则无区分度，视为无对方名。
    const rawTitle = typeof axRes?.windowTitle === "string" ? (axRes.windowTitle as string).trim() : "";
    const counterpart = rawTitle.length > 0 && rawTitle !== appName.trim() ? rawTitle : "";
    const preferOcr = shouldPreferOcrForVisibleConversation({ bundleId: appBundleId, name: appName });

    // AX 文本「像对话」（helper 侧已算 meaningful）→ 直接采用
    // 企业微信/钉钉/飞书等多栏 IM 的 AX 可能返回整窗文本（含左侧会话列表），因此必须走 OCR
    // 当前对话区裁剪，避免把未打开的会话写进 Visible conversation。
    if (!preferOcr && axRes?.ok === true && axRes.meaningful === true) {
      return { conversation: axText, pid, frame, caretFrame, inputAnchorFrame, windowFrame, appName, appBundleId, counterpart, source: "ax", axText, ocrText: "" };
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

    // AX 连窗口 frame 都拿不到（微信常见）→ 用 OCR 被截窗口的 bounds 兜底,
    // 让气泡仍能贴着目标会话窗口锚定,而不是退化到鼠标位置(用户反馈「离输入框偏移很大」)。
    if (!windowFrame) windowFrame = parseRect(ocrRes?.windowBounds);

    if (ocrRes?.ok === true && Array.isArray(ocrRes.blocks)) {
      const blocks = filterOcrBlocksForVisibleConversation(parseOcrBlocks(ocrRes.blocks), {
        bundleId: appBundleId,
        name: appName,
      });
      const transcript = new ConversationLayoutBuilder({
        noiseMarkers: OCR_NOISE_MARKERS as unknown as string[],
        systemEventPrefixes: OCR_SYSTEM_EVENT_PREFIXES as unknown as string[],
      }).transcript(blocks);
      ocrText = transcript;
      if (looksLikeConversation(transcript)) {
        return { conversation: transcript, pid, frame, caretFrame, inputAnchorFrame, windowFrame, appName, appBundleId, counterpart, source: "ocr", axText, ocrText };
      }
    }

    // AX 与 OCR 都不像对话：回退 AX 文本（有内容才用），否则彻底失败。
    if (!preferOcr && axText.trim().length > 0) {
      return { conversation: axText, pid, frame, caretFrame, inputAnchorFrame, windowFrame, appName, appBundleId, counterpart, source: "ax", axText, ocrText };
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

  /**
   * 首条候选：现解析生成模型 → 直连**流式**生成（首条温度 0.3）——有增量就先上屏
   * （presentFirst 部分文本 + 持续 updateFirstText），流结束后用最终清洗文本替换，
   * 再并发预生成翻牌候选。流式期间 firstStreaming 置位，写回/翻牌被门控（见各自入口）。
   */
  private async generateFirst(token: number): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    // 每次唤起现解析模型（读最新 reply 设置 + providerSettings）：设置变更即时生效。
    // resolveModel 读持久化态理论上可抛（迁移/读盘异常）；不保护会让气泡永久卡 generating 转圈。
    let target: Awaited<ReturnType<typeof this.resolveModel>>;
    try {
      target = await this.resolveModel();
    } catch (err) {
      if (!this.session.isCurrent(token)) return;
      this.pushError("generationFailed", err instanceof Error ? err.message : String(err));
      return;
    }
    if (!this.session.isCurrent(token)) return; // 解析期间重入 / 取消：本轮过期
    if (!target) {
      // 未配置生成模型：推错误态引导去设置（不静默回 idle，不回退 agent CLI）。
      this.pushError("modelNotConfigured");
      return;
    }
    const prompt = this.buildPrompt(pending, []);
    this.abort = new AbortController();
    const generateStartedAt = Date.now();
    let firstTokenMs: number | null = null;
    let presented = false;
    try {
      const draft = await generateDraftStream(
        {
          prompt,
          target,
          temperature: REPLY_TEMPERATURES.first,
          signal: this.abort.signal,
        },
        (partialText) => {
          // 流式增量上屏：首个可外显片段即 presentFirst（气泡从「生成中」切候选卡），
          // 后续增量持续覆盖首条正文。过期回调（重入/esc）静默丢弃。
          if (!this.session.isCurrent(token)) return;
          if (firstTokenMs == null) firstTokenMs = Date.now() - generateStartedAt;
          if (!presented) {
            presented = true;
            this.firstStreaming = true;
            this.session.presentFirst(partialText);
          } else {
            this.session.updateFirstText(partialText);
          }
          this.pushPresenting();
        },
      );
      this.firstStreaming = false;
      if (!this.session.isCurrent(token)) return;
      // 首条 LLM 直连耗时（诊断「响应慢」用）：首 token 是体感关键，总时长慢时先查供应商/模型。
      this.log.info("[reply] 首条生成耗时", {
        firstTokenMs,
        llmMs: Date.now() - generateStartedAt,
        model: target.model,
      });
      this.recordDebug(pending, prompt, debugDraftText(draft), null);
      // 首条是推荐回复，气泡恒不显示立场 chip；解析出的立场只用于编排决策：
      // 非 null ⇒ 对方最新消息是决策点 ⇒ 后台改为定向生成三档立场候选。
      // 流结束后用最终清洗文本替换流式中间态（未流出任何增量时走 presentFirst 兜底）。
      if (presented) this.session.updateFirstText(draft.text);
      else this.session.presentFirst(draft.text);
      this.preGenActive = true;
      this.pushPresenting();
      void this.pregenerate(token, target, draft.stance);
    } catch (err) {
      this.firstStreaming = false;
      if (!this.session.isCurrent(token)) return; // 过期（重入 / esc）静默丢弃
      const message = err instanceof Error ? err.message : String(err);
      this.recordDebug(pending, prompt, "", message);
      if (err instanceof EmptyDraftError) this.pushError("emptyCandidates");
      else this.pushError("generationFailed", message);
    }
  }

  /**
   * 后台**并发**预生成翻牌候选：全部请求同时发起，谁先生成完谁先入列上屏
   * （串行版让第 3、4 张卡白等前一条完成，用户反馈等待过久）。两种模式：
   *   - 决策点（decisionStance 非 null）：定向生成 同意/拒绝/不确定 三档候选（带 chip），
   *     多样性由立场定向保证，温度用低温 first 求表达质量；候选立场以请求方指定为准，不信模型回显。
   *   - 非决策：2 条高温（variant 0.9）换角度变体，无 chip。
   * 并发的取舍：avoidReplies 只含发起时已有候选（首条），失去串行的链式避重——
   * 决策点模式立场天然互斥不受影响；非决策模式靠高温 + 入列按正文去重兜底。
   * 单条失败静默丢弃（不打扰主流程），其余请求照常。
   */
  private async pregenerate(
    token: number,
    target: ResolvedReplyModel,
    decisionStance: ReplyStance | null,
  ): Promise<void> {
    const stances: readonly (ReplyStance | null)[] =
      decisionStance != null
        ? STANCE_PREGENERATE_ORDER
        : Array.from({ length: PREGENERATE_COUNT }, () => null);
    const pending = this.pending;
    if (pending && this.session.isCurrent(token) && this.session.phase === "presenting") {
      const avoid = this.session.avoidList();
      await Promise.all(
        stances.map(async (stance) => {
          const prompt = this.buildPrompt(pending, avoid, stance);
          try {
            const draft = await generateDraft({
              prompt,
              target,
              temperature: stance != null ? REPLY_TEMPERATURES.first : REPLY_TEMPERATURES.variant,
              signal: this.abort?.signal,
            });
            if (!this.session.isCurrent(token)) return;
            const candidate: ReplyCandidate = { text: draft.text, stance };
            this.recordDebug(pending, prompt, debugDraftText(candidate), null);
            // 仅真正入列（presenting 且非重复）才推状态：写回/取消后到达的旧回调若无条件推
            // presenting,会把已关闭的气泡复活（appendPreGenerated 在非 presenting 阶段拒收）。
            if (this.session.appendPreGenerated(candidate)) this.pushPresenting();
          } catch (err) {
            if (this.session.isCurrent(token)) {
              const message = err instanceof Error ? err.message : String(err);
              this.recordDebug(pending, prompt, "", message);
            }
          }
        }),
      );
    }
    this.preGenActive = false;
    if (this.session.isCurrent(token) && this.session.phase === "presenting") this.pushPresenting();
  }

  /** 「翻牌」：追加一条避开已有候选的新草稿并聚焦；会话捕获为空则退化为重新起草。 */
  private async flip(): Promise<void> {
    if (this.session.phase !== "presenting") return;
    if (this.firstStreaming) return; // 首条流式中：正文是中间态，避重列表不可用，忽略翻牌
    const pending = this.pending;
    if (!pending) return;
    if (pending.conversation.trim().length === 0) {
      void this.startDraftSession();
      return;
    }
    if (this.flipBusy) return;
    this.flipBusy = true;
    const token = this.session.token;
    // 与 generateFirst 同理：resolveModel 抛错须复位 flipBusy 并给出错误态，避免翻牌永久失效。
    let target: Awaited<ReturnType<typeof this.resolveModel>>;
    try {
      target = await this.resolveModel();
    } catch (err) {
      this.flipBusy = false;
      if (!this.session.isCurrent(token)) return;
      this.pushError("generationFailed", err instanceof Error ? err.message : String(err));
      return;
    }
    if (!this.session.isCurrent(token)) {
      this.flipBusy = false;
      return; // 解析期间重入 / 取消：本轮过期
    }
    if (!target) {
      this.flipBusy = false;
      this.pushError("modelNotConfigured");
      return;
    }
    // 翻牌定向跟随当前展示候选的立场：在「拒绝」卡上翻牌 = 换个说法的拒绝（chip 延续）；
    // 当前卡无立场（首条推荐 / 普通变体）则维持既有换角度语义（无定向、无 chip）。
    const stance = this.session.currentStance;
    const prompt = this.buildPrompt(pending, this.session.avoidList(), stance);
    try {
      const draft = await generateDraft({
        prompt,
        target,
        temperature: stance != null ? REPLY_TEMPERATURES.first : REPLY_TEMPERATURES.variant,
        signal: this.abort?.signal,
      });
      if (!this.session.isCurrent(token)) return;
      const candidate: ReplyCandidate = { text: draft.text, stance };
      this.recordDebug(pending, prompt, debugDraftText(candidate), null);
      // 翻牌回调落地前再验 phase：token 不变但阶段已离开 presenting（写回中）时丢弃,
      // 避免向 writing 期追加候选并复活已关闭的气泡（appendFlip 本身无阶段门控）。
      if (this.session.phase !== "presenting") return;
      this.session.appendFlip(candidate);
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
   * 错误态重试：已捕获上下文存在（生成失败 / 空候选 / 未配置模型）→ 复用上下文重生成，不重捕获；
   * 捕获失败态无上下文 → 整轮重来（重新捕获）。
   */
  private async retry(): Promise<void> {
    if (this.session.phase === "idle") return;
    // 连点重试单飞：先 abort 在途生成（中止在途直连请求），再递增世代 token 作废旧回调，
    // 确保同一时刻只有一个生成在跑——否则 pushError 不改 phase、retry 不递增 token，
    // N 次点击会派生 N 个未取消的在途请求且回调全部命中，造成候选竞态。
    this.abortInFlight();
    if (!this.pending) {
      // 捕获失败态无上下文 → 整轮重来（startDraftSession 自身 beginCapture 递增 token）。
      await this.startDraftSession();
      return;
    }
    // 复用已捕获上下文重生成：beginRegenerate 递增 token 但保留 capturedPid（写回目标不变）。
    const token = this.session.beginRegenerate();
    this.pushGenerating();
    await this.generateFirst(token);
  }

  /** 组装 prompt；requestedStance 非空 = 决策点定向候选（prompt 尾部追加「按此立场写」指令）。 */
  private buildPrompt(
    pending: PendingContext,
    avoidReplies: string[],
    requestedStance: ReplyStance | null = null,
  ): ReplyPrompt {
    return buildReplyPrompt({
      conversation: pending.conversation,
      counterpartName: pending.capture.counterpart,
      voiceIntent: pending.voiceIntent,
      calendarContext: pending.calendarContext,
      userProfile: pending.composedProfile,
      conversationMemory: pending.conversationMemory,
      avoidReplies,
      requestedStance,
    });
  }

  // ── 写回 ──────────────────────────────────────────────────────────────────────

  /** ↩ 写回：关气泡 + 关吞键 → 延迟 → pid 校验（变则中止）→ ax-activate + paste → 学习回调。 */
  private async writeBack(): Promise<void> {
    if (this.session.phase !== "presenting") return;
    if (this.firstStreaming) return; // 首条流式中：避免把半截草稿粘贴出去，等流结束再 ↩
    const draft = this.session.currentDraft;
    if (draft.trim().length === 0) return;
    // 世代守卫：捕获本轮 token。writeBack 全程有 delay / frontmostPid 两处 await，期间新
    // draft-gesture 可能起新会话（beginCapture 递增 token）。凡在 await 之后、及执行 reset() /
    // 清 pending / paste 之前，都用 isCurrent(token) 校验：token 已被重入递增则放弃写回——
    // 绝不 reset、绝不清 pending、绝不 paste，否则会作废刚接管的新会话（R7）。
    const token = this.session.token;
    const capturedPid = this.session.capturedPid;
    const pending = this.pending;
    // 候选集快照须在 toWriting/reset 之前取（reset 会清空 _candidates），供写回成功后的
    // 历史存档回调使用。
    const candidatesSnapshot = this.session.candidates.map((c) => ({ ...c }));
    const acceptedIndex = this.session.currentIndex;

    this.session.toWriting();
    // 中止在途预生成/翻牌请求：写回后候选列表即将作废,残余生成毫无意义;更关键的是,
    // 写回窗口期(延迟 + pid 探测)内返回的旧回调若推 presenting 状态,会经 renderer 的
    // resize 上报把刚关闭的气泡重新顶出来(bug：回车后气泡不消失)。
    this.abortInFlight();
    closeReplyBubble();
    this.helper.setIntercept(false);
    await delay(WRITE_BACK_DELAY_MS);
    if (!this.session.isCurrent(token)) return; // 延迟期间新会话抢占 → 放弃,不动新会话状态

    // pid 校验（R6）：目标 app 变更则中止，绝不盲粘。
    const currentPid = await this.frontmostPid();
    if (!this.session.isCurrent(token)) return; // 探测 pid 期间新会话抢占 → 放弃
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
      if (!this.session.isCurrent(token)) return; // 写回过程被新会话抢占 → 不动新会话状态
      this.log.warn("[reply] 写回失败", err);
      this.session.reset();
      this.pending = null;
      return;
    }
    if (!this.session.isCurrent(token)) return; // paste 后再校验:期间抢占则不 reset/清 pending

    // 写回成功 → 触发下游消费（U10 学习管线 / 历史落盘 / 对话记忆；未接线时为 no-op）。
    if (pending) {
      this.onDraftAccepted?.({
        draft,
        conversation: pending.conversation,
        appName: pending.capture.appName,
        appBundleId: pending.capture.appBundleId,
        counterpart: pending.capture.counterpart,
        candidates: candidatesSnapshot,
        acceptedIndex,
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

  // ── 语音意图（U8，R1 后半 / R9）──────────────────────────────────────────────
  // 录音只能在渲染端做：voice-start → 弹「聆听中」气泡 + 令气泡启动 MediaRecorder（携 ASR 配置）；
  // voice-end → 令气泡停止 → 转写 → 结果经 reply-bubble:voice-result → handleVoiceResult。

  /**
   * voice-start：进入 recording 并弹气泡。同步开吞键 + 弹「聆听中」以即时反馈，随后读 ASR 配置：
   * 缺失（未配置语音）→ 不真正录音、提示后回 idle；就绪 → 令气泡启动录音。
   */
  private async onVoiceStart(): Promise<void> {
    this.abortInFlight();
    const token = this.session.beginRecording();
    // 新一轮录音：清掉上一轮遗留的「启动窗口松开」标记，避免误判本轮为快按快松。
    this.voicePendingStopToken = null;
    this.voiceActive = false;
    this.helper.setIntercept(true);
    openReplyBubble(null);
    this.pushRecording();
    // 读 ASR 配置（异步）：读完后校验 token——期间可能被新手势/取消抢占，过期则不再启动录音。
    const asr = (await this.getAsrSettings?.()) ?? null;
    if (!this.session.isCurrent(token)) {
      // token 过期（重入/取消）：本轮作废，一并清理可能登记在本轮的 pending stop 标记。
      if (this.voicePendingStopToken === token) this.voicePendingStopToken = null;
      return;
    }
    if (!asr) {
      // 未注入 / 返回 null → 语音不可用，提示后回 idle（不静默）。
      this.voiceActive = false;
      this.voicePendingStopToken = null;
      this.pushVoicePrompt("未配置语音识别，请先在设置中开启语音功能");
      return;
    }
    // 快按快松竞态修复：ASR 读取窗口内用户已松开（voice-end 登记了本轮 token）→ 别再开麦，
    // 干净取消回到非录音态，否则会启动一个再无 stop 事件的录音、麦克风常开、状态机卡 recording。
    if (this.voicePendingStopToken === token) {
      this.voicePendingStopToken = null;
      this.cancel();
      return;
    }
    this.voiceActive = true;
    sendReplyBubbleVoice({ command: "start", asr });
  }

  /**
   * voice-end：松开语音键 → 令气泡停止录音并转写（未真正录音则忽略）。保持 recording 态等结果。
   * 若在 onVoiceStart 的 ASR 读取窗口内到达（此时 voiceActive 仍为 false 但会话处于 recording），
   * 登记本轮 token 为 pending stop，交由 onVoiceStart await 返回后消费——修复快按快松麦克风常开。
   */
  private onVoiceEnd(): void {
    if (this.voiceActive) {
      this.voiceActive = false;
      sendReplyBubbleVoice({ command: "stop" });
      return;
    }
    // 录音启动窗口内的松开：麦尚未真正启动，先登记 token，onVoiceStart 据此放弃启动录音。
    if (this.session.phase === "recording") {
      this.voicePendingStopToken = this.session.token;
    }
  }

  /**
   * 气泡转写结果回调（reply-bubble:voice-result）：文本非空 → 作为口述意图起草；
   * 空识别 / 失败 → 气泡提示后回 idle（R1：不允许静默回 idle）。
   */
  handleVoiceResult(result: ReplyBubbleVoiceResult): void {
    const decision = decideVoiceIntent(result);
    if (decision.action === "draft") {
      void this.startDraftSession(decision.text);
      return;
    }
    this.pushVoicePrompt(
      decision.action === "empty" ? "没有识别到语音，请重试" : `语音转写失败：${decision.reason}`,
    );
  }

  /**
   * 语音失败/空识别提示：复用错误气泡展示 detail，并在停留片刻后自动回 idle（token 守卫，
   * 若期间用户已发起新会话则不误伤）。用 generationFailed 类型让用户可即时重试或关闭。
   */
  private pushVoicePrompt(detail: string): void {
    this.pushError("generationFailed", detail);
    const token = this.session.token;
    setTimeout(() => {
      if (this.session.isCurrent(token)) this.cancel();
    }, VOICE_PROMPT_DISMISS_MS);
  }

  // ── 收尾 / 取消 ───────────────────────────────────────────────────────────────

  /** esc / 关闭：abort 在途请求、回 idle、关吞键、关气泡。 */
  cancel(): void {
    this.abortInFlight();
    this.session.reset();
    this.helper.setIntercept(false);
    closeReplyBubble();
    this.pending = null;
    this.preGenActive = false;
    this.flipBusy = false;
    this.voiceActive = false;
    this.voicePendingStopToken = null;
  }

  /** abort 当前在途生成（中止在途直连请求）。 */
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

/** 调试日志用的候选文本：带立场时前缀 `[stance]`，便于在调试面板分辨定向候选。 */
function debugDraftText(draft: StancedDraft | ReplyCandidate): string {
  return draft.stance ? `[${draft.stance}] ${draft.text}` : draft.text;
}

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

/** 创建 reply 编排器单例并接管气泡动作 / 语音结果分发（index.ts 在 mac 平台调用）。 */
export function initReplyController(deps: ReplyControllerDeps): ReplyController {
  controller = new ReplyController(deps);
  setReplyBubbleActionHandler((action) => controller?.handleBubbleAction(action));
  setReplyBubbleVoiceResultHandler((result) => controller?.handleVoiceResult(result));
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
  setReplyBubbleVoiceResultHandler(null);
}
