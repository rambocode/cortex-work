// Kun store/chat-store-types 的裁剪版 compat：design 树只消费 QueuedUserMessage 与
// SendMessageOverrides 两个类型，完整版拖带 Kun claw/runtime 大量无关类型，故只保留
// 被用符号及其传递依赖。运行时投递语义由 design 侧 run-manager（批7）对接 startCli。
import type { AttachmentReference, UserFileReference } from "./agent-types";

// GUI 计划回合的上下文（design 树里 guiPlan 仅作为透传字段存在）。
export type GuiPlanMessageContext = {
  operation: "draft" | "refine";
  workspaceRoot: string;
  relativePath: string;
  planId: string;
  sourceRequest?: string;
  title?: string;
};

// 排队中的用户消息（设计回合派发时构造）。
export type QueuedUserMessage = {
  id: string;
  text: string;
  displayText?: string;
  mode?: string;
  model?: string;
  providerId?: string;
  modelLabel?: string;
  reasoningEffort?: string;
  attachmentIds?: string[];
  attachments?: AttachmentReference[];
  fileReferences?: UserFileReference[];
  guiPlan?: GuiPlanMessageContext;
  // 标记这是设计画布回合（Kun 语义保留；cortex 侧由 runId 前缀承担路由职责）。
  guiDesignCanvas?: boolean;
};

// sendMessage 的覆盖参数（模型/供应商/附件等按回合覆盖）。
/**
 * 本轮随消息发送的图片(尚未落盘)。与个人会话的 PendingImage 同形状:
 * run-manager 经 bridge.imageSave 落盘换绝对路径,再交给各 agent 的原生图片通道。
 */
export type DesignPendingImage = {
  name: string;
  mimeType: string;
  data: ArrayBuffer;
};

export type SendMessageOverrides = {
  queued?: QueuedUserMessage;
  /** 待发图片;两条发送路径(slides 合同回合 / design prompt 路由)共用同一字段。 */
  images?: DesignPendingImage[];
  // 回合模式标记(Kun 语义;design-assistant 派发时透传)。
  mode?: string;
  model?: string;
  providerId?: string;
  modelLabel?: string;
  reasoningEffort?: string;
  displayText?: string;
  guiPlan?: GuiPlanMessageContext;
  guiDesignCanvas?: boolean;
  attachmentIds?: string[];
  attachments?: AttachmentReference[];
  fileReferences?: UserFileReference[];
};
