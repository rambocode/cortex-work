// Computer Use 的 **in-process 注入适配层**：把 inject.ts 的五门控决策翻译成
// in-process 引擎（`PiInProcDeps`）能吃的形状。
//
// ── 与旧路径的对应关系 ────────────────────────────────────────────────────────
//   旧（spawn pi 二进制）：`-e <包目录>` 传路径 + spawn env 传 grounding 模型。
//   新（in-process）：`PiInProcDeps.additionalExtensionPaths` 传同一个路径
//                     + 主进程 `process.env` 写同一个变量。
//
// `additionalExtensionPaths` 是 pi SDK 里 CLI `-e` 的**字面对应物**（实测：
// `dist/main.js:530` 把 `-e` 解析出的路径原样塞进 `resourceLoaderOptions.additionalExtensionPaths`），
// 最终经 `DefaultResourceLoader` → `PackageManager.resolveExtensionSources(..., {temporary:true})`
// → `loadExtensionsCached()`（jiti）加载。所以这里**不需要**、也刻意**不**自己实现任何加载器：
// pi-computer-use 的入口是 `src/index.ts`（TypeScript，见其 package.json 的 `pi.extensions`），
// 主进程被打成 CJS，自己 `import()` 一个 .ts 文件根本跑不起来；只有 SDK 那条 jiti 链路能加载它。
//
// 引擎层恒开 `noExtensions: true`（只注入 Cortex 自己那批能力，绝不自动执行用户目录里的任意扩展）。
// 这与显式路径**不冲突**：SDK 的 `noExtensions` 只屏蔽「自动发现」，
// `additionalExtensionPaths` 解析出的那批照常加载（resource-loader.js:270 / :354）。
//
// ── 安全边界（与 inject.ts 一致，逐条不变）────────────────────────────────────
//   1. 五门控的判定**完全**委托给 `resolveComputerUse()`，本文件一条都不复制、不放宽。
//      （inproc.test.ts 有一条读源码的守卫断言这一点。）
//   2. 注入点仍然只有 `ipc/pi-session.ts` 的 `preparePiOpenRequest()` 一处 —— 本文件不改变
//      这个事实，也刻意**不**提供任何「顺手在单发/无人值守路径注入」的便利入口。
//      单发路径（`agents/pi.ts` / `ipc/cli.ts`）与定时任务（`automation/runner.ts`）没有审批 UI，
//      在那里放开鼠标键盘等于让 Agent 无监督操作用户电脑。
//   3. `gui_*` 写工具的审批由 `core/personal/permissionMode.ts` 判定、由审批 hook 执行，
//      本文件不参与也不绕过 —— 详见下方「与审批 hook 的协同」。
//
// ── 与审批 hook 的协同（本次迁移最容易出漏洞的接缝）──────────────────────────
// in-process 后，审批 hook 是一个 **inline extension**（经 `PiInProcDeps.extensionFactories`
// 注册 `pi.on("tool_call", …)`），而 `gui_*` 工具来自这里注入的**磁盘 extension**。两者
// 分属不同 extension，会不会互相看不见？实测结论：不会，且必然拦得到 ——
//   · `AgentSession._installAgentToolHooks()` 把 `agent.beforeToolCall` **装在 Agent 上一次**，
//     对**每一次**工具调用生效，与「这个工具由谁注册」无关；
//   · 它转发给 `ExtensionRunner.emitToolCall()`，后者遍历**同一个 runner 里的全部 extension**
//     的 `tool_call` 处理器，任一返回 `{ block: true }` 立即短路阻断；
//   · 磁盘 extension 与 inline factory extension 进的是**同一个 runner**：
//     `DefaultResourceLoader.loadFinalExtensionSet()` 先按路径加载磁盘扩展拿到 `runtime`，
//     再用**同一个** `runtime` 加载 `extensionFactories`，两批 extension 合进同一个结果集。
// 所以只要 `permissionMode.ts` 把 `gui_*` 放进了 approvalTools（Computer Use 开启时无条件放，
// 含「自动执行」档），审批 hook 就一定会在 `gui_*` 执行前拿到 `tool_call` 事件。
//
// ── 失败一律降级为「本轮不注入」，绝不让会话起不来（KTD5）────────────────────
// in-process 没有子进程退出码，失败是静默的。两类失败分开处理：
//   · 决策阶段抛错（读设置 / 探测权限）→ 本文件 catch 住、warn、返回空路径；
//   · 加载阶段失败（jiti 编译错、依赖缺失）→ 由 SDK 收进 `extensionsResult.errors` 而**不抛**，
//     表现为「gui_* 工具压根不存在」。这种沉默最难查，故导出 `reportComputerUseLoadErrors()`
//     供集成侧在建会话后调用，把属于本包的加载错误打成 warn 日志留痕。
// 两种情况下「降级」都是自然安全的：工具不存在 → Agent 不知道有这个能力 → 行为退回从前；
// 而 approvalTools 里那些 `gui_*` 名字永不命中，不会平白多出审批弹窗。

import { createLogger } from "../../log";
import type { ComputerUseBlockReason, ComputerUseSettings } from "../../ipc/types";
import { GROUNDING_MODEL_ENV, resolveComputerUse } from "./inject";

const log = createLogger("computer-use");

/** 该 package 在磁盘上的目录名，用于把加载错误归因到「是不是我们注入的这个包」。 */
const PACKAGE_DIR_NAME = "pi-computer-use";

