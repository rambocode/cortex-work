// Deep Research 组件对桌面能力的**结构性依赖**声明。
//
// 契约真源在 `packages/core/desktop/bridge.ts` 的 research 段（由后续接线阶段添加），
// preload 经 contextBridge 暴露的 `window.desktopAPI.research` 与之同形。此处这份接口是
// views 侧的镜像，存在的理由只有一个：**组件不许直接摸 `window`**，桥必须由 props 注入，
// 这样组件在 jsdom 里能用手写替身完整测试，Web 端（没有桌面桥）也能传 null 走降级分支。
//
// 两者必须保持一致：core 侧新增/改名方法时，这里同步改，否则接线阶段会在类型层直接炸出来
// （接线代码会把真 bridge 赋给 ResearchBridgeLike 类型的 prop）。
//
// 方法语义与 core 的 ResearchEngineFacade 完全对齐（spec §7.2），只多一个 onEvent：
// Facade 是 main 内部的同步门面，事件推送是跨进程的，所以订阅只出现在桥这一层。
import type {
  ResearchDetailLevel,
  ResearchEngineFacade,
  ResearchEvent,
  ResearchRequest,
  ResearchSessionFilter,
  ResearchSessionSummary,
  ResearchSessionView,
} from "@cortex-work/core/research/types";

export interface ResearchBridgeLike {
  create(request: ResearchRequest): Promise<ResearchSessionSummary>;
  /// 终态会话的重跑：用同一批参数新建一个会话，旧会话原样保留。
  rerun(sessionId: string): Promise<ResearchSessionSummary>;
  /// 复用原计划与证据重新撰写并覆盖当前报告，不重新搜索。
  regenerateReport(sessionId: string): ReturnType<ResearchEngineFacade["regenerateReport"]>;
  run(sessionId: string): Promise<void>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  get(sessionId: string, detail: ResearchDetailLevel): Promise<ResearchSessionView>;
  list(filter?: ResearchSessionFilter): Promise<ResearchSessionSummary[]>;
  delete(sessionId: string): Promise<void>;
  /// 订阅 main 推来的研究事件；**返回值是退订函数，调用方卸载时必须调用**，
  /// 否则整窗覆盖层反复开合会累积监听器（每次开合都会新订阅一次）。
  onEvent(listener: (event: ResearchEvent) => void): () => void;
}

/// 「A 必须可赋给 B」的编译期断言载体。约束写在类型参数上，不满足时 TS 在此处报错。
type AssertExtends<A extends B, B> = A;

/// **编译期对齐哨兵**：把上面那段「两者必须保持一致」的口头约定变成 typecheck 会拦的硬检查。
/// core 的 ResearchEngineFacade 一旦改签名 / 改名 / 删方法，本行立刻编译失败，
/// 而不是拖到接线阶段才发现。反向不检查（本接口刻意多一个 onEvent，见上文）。
export type ResearchBridgeFacadeAlignment = AssertExtends<ResearchBridgeLike, ResearchEngineFacade>;
