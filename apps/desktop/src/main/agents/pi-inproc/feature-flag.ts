// pi 执行形态的灰度开关（迁移计划 R3 / KTD6）。
//
// 为什么需要它：in-process 引擎层与 `pi-rpc.ts`（bun 二进制 + spawn）在整个迁移期**并存**，
// 由这一个开关选路。任何一个阶段出问题都能一键退回二进制路径，而不必回滚代码。
// **默认关闭**——没有显式打开时，行为与迁移前逐字一致。
//
// 优先级（高 → 低）：
//   1. 单测注入（`__setPiInProcEnabledForTests`）
//   2. 运行时覆盖（`setPiInProcEnabled`，供设置页/IPC 后续接线，不必重启）
//   3. 环境变量 `CORTEX_PI_INPROC`
//   4. 默认关（二进制路径）
//
// 刻意**不**在这里读持久化设置：读设置是异步的，而选路点（`pi:open`）需要同步判定；
// 让宿主在启动时把设置值 push 进 `setPiInProcEnabled()` 即可，方向单一、无隐式 IO。

/** 引擎种类。`binary` = 现有 `pi --mode rpc` 子进程；`inproc` = 主进程内 `AgentSession`。 */
export type PiEngineKind = "inproc" | "binary";

/** 选路结果 + 来源，供日志/诊断定位「为什么走了这条路」。 */
export interface PiEngineChoice {
  engine: PiEngineKind;
  /** 判定来源：test / override / env / default。 */
  source: "test" | "override" | "env" | "default";
}

/** 控制开关的环境变量名。与其它 CORTEX_* 主进程调试开关同族。 */
export const PI_INPROC_ENV_FLAG = "CORTEX_PI_INPROC";

let testOverride: boolean | null = null;
let runtimeOverride: boolean | null = null;

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
  if (testOverride !== null) return { engine: testOverride ? "inproc" : "binary", source: "test" };
  if (runtimeOverride !== null) return { engine: runtimeOverride ? "inproc" : "binary", source: "override" };
  const fromEnv = parseBoolFlag(env[PI_INPROC_ENV_FLAG]);
  if (fromEnv !== undefined) return { engine: fromEnv ? "inproc" : "binary", source: "env" };
  return { engine: "binary", source: "default" };
}

/** 是否走 in-process 引擎。默认 false（二进制路径）。 */
export function isPiInProcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePiEngineChoice(env).engine === "inproc";
}

/**
 * 运行时覆盖开关（宿主把持久化设置 push 进来时调用）。传 null 交回环境变量/默认判定。
 * 只影响**之后新建**的会话：已建立的会话不会中途换引擎（换引擎等于换进程边界，无法热切）。
 */
export function setPiInProcEnabled(enabled: boolean | null): void {
  runtimeOverride = enabled;
}

/** 单测注入点。传 null 复位。 */
export function __setPiInProcEnabledForTests(enabled: boolean | null): void {
  testOverride = enabled;
}

/** 单测复位：同时清掉运行时覆盖，避免跨用例串状态。 */
export function __resetPiFeatureFlagForTests(): void {
  testOverride = null;
  runtimeOverride = null;
}
