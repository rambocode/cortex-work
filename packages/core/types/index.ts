// Domain types for Cortex Desktop — ported from the design prototype's data shapes.

import type { Locale } from "../i18n/locales";

export type AgentStatus = "idle" | "working" | "review" | "online" | "offline";
export type GroupId = "pinned" | "team" | "shared" | "groups";

export interface Avatar {
  initials: string;
  bg: string;
  // 内置头像 id（个人工作区用户自定义头像）。存在时渲染层按 id 画内置 SVG，
  // 否则回退到 initials + bg。agent / 联系人头像不带此字段，渲染不变。
  avatarId?: string;
}

// Organization / workspace the user belongs to (shown in the sidebar switcher).
export interface Organization {
  id: string;
  name: string;
  initials: string;
}

// Rich inline text — a string, or a sequence of typed parts so views can render
// mentions / inline code without core depending on react-dom.
export type RichPart =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "path"; v: string }
  | { t: "mention"; v: string };

export type RichText = string | { kind: "rich"; parts: RichPart[] };

// Sidebar "last message" preview variants.
export type LastMessage =
  | string
  | { kind: "working"; text: string }
  | { kind: "review"; text: string }
  | { kind: "mention"; text: string };

export interface Contact {
  id: string;
  name: string;
  group: GroupId;
  role?: string;
  avatar: Avatar;
  agentStatus: AgentStatus;
  statusText: string;
  last: LastMessage;
  time: string;
  unread: number;
  pinned?: boolean;
  mention?: boolean;
  badgeTag?: "my" | "shared";
}

export interface Group {
  id: GroupId;
  label: string;
}

export type AgentLogIcon = "check" | "running" | "pending" | "dot";

export interface AgentLogItem {
  ic: AgentLogIcon;
  text: RichText;
}

export interface DiffFileRef {
  path: string;
  add: number;
  del: number;
  active?: boolean;
}

export type DiffStatus = "pending" | "applied" | "rejected";

export interface ReplyRef {
  who: string;
  text: string;
}

// 用户消息携带的引用(拖入聊天框的 skill / todo / 文档),仅用于会话气泡里回显「引用了什么」。
export interface MessageAttachmentRef {
  name: string;
  kind: "prompt" | "todo" | "document";
}

// 用户消息携带的图片引用(粘贴/拖拽/选择上传)。落盘后的绝对路径 + 显示名 + MIME + 宽高,
// 随会话 JSON 持久化。**不含** base64/dataUrl —— 那只活在内存与 image:read 回读返回;
// 写进消息会撑爆 chat JSON(同 reasoning 当初被 sanitize 丢弃的前车之鉴)。
export interface ChatImageRef {
  path: string; // 绝对路径(主进程 image:save 落盘后返回)
  name: string; // 显示用原始文件名(仅 alt / 展示,不参与路径构造)
  mimeType: string;
  width?: number;
  height?: number;
}

// 用户消息携带的文档附件引用(PDF / 现代 Office / 纯文本)。落盘后的绝对路径 + 显示名 + MIME + 字节数,
// 随会话 JSON 持久化。**不含**文件内容 —— 内容由 agent 经文档抽取 MCP 工具(doc-extract)按需读取,
// 不内联进 chat JSON(同 ChatImageRef 不存 base64 的前车之鉴)。
export interface ChatFileRef {
  path: string; // 绝对路径(主进程 doc:save 落盘后返回,落在 chatDocsRoot()/<sessionId>/)
  name: string; // 显示用原始文件名(仅展示,不参与路径构造)
  mimeType: string;
  sizeBytes?: number;
}

