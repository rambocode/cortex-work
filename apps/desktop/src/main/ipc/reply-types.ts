// 快捷回复助手（reply）分片与桥接契约（主进程侧镜像）。
// 与 packages/core/desktop/reply-types.ts + core/reply/{memory,channels}.ts 逐字镜像 ——
// core 不能依赖 app 包，故两侧各持一份；preload 以 core 的 DesktopBridge 为准对齐。
//
// 主进程当前只把三分片随 PersistedState 透明落盘（store.ts round-trip），不深读；
// U7/U9 会真正消费这些类型。

import type { AgentKind, AsrSettings } from "./types";

// ── core/reply/memory.ts 镜像子集 ──────────────────────────────────────────────

/// 记忆分区：档案 + 通用/IM/邮件/公开。
export type MemoryScope = "profile" | "core" | "im" | "email" | "publicVoice";

/// 一个分区的手写区 + 自动学习区。
export interface MemoryFile {
  manual: string;
  auto: string;
}

export type MemoryState = Record<MemoryScope, MemoryFile>;

// ── core/reply/channels.ts 镜像子集 ────────────────────────────────────────────

/// 可配置渠道标识（连接渠道 + 日历渠道共用）。
export type ChannelId = "lark" | "slack" | "gmail" | "localCalendar" | "larkCalendar" | "googleCalendar";

/// 渠道校验错误类型。
export type ChannelVerifyErrorKind = "httpStatus" | "invalidResponse" | "apiError";

/// 单渠道连接状态（非敏感元数据）。
export interface ChannelConnectionState {
  id: ChannelId;
  isConnected: boolean;
  accountName?: string;
  accountDetail?: string;
  connectedAt?: number;
}

// ── 持久化三分片 ────────────────────────────────────────────────────────────────

export type ReplyDraftTriggerKey = "cmd" | "option" | "fn";
export type ReplyVoiceTriggerKey = "fn" | "rightOption" | "cmd";

export interface ReplySettings {
  draftTrigger: ReplyDraftTriggerKey;
  voiceTrigger: ReplyVoiceTriggerKey;
  learningEnabled: boolean;
  userProfile: string;
}

export type ReplyMemoryState = MemoryState;

/// safeStorage 密文（base64）。
export interface ReplyChannelCredential {
  ciphertext: string;
}

export interface ReplyChannelsState {
  connections: Partial<Record<ChannelId, ChannelConnectionState>>;
  credentials: Partial<Record<ChannelId, ReplyChannelCredential>>;
  notes: Partial<Record<ChannelId, string>>;
}

// ── 桥接能力数据契约 ──────────────────────────────────────────────────────────────

export type ReplyPermissionKind =
  | "accessibility"
  | "screenRecording"
  | "calendar"
  | "microphone"
  | "speechRecognition";

export type ReplyPermissionStatus = "granted" | "denied" | "notDetermined" | "unknown";

export type ReplyPermissionState = Record<ReplyPermissionKind, ReplyPermissionStatus>;

/// 全部权限「未知」的兜底态。
export const UNKNOWN_REPLY_PERMISSIONS: ReplyPermissionState = {
  accessibility: "unknown",
  screenRecording: "unknown",
  calendar: "unknown",
  microphone: "unknown",
  speechRecognition: "unknown",
};

export interface ReplyChannelVerifyResult {
  ok: boolean;
  accountName?: string;
  accountDetail?: string;
  ciphertext?: string;
  errorKind?: ChannelVerifyErrorKind;
  errorDetail?: string;
}

export interface ReplyDebugEntry {
  id: string;
  ts: number;
  source: "ax" | "ocr";
  axText?: string;
  ocrText?: string;
  systemPrompt?: string;
  userPrompt?: string;
  output?: string;
  error?: string;
}

export interface ReplySyncSnapshot {
  settings: ReplySettings;
  memory: ReplyMemoryState;
  defaultAgent: AgentKind;
  providerId?: string;
  model?: string;
}

/// main→renderer 语气蒸馏产出推送（U10 / R11）：某分区蒸馏出的 auto 要点，渲染端 store 应用后落盘。
/// 与 core/desktop/reply-types.ts 逐字镜像。
export interface ReplyMemoryLearned {
  scope: MemoryScope;
  auto: string;
}

// ── 候选气泡窗契约（U6，KTD5）──────────────────────────────────────────────────────
// 气泡窗是独立不抢焦 BrowserWindow（仿 notification）。主进程 → 气泡渲染端只推 ReplyBubbleState；
// 气泡渲染端 → 主进程只上报实测高度与鼠标动作（ReplyBubbleAction）。键盘不走 DOM：←/→/↩/esc/Tab
// 由 helper 吞键 → controller，再以更新后的 state 重新推送驱动 UI（窗口 focusable:false，永不聚焦）。

/// 屏幕坐标矩形（左上原点、单位 point）。ax-capture 输出的焦点输入框 frame 即此系；
/// Electron setBounds / screen 亦为左上原点 DIP，主显示器上 point≈DIP 直接对应（几何契约）。
export interface ReplyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// 气泡会话阶段（与 controller 状态机的可视子集对应）。
export type ReplyBubblePhase = "generating" | "presenting" | "recording" | "error";

/// 错误态细分：agentNotConfigured → 引导去设置；generationFailed/emptyCandidates → 原因+重试/关闭。
export type ReplyBubbleErrorKind = "agentNotConfigured" | "generationFailed" | "emptyCandidates";

/// 主进程 → 气泡渲染端的完整可视状态（每次变更整体推送，渲染端无本地态可言）。
export interface ReplyBubbleState {
  phase: ReplyBubblePhase;
  /// 已到达的候选草稿（presenting 阶段渲染 candidates[currentIndex]）。
  candidates: string[];
  /// 当前展示的候选下标（←/→/Tab 由 controller 改后重推）。
  currentIndex: number;
  /// 是否仍在后台预生成翻牌候选（控制圆点「逐个出现」的动画语义）。
  preGenerating?: boolean;
  /// 错误态类型（phase==="error" 时有效）。
  errorKind?: ReplyBubbleErrorKind;
  /// 错误明细（generationFailed 时透出原因，便于用户判断是否重试）。
  errorDetail?: string;
}

/// 气泡渲染端 → 主进程的鼠标动作（键盘动作不走此通道）。
export type ReplyBubbleAction =
  | { type: "flip" } // 翻牌：追加一条避重候选
  | { type: "retry" } // 错误态重试生成
  | { type: "close" } // 关闭气泡
  | { type: "select"; index: number } // 点击圆点直接切到某候选
  | { type: "openSettings" }; // agentNotConfigured 引导去设置

// ── 语音意图录音通道（U8，R1 后半 / R9）─────────────────────────────────────────────
// 「按住语音键说话」由 helper 判定手势 → controller 令气泡渲染端启动 MediaRecorder（录音只能在
// 渲染端做）。主进程 → 气泡：voice start/stop 指令（start 携带 asrSettings，转写走统一入口）；
// 气泡 → 主进程：转写结果（文本作为口述意图触发起草，或空/失败让 controller 提示后回 idle）。

/// 主进程 → 气泡的录音指令。start 携带转写配置（main 从持久化态读取；null=未配置，气泡将回失败）。
export type ReplyBubbleVoiceCommand =
  | { command: "start"; asr: AsrSettings | null }
  | { command: "stop" };

/// 气泡 → 主进程的转写结果。ok+text 非空 → 起草；ok 但空文本 → 未识别；!ok → 失败（reason 供提示）。
export interface ReplyBubbleVoiceResult {
  ok: boolean;
  text?: string;
  reason?: string;
}