/** in-process 注入决策的产物：可直接铺进 `PiInProcDeps`。 */
export interface ComputerUseInprocInjection {
  /**
   * 直接赋给 `PiInProcDeps.additionalExtensionPaths`。
   * 空数组 = 本轮不注入（门控未过 / 决策抛错），**不是**错误，调用方无需特殊处理。
   */
  additionalExtensionPaths: string[];
  /** 不注入的原因（`additionalExtensionPaths` 为空时可能有值），供设置页展示与日志。 */
  reason?: ComputerUseBlockReason;
  /**
   * 本轮实际写进主进程 `process.env` 的变量快照（只读，供测试与日志）。
   * 单独列出来是因为 `PiInProcDeps` 没有 env 槽 —— in-process 没有子进程可传 env，
   * 只能改本进程的 `process.env`，这一步已由本函数就地完成，调用方不必再做。
   */
  env: Record<string, string>;
}

/**
 * 产出 Computer Use 的 in-process 注入决策，并就地生效 grounding 模型环境变量。
 *
 * 五门控的判定原样委托给 `resolveComputerUse()` —— 本函数只负责「决策为注入之后怎么接上去」。
 *
 * @param settings 当前 Computer Use 设置快照（`generalSettings.computerUse` 原始切片）
 */
export async function resolveComputerUseInproc(
  settings: ComputerUseSettings | undefined,
): Promise<ComputerUseInprocInjection> {
  try {
    const resolution = await resolveComputerUse(settings);
    if (!resolution.path) {
      // 门控未过：**不动 env**。理由见 applyGroundingEnv 的注释（进程级变量是全局的，
      // 本轮不注入不代表别的在跑的会话也不该有 grounding 模型）。
      return { additionalExtensionPaths: [], reason: resolution.reason, env: {} };
    }

    const env = applyGroundingEnv(resolution.env);
    return { additionalExtensionPaths: [resolution.path], env };
  } catch (e) {
    // 与旧路径 `pi-session.ts` 里 `resolveComputerUse` 失败时「本轮不注入、只 warn」语义一致。
    // 决策失败绝不能冒泡把会话打挂 —— 没有 Computer Use 的会话仍然完全可用。
    log.warn(`Computer Use in-process 注入决策失败,本轮不注入: ${String(e)}`);
    return { additionalExtensionPaths: [], env: {} };
  }
}

/**
 * 把 grounding 模型写进**主进程**的 `process.env`，返回实际生效的快照。
 *
 * 为什么是进程级全局而不是每会话隔离：
 *   · pi-computer-use 在 grounding 时直读 `process.env.PI_COMPUSE_GROUNDING_MODEL`
 *     （见该包 src/index.ts 的 createResolver），in-process 后没有子进程边界可以隔离；
 *   · 该值来自**单一全局设置** `generalSettings.computerUse.groundingModel`，
 *     旧路径下所有会话本来也是同一个值，所以进程级共享不引入新的行为差异。
 * 唯一可感知的差异：用户改完设置后，**已在跑**的会话也会立刻用上新值
 *（旧路径只影响新开的会话）。这个方向是更符合直觉的，故不做额外补偿。
 *
 * 「用户清空设置」必须真的能清掉：只写不删会让上一轮的模型名永久粘住 —— 用户把输入框清空、
 * 期望回退到会话模型，实际却仍打在旧模型上，且没有任何提示。所以注入轮里空值 = 显式 delete。
 * 反之，门控未过的轮次**不**碰 env（见调用处）：那不是「用户清空了配置」，
 * 不该顺手把别的活跃会话的 grounding 模型抹掉。
 */
function applyGroundingEnv(env: Record<string, string>): Record<string, string> {
  const value = env[GROUNDING_MODEL_ENV];
  if (value) {
    process.env[GROUNDING_MODEL_ENV] = value;
    return { [GROUNDING_MODEL_ENV]: value };
  }
  delete process.env[GROUNDING_MODEL_ENV];
  return {};
}

/** 一条 extension 加载错误（结构类型，避免为了它去 import 纯 ESM 的 pi 类型）。 */
export interface ExtensionLoadError {
  path: string;
  error: string;
}

/**
 * 从 SDK 的 `extensionsResult.errors` 里挑出属于 pi-computer-use 的条目并打日志留痕。
 *
 * 为什么必须有这一步：SDK 加载 extension 失败时**不抛**，只把错误收进 `errors` 数组，
 * 会话照常建起来、只是 `gui_*` 工具悄悄不存在（KTD5：in-process 后失败是静默的）。
 * 不留痕的话，用户看到的是「电脑操作没反应」，而日志里一片干净、无从下手。
 *
 * 只 warn 不抛：降级本身是安全且期望的行为 —— 工具不存在 → Agent 不知道有这个能力 →
 * 退回没有 Computer Use 的从前，会话不受影响。
 *
 * @returns 属于本包的错误条数（0 表示加载正常或本轮压根没注入）
 */
export function reportComputerUseLoadErrors(errors: readonly ExtensionLoadError[] | undefined): number {
  if (!errors?.length) return 0;
  const mine = errors.filter((e) => isComputerUseExtensionPath(e.path));
  for (const e of mine) {
    log.warn(`Computer Use 扩展加载失败,本会话无 gui_* 工具（已降级为不可用）: ${e.path} —— ${e.error}`);
  }
  return mine.length;
}

/**
 * 判断一条路径是否属于 pi-computer-use 包。
 *
 * 与 `install.ts` 的 `findComputerUsePath` 同款「路径含包名」判定：SDK 报回来的是
 * **清单展开后**的入口文件路径（如 `<包目录>/src/index.ts`），而不是我们传进去的目录路径，
 * 所以不能用等值比较。
 */
export function isComputerUseExtensionPath(path: string): boolean {
  return new RegExp(`(^|/)${PACKAGE_DIR_NAME}($|/)`).test(path);
}
