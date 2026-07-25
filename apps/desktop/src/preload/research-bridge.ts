// Deep Research（CRE）的 preload 桥：把 8 个 research:* IPC channel 与 research:event 事件流
// 包成 CortexResearchBridge 暴露给渲染端（挂在 window.desktopAPI.personal.research 下）。
//
// **必须挂在 personal 下**：views 是经 CoreProvider 注入的 DesktopBridge 拿到它的，
// 而 DesktopBridge 的实现体就是 window.desktopAPI.personal，挂顶层渲染端根本拿不到。
//
// 安全红线（spec §16）：入参里**不出现** 模型 API key / Search token / Worker 二进制路径 /
// 任意本地输出路径。main 侧的 zod schema 是 .strict()，多传字段会被直接拒绝——所以桥这层
// 干脆不提供这些参数，让「渲染端指挥主进程读写它本来碰不到的位置」在类型层就无从表达。
// 想加参数前先问一句：它会不会让 renderer 指定主进程去碰某个路径或凭据。
import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  CortexResearchBridge,
  ResearchSearchServerCredentialInput,
  ResearchSearchServerProbe,
} from "@cortex-work/core/desktop/research-bridge";
import type { ResearchSearchServerSettings } from "@cortex-work/core/research/settings";
import type {
  ResearchDetailLevel,
  ResearchEvent,
  ResearchRequest,
  ResearchSessionFilter,
  ResearchSessionSummary,
  ResearchSessionView,
} from "@cortex-work/core/research/types";

/// 构造研究引擎桥。每个方法都是对 main 的一次 invoke，桥本身不持状态、不做缓存——
/// 会话真源在 main（SQLite + 编排器），渲染端的缓存收在 core/research/ui-store 一处。
export function createResearchBridge(): CortexResearchBridge {
  return {
    create: (request: ResearchRequest): Promise<ResearchSessionSummary> =>
      ipcRenderer.invoke("research:create", request),
    rerun: (sessionId: string): Promise<ResearchSessionSummary> =>
      ipcRenderer.invoke("research:rerun", sessionId),
    run: (sessionId: string): Promise<void> => ipcRenderer.invoke("research:run", sessionId),
    pause: (sessionId: string): Promise<void> => ipcRenderer.invoke("research:pause", sessionId),
    resume: (sessionId: string): Promise<void> => ipcRenderer.invoke("research:resume", sessionId),
    cancel: (sessionId: string): Promise<void> => ipcRenderer.invoke("research:cancel", sessionId),
    get: (sessionId: string, detail: ResearchDetailLevel): Promise<ResearchSessionView> =>
      ipcRenderer.invoke("research:get", sessionId, detail),
    list: (filter?: ResearchSessionFilter): Promise<ResearchSessionSummary[]> =>
      ipcRenderer.invoke("research:list", filter),
    delete: (sessionId: string): Promise<void> => ipcRenderer.invoke("research:delete", sessionId),
    // 订阅研究事件（照 onMemoryChanged 的写法）：**返回退订函数**，调用方卸载时必须调用，
    // 否则整窗覆盖层每开合一次就多挂一个 listener，最终触发 MaxListeners 告警并重复刷状态。
    onEvent: (listener: (event: ResearchEvent) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, event: ResearchEvent) => listener(event);
      ipcRenderer.on("research:event", handler);
      return () => ipcRenderer.removeListener("research:event", handler);
    },
    // 设置页的两个能力。**明文 PAT 只在这一个方向流动**：renderer → main → safeStorage 加密落盘。
    // 反向永远只回「已配置 / 未配置」与密文，桥这层不提供任何读明文的方法。
    setSearchServerCredential: (
      input: ResearchSearchServerCredentialInput,
    ): Promise<ResearchSearchServerSettings> =>
      ipcRenderer.invoke("research:setSearchServerCredential", input),
    // 探测不接受也不回传凭据：main 用已落盘的密文自行解密发起，只回成败与一句人话。
    testSearchServer: (): Promise<ResearchSearchServerProbe> =>
      ipcRenderer.invoke("research:testSearchServer"),
  };
}
