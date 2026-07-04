// Kun agent/registry 的注入式端口：design 树经 getProvider() 拿「会话运行时提供方」
// 做线程创建/发消息/传附件/取线程详情。cortex 侧由 design-run-manager（批7）注入
// startCli + chat:load/save 适配实现；未注入时抛出可诊断错误（这些调用只发生在
// 派发 agent 回合的路径上，纯画布编辑不会触达）。
import type { NormalizedThread, ChatBlock, AttachmentReference } from "./agent-types";
import type { SendMessageOverrides } from "./chat-store-types";

// 线程详情（design 消费 blocks 时间线与线程元数据）。
export type DesignThreadDetail = {
  thread: NormalizedThread;
  blocks: ChatBlock[];
} & Record<string, unknown>;

// 上传结果:Kun provider 返回带媒体元数据的附件引用(画布自动附件消费 name/mimeType/尺寸)。
export type DesignUploadedAttachment = AttachmentReference & {
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
};

export interface DesignRuntimeProvider {
  createThread: (input?: Record<string, unknown>) => Promise<NormalizedThread>;
  sendUserMessage: (
    threadId: string,
    text: string,
    overrides?: SendMessageOverrides,
  ) => Promise<Record<string, unknown> | void>;
  uploadAttachment: (payload: Record<string, unknown>) => Promise<DesignUploadedAttachment>;
  getThreadDetail: (threadId: string) => Promise<DesignThreadDetail>;
}

let installed: DesignRuntimeProvider | null = null;

export function setDesignRuntimeProvider(provider: DesignRuntimeProvider | null): void {
  installed = provider;
}

// 与 Kun 同名导出。
export function getProvider(): DesignRuntimeProvider {
  if (!installed) {
    throw new Error("design runtime provider 未注入：请先经 setDesignRuntimeProvider() 安装实现");
  }
  return installed;
}
