// Kun agent/runtime-client 的注入式端口：design 编排层（design-pages-run 等）
// 经它做 SSE 订阅与设置读取。cortex 侧没有 Kun runtime——批7 由 design-run-manager
// 注入 startCli/CliStreamEvent 适配实现；未注入时各方法安全降级（no-op / 默认设置），
// 保证画布纯编辑路径（不派发 agent 回合）可独立工作。
import { defaultDesignSettings, type AppSettingsV1 } from "./app-settings";

// SSE 事件负载（宽松结构：design 消费端自行判别字段）。
export type DesignSseEventPayload = {
  streamId?: string;
  threadId?: string;
  event?: Record<string, unknown>;
} & Record<string, unknown>;

export interface DesignRuntimeClient {
  // 为线程开启事件流；返回 streamId 供 stopSse 配对。
  startSse: (threadId: string, sinceSeq: number, streamId?: string) => Promise<{ streamId: string }>;
  onSseEvent: (listener: (payload: DesignSseEventPayload) => void) => () => void;
  stopSse: (streamId: string) => void;
  // 设置缓存失效/读取（design 读 .design 分片）。
  invalidateSettings: () => void;
  getSettings: () => Promise<AppSettingsV1>;
}

// 未注入时的安全降级实现。
const noopClient: DesignRuntimeClient = {
  startSse: async (_threadId, _sinceSeq, streamId) => ({ streamId: streamId ?? "noop" }),
  onSseEvent: () => () => {},
  stopSse: () => {},
  invalidateSettings: () => {},
  getSettings: async () => ({ design: defaultDesignSettings() }) as AppSettingsV1,
};

let installed: DesignRuntimeClient | null = null;

export function setDesignRuntimeClient(client: DesignRuntimeClient | null): void {
  installed = client;
}

// 与 Kun 同名导出：移植代码以 rendererRuntimeClient.xxx 直接调用。
// 用 Proxy 而非快照对象，保证注入发生在首次调用之后也能生效。
export const rendererRuntimeClient: DesignRuntimeClient = new Proxy(noopClient, {
  get(target, prop: keyof DesignRuntimeClient) {
    return (installed ?? target)[prop];
  },
}) as DesignRuntimeClient;