export type Message =
  | { kind: "day"; label: string; uid?: string }
  | {
      kind: "text";
      who: string;
      time: string;
      text: RichText;
      reply?: ReplyRef;
      attachments?: MessageAttachmentRef[];
      images?: ChatImageRef[];
      files?: ChatFileRef[];
      // 圆桌编排：标注本条消息来自哪个角色（渲染端据此显示角色标签/颜色）。
      roleId?: string;
      roleLabel?: string;
      roleColor?: string;
      uid?: string;
    }
  | {
      // pi RPC 思考流（thinking_delta）:可折叠的思考块,区别于正文 text。仅 reasoning 模型产出。
      kind: "reasoning";
      who: string;
      time: string;
      text: RichText;
      active?: boolean;
      completed?: boolean;
      uid?: string;
    }
  | {
      kind: "agentLog";
      who: string;
      time: string;
      title: string;
      active?: boolean;
      completed?: boolean;
      items: AgentLogItem[];
      uid?: string;
    }
  | {
      kind: "diff";
      who: string;
      time: string;
      title: string;
      sub: string;
      status: DiffStatus;
      files: DiffFileRef[];
      uid?: string;
    }
  | { kind: "approve"; who: string; time: string; title: string; body: RichText; uid?: string }
  | { kind: "typing"; who: string; text: string; uid?: string }
  | {
      // 三段编排（orchestrate.ts）段边界标题，仅出现在过程流：把 intent/subagent/refine 三段
      // 在右侧执行过程面板里分隔成可见小标题。由 sendStageStart 发的空 delta thinking 事件
      // （携 stage/stageLabel）转化而来，无 active/累进语义（区别于 reasoning）。
      kind: "stageTitle";
      who: string;
      time: string;
      stage: "intent" | "subagent" | "refine";
      label: string;
      uid?: string;
    }
  | {
      // 圆桌编排角色切换标题，出现在聊天正文流中（区别于 stageTitle 仅过程流）。
      // 由 roundtable.ts 的 init[roleId] 事件转化，标记后续文本来自哪个角色。
      kind: "roleHeader";
      who: string;
      time: string;
      roleId: string;
      roleLabel: string;
      roleColor?: string;
      roleAvatar?: string;
      uid?: string;
    };

export interface HeaderStatus {
  dot: "working" | "review" | "online" | "idle";
  text: string;
}

export interface KeyValue {
  k: string;
  v: string;
}

export interface Conversation {
  headerStatus: HeaderStatus;
  metaRow: KeyValue[];
  messages: Message[];
}

// Code-diff preview (right panel). Each line is a sequence of syntax tokens.
export type DiffSide = "ctx" | "add" | "del" | "hunk";

export interface CodeToken {
  // Token class suffix, e.g. "kw" → .tk-kw. Omitted for plain text.
  c?: string;
  t: string;
}

export interface DiffLine {
  num: number;
  side: DiffSide;
  tokens: CodeToken[];
}

export interface FileDiff {
  path: string;
  crumbs: string[];
  stat: { add: number; del: number };
  lines: DiffLine[];
}

export interface WhoMeta {
  name: string;
  avatar: Avatar;
  agent: "shared" | "mine" | "agent" | null;
  isMe?: boolean;
}

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  // 兼容主体:无 title 时 text 作为卡片主行;有 title 时可为空。
  text: string;
  kind: ToastKind;
  // ── 富样式可选字段(全局通用提醒)──────────────────────────────
  // 加粗标题;存在时 text 退为可省略。
  title?: string;
  // 标题下的次级说明行。
  description?: string;
  // 图标名(对应 @cortex-work/ui 的 Icon.*)。core 不依赖 ui,故用 string,
  // 在视图层用 IconName 收窄;缺省时由 kind 推导默认图标。
  iconName?: string;
  // 是否显示关闭按钮(默认 true)。
  dismissible?: boolean;
  // 自动消失时长(ms);0 表示常驻直到手动关闭。
  duration?: number;
}

export type Density = "compact" | "regular" | "cozy";
export type Palette = "clay" | "twilight" | "forest" | "ink";
export type SidebarMode = "rich" | "minimal" | "activity";
export type ThemeMode = "system" | "light" | "dark";
export type FontScale = "small" | "medium" | "large";

export interface Tweaks {
  density: Density;
  palette: Palette;
  sidebar: SidebarMode;
  // 全局字号缩放（small/medium/large → --font-scale）。
  fontScale: FontScale;
  // 明暗主题（system 跟随系统）。
  theme: ThemeMode;
  // 界面语言（zh-Hans / en）—— 与 theme 同走 localStorage 持久化（KTD3）。
  language: Locale;
}
