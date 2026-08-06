// pi 执行形态的灰度开关（迁移计划 R3 / KTD6）。
//
// 为什么需要它：in-process 引擎层与 `pi-rpc.ts`（bun 二进制 + spawn）在整个迁移期**并存**，
// 由这一个开关选路。任何一个阶段出问题都能一键退回二进制路径，而不必回滚代码。
// **默认关闭**——没有显式打开时，行为与迁移前逐字一致。
//
// 优先级（高 → 低）：
//   1. 单测注入（`__setPiEngineForTests` / 旧的 `__setPiInProcEnabledForTests`）
//   2. 运行时覆盖（`setPiEngine`，供设置页/IPC 后续接线，不必重启）
//   3. 环境变量 `CORTEX_PI_ENGINE`（三值，显式且可扩展）
//   4. 环境变量 `CORTEX_PI_INPROC`（旧的布尔开关，保留兼容：true → inproc）
//   5. 默认 `binary`（二进制路径）
//
// 刻意**不**在这里读持久化设置：读设置是异步的，而选路点（`pi:open`）需要同步判定；
// 让宿主在启动时把设置值 push 进 `setPiInProcEnabled()` 即可，方向单一、无隐式 IO。

/**
 * 引擎种类（三条路径并存，见 docs/plans/2026-08-06-001-refactor-pi-gateway-worker-plan.md）：
 *   · `binary`  = `pi --mode rpc` 子进程（bun 编译二进制）——**默认**，迁移期的退路；
 *   · `inproc`  = 主进程内直接持有 `AgentSession`——摆脱了编译链，但没有进程/性能隔离；
 *   · `gateway` = `utilityProcess` worker 内持有 `AgentSession`——两份收益都拿到。
 *
 * 三者都实现 `PiSessionEngine`，故选路只影响构造那一处。
 */
export type PiEngineKind = "binary" | "inproc" | "gateway";

/** 选路结果 + 来源，供日志/诊断定位「为什么走了这条路」。 */
export interface PiEngineChoice {
  engine: PiEngineKind;
  /** 判定来源：test / override / env / default。 */
  source: "test" | "override" | "env" | "default";
}

/** 旧的布尔开关（`1` → inproc）。保留兼容：已有脚本/文档/测试在用它。 */
export const PI_INPROC_ENV_FLAG = "CORTEX_PI_INPROC";

/** 三值开关。取值为 `PiEngineKind`；无法识别时**忽略**（不静默降级，见 parseEngineKind）。 */
export const PI_ENGINE_ENV_FLAG = "CORTEX_PI_ENGINE";

let testOverride: PiEngineKind | null = null;
let runtimeOverride: PiEngineKind | null = null;

/**
 * 解析三值开关。无法识别的取值返回 undefined（当作未设置）而不是回落到 binary——
 * 与 `parseBoolFlag` 同一条理由：一个拼写错误不该把显式的选路意图静默吞掉，
 * 让它继续往下走到旧开关/默认，同时由调用方打日志说明「为什么走了这条路」。
 */
export function parseEngineKind(raw: string | undefined): PiEngineKind | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  return v === "binary" || v === "inproc" || v === "gateway" ? v : undefined;
}

/**
 * 把环境变量值解析成三态：true / false / undefined（未设置或无法识别）。
 * 无法识别的取值当作「未设置」而不是 false——否则一个拼写错误会把显式的开启意图静默吞掉。
 */
export function parseBoolFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

/** 解析当前选路（含来源）。同步、无 IO，可在 `pi:open` 热路径直接调用。 */
export function resolvePiEngineChoice(env: NodeJS.ProcessEnv = process.env): PiEngineChoice {
  if (testOverride !== null) return { engine: testOverride, source: "test" };
  if (runtimeOverride !== null) return { engine: runtimeOverride, source: "override" };
  const fromEngineEnv = parseEngineKind(env[PI_ENGINE_ENV_FLAG]);
  if (fromEngineEnv !== undefined) return { engine: fromEngineEnv, source: "env" };
  // 旧布尔开关只能表达 inproc/binary；显式 false 也要尊重（它是「明确要走二进制」的意思）。
  const fromLegacy = parseBoolFlag(env[PI_INPROC_ENV_FLAG]);
  if (fromLegacy !== undefined) return { engine: fromLegacy ? "inproc" : "binary", source: "env" };
  return { engine: "binary", source: "default" };
}

/** 当前选路的引擎种类。同步、无 IO，可在 `pi:open` 热路径直接调用。 */
export function resolvePiEngineKind(env: NodeJS.ProcessEnv = process.env): PiEngineKind {
  return resolvePiEngineChoice(env).engine;
}

/** 是否走 in-process 引擎（**仅** inproc，不含 gateway）。 */
export function isPiInProcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePiEngineChoice(env).engine === "inproc";
}

/** 是否走 gateway worker 引擎。 */
export function isPiGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePiEngineChoice(env).engine === "gateway";
}

/**
 * 运行时覆盖开关（宿主把持久化设置 push 进来时调用）。传 null 交回环境变量/默认判定。
 * 只影响**之后新建**的会话：已建立的会话不会中途换引擎（换引擎等于换进程边界，无法热切）。
 */
export function setPiEngine(engine: PiEngineKind | null): void {
  runtimeOverride = engine;
}

/** 旧的布尔式运行时覆盖。保留兼容：true → inproc，false → binary。 */
export function setPiInProcEnabled(enabled: boolean | null): void {
  runtimeOverride = enabled === null ? null : enabled ? "inproc" : "binary";
}

/** 单测注入点（三值）。传 null 复位。 */
export function __setPiEngineForTests(engine: PiEngineKind | null): void {
  testOverride = engine;
}

/** 旧的布尔式单测注入。保留兼容，既有用例无需改写。 */
export function __setPiInProcEnabledForTests(enabled: boolean | null): void {
  testOverride = enabled === null ? null : enabled ? "inproc" : "binary";
}

/** 单测复位：同时清掉运行时覆盖，避免跨用例串状态。 */
export function __resetPiFeatureFlagForTests(): void {
  testOverride = null;
  runtimeOverride = null;
}
