// worker 侧的能力组装：把 `PiOpenRequest` 翻译成 `PiInProcDeps`。
//
// 本文件是 `ipc/pi-session.ts` 的 `buildInProcDeps()` 的 **worker 侧同构版**。
// 为什么不能直接 import 那个函数：它所在的文件顶层 `import { app, ipcMain } from "electron"`
// 并注册了十几个 `ipcMain.handle`，整个模块在 worker 里根本加载不起来。
// 但**它调用的那几个能力模块全是纯逻辑**，一个都不用重写：
//   · `agents/pi-inproc/native-hooks.ts` → 审批 hook / todo / askquestion / 样例
//   · `agents/pi-mcp-inproc.ts`          → MCP 桥（stdio spawn + http fetch 全在 worker 里跑）
//   · `agents/pi-inproc/session.ts`      → `openPiInProcSession`（由 host.ts 调用）
// 唯一被迫在 worker 侧重做的是模型解析（见 `model.ts` 文件头）。
//
// ── Computer Use 为什么这里看不到 ─────────────────────────────────────────────────────
// 它的五门控判定（读设置 / 探测系统权限 / 定位 `~/.pi` 里的包）依赖主进程能力，
// 已经在主进程的 `preparePiOpenRequest()` 里跑完，结论以两个字段随 open 参数发过来：
//   · `inProcExtensionPaths` → 磁盘 extension 路径，与市场扩展合并后交给 SDK 的 jiti 链路；
//   · `computerUseEnv`       → grounding 模型环境变量。
// ⚠️ 第二个字段**必须由本文件写进 worker 自己的 `process.env`**：
// `capabilities/computer-use/inproc.ts` 的 `applyGroundingEnv()` 写的是**调用方进程**的 env，
// 在 gateway 形态下那是主进程，而真正读它的 `pi-computer-use` 跑在 worker 里。
// 漏了这一步的表现是「电脑操作能用，但 grounding 模型设置静默失效」——没有任何报错。
//
// ── 安全红线（原样承接 origin 计划，**不要重新发明**）────────────────────────────────
//  1. `gui_*` 写工具在「自动执行」档仍强制进审批集：判定在 `core/personal/permissionMode.ts`，
//     本层只执行——`approvalTools` 里出现 `gui_click` 等名字，照单命中，不过滤不豁免。
//  2. 审批 hook 必须是 `pi.on("tool_call")` 的 extension 级处理器（`native-hooks.ts` 保证），
//     不能退化成只包自家 `customTools` 的 wrapper——那样拦不到磁盘 extension 注册的 `gui_*`，
//     且**没有任何报错**。这里唯一要做对的是：把 hook 经 `extensionFactories` 交出去。
//  3. 无 UI 出口时语义是「**放行 + 留痕**」，不是「全部 block」。gateway 下 pi 的 `ctx.hasUI`
//     与 in-process 一样恒为 true（uiContext 总被 rebind 传进去），照抄旧判据会让语义反转。
//     故 `hasUiOutlet` 必须由 host 如实注入（有 uiRequest 通道 = true）。

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { PiInProcDeps } from "../../main/agents/pi-inproc";
import { createPiNativeHooks, type PiApprovalRecord } from "../../main/agents/pi-inproc/native-hooks";
import { createMcpInProcTools } from "../../main/agents/pi-mcp-inproc";
import type { PiOpenRequest } from "../../main/ipc/types";
import { createLogger } from "./log";

const log = createLogger("pi-host-capabilities");

export interface WorkerCapabilityContext {
  /**
   * 本会话是否真有一条能走到用户眼前的 UI 出口（安全红线 3）。
   * 由 host 按「协议对端是否会转 `uiRequest`」如实给出，绝不硬编码。
   */
  hasUiOutlet: () => boolean;
  /**
   * RPC-backed 凭据仓（KTD1）。本文件当前不直接消费它——它经 `resolveModel` 注入 `ModelRuntime`。
   * 仍然摆在 ctx 上，是因为自定义 Provider 的 `${secret:NAME}` 解析（U3-providers）迟早要用它，
   * 到那时不必再改本模块的签名；单测也靠它驱动一次真实的凭据往返。
   */
  credentials: CredentialStore;
  /** 模型/Provider 解析器（`model.ts` 产出，可被 U3-providers 换成更全的实现）。 */
  resolveModel: PiInProcDeps["resolveModel"];
  /** 审批留痕出口。缺省走 worker 日志（→ 主进程落盘）。 */
  onApprovalDecision?: (record: PiApprovalRecord) => void;
}

/**
 * 组装本次会话的 `PiInProcDeps`。
 *
 * 返回的 `onDispose` 会由引擎在 `stop()` 里统一调用（`PiInProcSession.stop()` 内部收口），
 * 释放 MCP 的 stdio 子进程与在途 HTTP。worker 退出会连带杀掉子进程，但**不能靠这一点**：
 * `switch_session` / `new_session` 不换进程，漏调就是连接一路累积。
 */
