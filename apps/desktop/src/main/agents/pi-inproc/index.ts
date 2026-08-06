// pi in-process 引擎层的对外入口。
//
// 接线方（`ipc/pi-session.ts`，U2 之后的阶段接）只需要这四样：
//   · `shouldUsePiInProcEngine()` —— 灰度选路（默认关，走 pi-rpc.ts 的二进制路径）；
//   · `openPiInProcSession()`     —— 等价于 `spawnPiRpc(buildRpcArgs(req)) + new PiRpcSession(...)`；
//   · `PiSessionEngine`           —— 两条路共同的接口，选路层只依赖它即可不写分支；
//   · `primePiInProcRuntime()`    —— 开关打开时在启动后台预热 ESM 依赖闭包。
//
// 其余导出面向 U3（能力注入）与 U5/U6（单发与并发调用方）：`loadPiAgentCore` / `loadPiAiCompat`
// 给原生工具与 Provider 适配用，`createBuiltinTools` / `applyActiveTools` 给自定义运行时用。

export {
  isPiGatewayEnabled,
  isPiInProcEnabled,
  parseBoolFlag,
  parseEngineKind,
  PI_ENGINE_ENV_FLAG,
  PI_INPROC_ENV_FLAG,
  resolvePiEngineChoice,
  resolvePiEngineKind,
  setPiEngine,
  setPiInProcEnabled,
  type PiEngineChoice,
  type PiEngineKind,
} from "./feature-flag";

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
  shouldUsePiInProcEngine,
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

// 单发路径（U5）。`cli.ts` 直接从 `./oneshot` 子路径引它，避免为一个选路函数把整条会话层
// （session.ts → pi-rpc.ts）拖进 cli.ts 的模块图；这里导出只为对外可发现性。
export { filterOneShotExtensionPaths, maybeStartPiInProcOneShot } from "./oneshot";
