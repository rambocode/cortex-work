// 快捷回复助手（reply）分片与桥接契约（主进程侧镜像）。
// 与 packages/core/desktop/reply-types.ts + core/reply/{memory,channels}.ts 逐字镜像 ——
// core 不能依赖 app 包，故两侧各持一份；preload 以 core 的 DesktopBridge 为准对齐。
//
// 主进程当前只把三分片随 PersistedState 透明落盘（store.ts round-trip），不深读；
// U7/U9 会真正消费这些类型。

import type { AgentKind } from "./types";

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