export async function buildWorkerDeps(
  prepared: PiOpenRequest,
  ctx: WorkerCapabilityContext,
): Promise<PiInProcDeps> {
  applyComputerUseEnv(prepared.computerUseEnv);

  const hooks = createPiNativeHooks({
    ...(prepared.enableToolApproval !== undefined ? { enableToolApproval: prepared.enableToolApproval } : {}),
    ...(prepared.approvalTools ? { approvalTools: prepared.approvalTools } : {}),
    hasUiOutlet: ctx.hasUiOutlet,
    uiSessionId: prepared.uiSessionId,
    ...(prepared.enableSampleTools !== undefined ? { enableSampleTools: prepared.enableSampleTools } : {}),
    ...(prepared.enableSampleCommands !== undefined
      ? { enableSampleCommands: prepared.enableSampleCommands }
      : {}),
    ...(prepared.askQuestionSentinel ? { askQuestionSentinel: prepared.askQuestionSentinel } : {}),
    onApprovalDecision: ctx.onApprovalDecision ?? defaultApprovalSink,
  });

  const { tools: mcpTools, dispose: disposeMcp } = await buildMcpTools(prepared.bridgeServers ?? []);

  // 磁盘 extension 的两个来源合并成一个槽（与主进程版逐字一致）：
  // Computer Use（按五门控注入的第三方包）与扩展市场里用户自装的扩展
  // （已过 UI 信任门 + `filterLoadableExtensionPaths` 的库存根闸）。
  //
  // ✅ gateway 相对 in-process 的**安全回退修复**：in-process 下这些扩展与主进程同址，
  // 理论上能 `require("electron")` 摸到 app / session / safeStorage；挪进 worker 后它们
  // 只剩文件系统与网络（本 worker 的 electron 模块本身就是个会抛错的 stub）。
  const diskExtensionPaths = [...(prepared.inProcExtensionPaths ?? []), ...(prepared.extensionPaths ?? [])];
  if (diskExtensionPaths.length) {
    log.info(`本会话加载 ${diskExtensionPaths.length} 个磁盘 extension（worker 进程内，与主进程隔离）`);
  }

  return {
    ...(ctx.resolveModel ? { resolveModel: ctx.resolveModel } : {}),
    customTools: [...hooks.customTools, ...mcpTools],
    extensionFactories: hooks.extensionFactories,
    ...(diskExtensionPaths.length ? { additionalExtensionPaths: diskExtensionPaths } : {}),
    onDispose: disposeMcp,
  };
}

/** MCP 桥。单 server 失败只跳过该 server（桥内部保证不抛），整体失败才降级为无桥。 */
async function buildMcpTools(
  servers: NonNullable<PiOpenRequest["bridgeServers"]>,
): Promise<{ tools: ToolDefinition[]; dispose: () => Promise<void> }> {
  if (!servers.length) return { tools: [], dispose: async () => {} };
  try {
    const bridge = await createMcpInProcTools(servers);
    if (bridge.failed.length) {
      log.warn(`MCP 接入失败 ${bridge.failed.length} 个: ${bridge.failed.map((f) => f.id).join("、")}`);
    }
    return { tools: bridge.tools, dispose: () => bridge.dispose() };
  } catch (e) {
    log.warn(`MCP 桥整体失败，本会话无 MCP 工具: ${String(e)}`);
    return { tools: [], dispose: async () => {} };
  }
}

/**
 * 把主进程算好的 Computer Use 环境变量写进 **worker** 的 `process.env`（见文件头）。
 *
 * 「用户清空设置」必须真的能清掉：只写不删会让上一轮的模型名永久粘住。语义与
 * `capabilities/computer-use/inproc.ts` 的 `applyGroundingEnv` 一致——
 * 空值 = 显式 delete；**没有这个字段**（undefined）= 本轮门控未过，一个字节都不碰
 *（进程级变量是全局的，本轮不注入不代表要把别的状态抹掉）。
 */
function applyComputerUseEnv(env: PiOpenRequest["computerUseEnv"]): void {
  if (!env) return;
  for (const [key, value] of Object.entries(env)) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
}

/**
 * 默认审批留痕。
 *
 * `skipped`（无 UI 出口时的放行）与 `failed`（审批流程本身异常）必须是 warn：
 * 前者是「有工具在无人值守下被免审执行」，事后追责全靠这条；后者是 fail-closed 的证据。
 */
function defaultApprovalSink(record: PiApprovalRecord): void {
  const line = `工具审批 ${record.toolName} → ${record.decision}${record.reason ? `（${record.reason}）` : ""}`;
  if (record.decision === "skipped" || record.decision === "failed") log.warn(line, { detail: record.detail });
  else log.info(line);
}
