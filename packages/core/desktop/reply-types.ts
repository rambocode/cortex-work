// 快捷回复助手（reply）的持久化分片与桥接数据契约（U5/KTD4/KTD6）。
//
// 拆到独立文件的原因：desktop/types.ts 已逾 1200 行硬上限（见 tasks-types 同样的拆分先例），
// 新增类型一律落此并经 types.ts `export *` 透出，路径 @cortex-work/core/desktop/types 不变。
// 与 apps/desktop/src/main/ipc/reply-types.ts 逐字镜像（core 不能依赖 app 包，两侧各持一份）。
//
// 数据类型复用 core/reply 纯逻辑层（memory.ts / channels.ts），避免二次定义漂移。

import type { MemoryState } from "../reply/memory";
import type { ChannelId, ChannelConnectionState, ChannelVerifyErrorKind } from "../reply/channels";

// ── 设置分片（replySettings）───────────────────────────────────────────────────

/// 起草触发修饰键（双击唤起起草）。默认 cmd（源项目 draftTrigger 默认 ⌘）。
export type ReplyDraftTriggerKey = "cmd" | "option" | "fn";
/// 语音触发修饰键（按住说话）。默认 fn（源项目 voiceTrigger 默认 Fn）。
export type ReplyVoiceTriggerKey = "fn" | "rightOption" | "cmd";

/// 快捷回复的用户可配置项（持久化随 personal-workspace.json 落盘）。
export interface ReplySettings {
  /// 起草触发键，默认 cmd。
  draftTrigger: ReplyDraftTriggerKey;
  /// 语音触发键，默认 fn。
  voiceTrigger: ReplyVoiceTriggerKey;
  /// 「从我发出的消息学习语气」开关，默认开（KTD8：仅开启时才蒸馏，且样本不落盘）。
  learningEnabled: boolean;
  /// 「保存回复历史」开关，默认开（KTD8 边界修订：开启时已采纳会话的对话原文与候选
  /// 明文落 ~/.cortex-desktop/reply/history.json，关闭则零落盘；数据清理可整体清空）。
  historyEnabled: boolean;
  /// 用户档案自由文本（composeUserProfile 的 base；与分区记忆的 profile scope 并列注入 prompt）。
  userProfile: string;
  /// reply 专属生成供应商 id（KTD3）：空=跟随 providerSettings.defaultProviderId/defaultModel 回退链。
  /// 只存 id 引用，baseUrl/apiKey 由 main 侧从 providerSettings 现解析，凭据不落入本设置分片。
  providerId?: string;
  /// reply 专属模型 id（配合 providerId）：空则取该供应商 models[0]，仍空则落默认链。
  model?: string;
}

export const DEFAULT_REPLY_SETTINGS: ReplySettings = {
  draftTrigger: "cmd",
  voiceTrigger: "fn",
  learningEnabled: true,
  historyEnabled: true,
  userProfile: "",
};

// ── 记忆分片（replyMemory）──────────────────────────────────────────────────────

/// 分区记忆分片：直接复用 core/reply 的 MemoryState（5 分区 × {manual, auto}）。
/// 注意 KTD8：仅手写笔记与蒸馏产出的风格要点落盘，原始对话样本一律不入此结构。
export type ReplyMemoryState = MemoryState;

// ── 渠道分片（replyChannels）────────────────────────────────────────────────────

/// 单渠道加密凭据：safeStorage 密文（base64）。main 侧加解密，store 只存密文（R13/KTD6）。
export interface ReplyChannelCredential {
  ciphertext: string;
}

/// 渠道连接分片：连接态 + 加密凭据 + 备注，均按 ChannelId 索引。
export interface ReplyChannelsState {
  /// 连接状态（非敏感元数据：账号名 / 团队 / 连接时间）。
  connections: Partial<Record<ChannelId, ChannelConnectionState>>;
  /// 加密凭据密文（连接校验通过后由 main 侧 safeStorage 加密回传，渲染端持久化）。
  credentials: Partial<Record<ChannelId, ReplyChannelCredential>>;
  /// 各渠道备注（数据清理可整体清空）。
  notes: Partial<Record<ChannelId, string>>;
}

export const DEFAULT_REPLY_CHANNELS: ReplyChannelsState = {
  connections: {},
  credentials: {},
  notes: {},
};

// ── 桥接能力数据契约（DesktopBridge reply* 方法；U5 skeleton，U7/U9 填实）──────────

/// 五项系统权限（对应 node-mac-permissions 覆盖面 + helper permissions 命令兜底）。
export type ReplyPermissionKind =
  | "accessibility"
  | "screenRecording"
  | "calendar"
  | "microphone"
  | "speechRecognition";

/// 权限状态：已授权 / 已拒绝 / 未决定 / 未知（查询失败或非 mac 平台）。
export type ReplyPermissionStatus = "granted" | "denied" | "notDetermined" | "unknown";

export type ReplyPermissionState = Record<ReplyPermissionKind, ReplyPermissionStatus>;

/// 全部权限「未知」的兜底态（非 mac 平台 / 查询不可用时用）。
export const UNKNOWN_REPLY_PERMISSIONS: ReplyPermissionState = {
  accessibility: "unknown",
  screenRecording: "unknown",
  calendar: "unknown",
  microphone: "unknown",
  speechRecognition: "unknown",
};

/// 渠道凭据校验结果（main 侧执行 fetch + safeStorage 加密后回传渲染端）。
/// 成功时带账号身份 + 密文；失败时带 U2 ChannelVerifyError 的错误类型与细节。
export interface ReplyChannelVerifyResult {
  ok: boolean;
  accountName?: string;
  accountDetail?: string;
  /// 校验通过时的 safeStorage 密文，渲染端持久化进 replyChannels.credentials。
  ciphertext?: string;
  errorKind?: ChannelVerifyErrorKind;
  errorDetail?: string;
}

/// 调试记录一条（仅内存驻留，进程退出即清；R14/KTD8）。
export interface ReplyDebugEntry {
  id: string;
  ts: number;
  /// 捕获来源：AX 树读取 / 截屏 OCR。
  source: "ax" | "ocr";
  axText?: string;
  ocrText?: string;
  systemPrompt?: string;
  userPrompt?: string;
  output?: string;
  error?: string;
}

/// renderer→main 设置快照：main 侧起草时取最新 settings（含 reply 专属 providerId/model 与
/// userProfile）组装 prompt。KTD3：模型解析在 main 侧做；KTD6 修订：分区记忆已迁 main-owned
/// memory.json（reply/memory-store.ts），main 直接读文件，快照不再携带 memory。
export interface ReplySyncSnapshot {
  settings: ReplySettings;
}

/// 设置页「数据」分区的只读摘要（main 侧统计 ~/.cortex-desktop/reply/ 下的落盘数据）。
export interface ReplyDataSummary {
  /// 回复历史条数（history.json）。
  historyCount: number;
  /// 对话级记忆条数（conversation-memory.json，按 app+联系人 key 计）。
  conversationCount: number;
}

