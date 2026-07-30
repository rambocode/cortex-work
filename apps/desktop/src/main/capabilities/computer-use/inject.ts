// Computer Use 注入决策的唯一入口（对照 capabilities/knowledge/inject.ts 的形状）。
//
// 五门控，缺任一条都返回 null（整包不注入）：
//   1. 平台是 macOS（该 package 只支持 mac）；
//   2. 总开关未被显式关闭（缺省 = 开，产品决策：默认开箱即用）；
//   3. package 已装好且落盘路径仍在；
//   4. swiftc 可用（要现编原生 GUI helper，编不出来所有 gui_* 全废）；
//   5. 辅助功能 + 屏幕录制两项 TCC 授权都已 granted。
//
// 为什么必须门控到这个程度：给 Agent 一套必然失败的 gui_* 工具比不给更糟——它会反复重试、
// 把整轮对话烧掉，而用户只看到「电脑操作坏了」。不注入的话 Agent 压根不知道有这个能力，
// 行为退回从前。（同 knowledge/inject.ts:15-17、research/inject.ts:9-11）
//
// ⚠️ 与市场扩展的威胁模型差异：本函数返回的路径走 PiOpenRequest.extraExtensionPaths，
// **不经** pi-session.ts 的 filterLoadableExtensionPaths（~/.pi 库存根闸）。这是安全的，
// 因为路径来自本进程写的 marker（install.ts）而非用户可改的 settings.json——市场那条路要设闸，
// 正是因为 settings 可被外部篡改、把 -e 指向 ~/.ssh/id_rsa 之类。
//
// ⚠️ 刻意**不**接 cli.ts 的 builtinServers 数组：
//   · 它不是 MCP server，是 pi extension，形状压根不同；
//   · 按产品决策只在聊天（RPC）路径生效。单发路径（ask 追问 / 定时任务 / 编排子会话）没有
//     审批 UI，审批 hook 在那里失效——在无人看着的定时任务里放开鼠标键盘，等于让 Agent
//     无监督地操作用户电脑。后来者若照 knowledge 的模式把这里也加进 builtinServers，
//     就会打开这个缺口。

import { createLogger } from "../../log";
import type { ComputerUseBlockReason, ComputerUseSettings } from "../../ipc/types";
import { hasScreenPermissions, hasSwiftc } from "./env";
import { peekComputerUsePackage } from "./install";

const log = createLogger("computer-use");

/** pi-computer-use 读的 grounding 模型环境变量名（见该包 src/index.ts 的 createResolver）。 */
export const GROUNDING_MODEL_ENV = "PI_COMPUSE_GROUNDING_MODEL";

export interface ComputerUseResolution {
  /** 可注入时为扩展目录绝对路径；不可注入为 null。 */
  path: string | null;
  /** 不可注入的原因（path 为 null 时有值），供设置页展示与日志。 */
  reason?: ComputerUseBlockReason;
  /** 需要额外注入 pi 子进程的环境变量（当前只有 grounding 模型）。 */
  env: Record<string, string>;
}

/**
 * 逐条走五门控，产出注入决策。
 *
 * @param settings 当前 Computer Use 设置快照（来自 getPersistedState 的原始切片）
 */
export async function resolveComputerUse(
  settings: ComputerUseSettings | undefined,
): Promise<ComputerUseResolution> {
  const blocked = (reason: ComputerUseBlockReason): ComputerUseResolution => {
    log.debug(`不注入 Computer Use：${reason}`);
    return { path: null, reason, env: {} };
  };

  if (process.platform !== "darwin") return blocked("not-macos");
  // 缺省视为启用——只有显式 false 才算用户关掉了。
  if (settings?.enabled === false) return blocked("disabled");

  // 只读探测，不在开会话的关键路径上触发 npm 安装（预装在 whenReady 的后台跑）。
  const path = peekComputerUsePackage();
  if (!path) return blocked("not-installed");

  if (!(await hasSwiftc())) return blocked("no-swiftc");

  const perms = await hasScreenPermissions();
  if (!perms.accessibility) return blocked("no-accessibility");
  if (!perms.screenRecording) return blocked("no-screen-recording");

  const env: Record<string, string> = {};
  // 「GUI 定位模型」：留空则该 package 回退用当前会话模型，而会话模型若没勾「支持图片输入」
  // 就会抛错（见 core/desktop/types.ts 的 groundingModel 注释）。这里只负责如实传递用户的选择，
  // 不替用户猜——猜错会让定位调用悄悄跑到一个不预期的（可能更贵的）模型上。
  const grounding = settings?.groundingModel?.trim();
  if (grounding) env[GROUNDING_MODEL_ENV] = grounding;

  log.debug(`注入 Computer Use：${path}${grounding ? `（定位模型 ${grounding}）` : ""}`);
  return { path, env };
}
