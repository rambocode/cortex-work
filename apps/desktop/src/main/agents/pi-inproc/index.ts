// pi in-process 引擎层的对外入口。
//
// 引擎已收敛：长驻会话与编排无条件走 gateway worker（`pi-gateway/client.ts`），worker 内
// 持有的正是本目录的 `PiInProcSession`；单发路径无条件走 `oneshot.ts`。不再有 feature-flag
// 选路——binary（bun 二进制 + spawn）与主进程 inproc 两条路径连同开关一起删除。
//
// 其余导出面向能力注入与调用方：`loadPiAgentCore` / `loadPiAiCompat` 给原生工具与 Provider
// 适配用，`createBuiltinTools` / `applyActiveTools` 给自定义运行时用。

export {
  loadPiAgentCore,
  loadPiAiCompat,
  loadPiCodingAgent,
  primePiInProcRuntime,
  PiRuntimeLoadError,
  type PiAgentCoreModule,
  type PiAiCompatModule,
  type PiCodingAgentModule,
  type PiPackageId,
} from "./runtime";

export {
  openPiInProcSession,
  PiInProcSession,
  type PiInProcDeps,
  type PiInProcModelResolver,
  type PiInProcModelSelection,
  type PiInProcOpenOptions,
  type PiSessionEngine,
} from "./session";

export {
  applyActiveTools,
  createBuiltinTools,
  PI_BUILTIN_TOOL_NAMES,
  PI_CODING_TOOL_NAMES,
  PI_EXTRA_BUILTIN_TOOL_NAMES,
  resolveToolWhitelist,
  type PiBuiltinToolName,
  type ResolvedToolWhitelist,
} from "./tools";

export {
  AGENT_TURN_EVENT_TYPES,
  createPiEventPump,
  isAgentTurnEvent,
  sanitizePiSessionEvent,
  type PiEventPump,
  type PiEventPumpOptions,
  type PiEventSink,
} from "./events";

export { createPiUiBridge, type PiUiBridge, type PiUiBridgeOptions } from "./ui-context";

// 引擎共享的协议形状与事件归一化（原 pi-rpc.ts 的存留部分）。
export {
  mapPiEvent,
  sanitizeAskQuestionEnvelope,
  slashCommandName,
  type PiImageContent,
  type RpcResponse,
  type RpcSlashCommandSource,
} from "./rpc-shared";

// 单发路径。`cli.ts` 等调用方直接从 `./oneshot` 子路径引它，避免为一个入口函数把整条会话层
// 拖进 cli.ts 的模块图；这里导出只为对外可发现性。
export { startPiInProcOneShot, type PiOneShotOptions } from "./oneshot";
