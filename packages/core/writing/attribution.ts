// 写作工作区「agent 改动归因」(U9):把两路「文件被改」信号归因为三类动作,是 agent 写盘 →
// 编辑器 diff 审阅回路的判定核心。两路信号——
//   ① writing: run 的 tool 事件:解析 Edit/Write 工具 input 里的 file_path(claude/codex 可靠;
//      pi 的 detail 字符串不带结构化路径,整体退化到 ② 的 hash 兜底);
//   ② fs:watchDir 的 dirChanged(无路径):只能知道「空间里有东西变了」,不知是哪个文件。
//
// 为什么需要归因:watch 只给无路径信号,无法直接区分「agent 改了当前文件」/「外部程序改了」/
// 「agent 改了别的文件」。判定顺序(KTD「agent 改动归因 = tool 事件优先 + 基线 hash 兜底」):
//   1) 自写回声(baseline.isSelfEcho):本端自动保存 / 裁决落盘的 watch 回声 → 忽略;
//   2) tool 事件带路径命中当前文件,或 run 活跃期(含 cli:exit 后 EXIT_TAIL_MS 尾窗)dirChanged 且
//      当前文件重读 ≠ 基线 → agent 改动:冻结自动保存 + beginReview(基线, 盘上新内容);
//   3) run 非活跃期的差异 → 外部改动(交编辑器句柄:干净静默刷新 / 脏冲突审阅);
//   4) tool 路径命中非当前文件 → 仅刷新文件树(一期不做未打开文件的跨文件 diff)。
//
// 「基线取 agent 写盘时刻编辑器内容」由磁盘基线语义吸收:run 期间用户继续编辑经自动保存推进基线,
// beginReview 用当时的基线做 diff original,用户 run 期间的编辑体现在 diff 中由用户逐块裁决。
//
// 控制器是纯逻辑(handleCliEvent / handleCliExit / handleDirChanged 由 WritingWorkspace 订阅并转发),
// 不直接触碰 bridge,readFile / 各动作均经注入回调——便于脱离 React/bridge 确定性单测。

import { getBaseline, isSelfEcho } from "./baseline";
import { isWritingRunId } from "./run/writing-run-manager";
import type { CliExitEvent, CliStreamEvent } from "../desktop/types";

// cli:exit 后仍把迟到 dirChanged 归因 agent 的尾窗(ms)。覆盖 watch 250ms 去抖 + 进程收尾抖动,
// 避免「agent 刚退出、watch 去抖后才推的 dirChanged」被误判成外部改动。
export const EXIT_TAIL_MS = 2000;

// 写文件类工具名匹配:claude 的 Edit / Write / MultiEdit,codex 的 file_change / patch_apply 归一为 "Edit"。
// 只对写工具解析路径——Read / Grep 等也带 file_path,若不过滤会把「agent 读当前文件」误判成改动。
const WRITE_TOOL_NAME = /edit|write/i;

// 归因动作回调(由 WritingWorkspace 注入,连到 review-manager / 编辑器句柄 / 文件树刷新)。
export interface WritingAttributionCallbacks {
  // 当前编辑器打开文件绝对路径(null=无打开文件)。经 getter 读最新值(避免闭包捕获过期路径)。
  getCurrentFile: () => string | null;
  // 读某文件盘上内容(经注入的 bridge.readFile;失败时 reject)。
  readFile: (path: string) => Promise<string>;
  // 判定为 agent 改动:冻结自动保存 + beginReview(基线, 盘上新内容)。
  onAgentChange: (info: { path: string; baseline: string; disk: string }) => void;
  // 判定为外部改动:交编辑器句柄自行判定干净静默刷新 / 脏冲突审阅。
  onExternalChange: () => void;
  // agent 改了「非当前打开文件」:仅刷新文件树。
  onTreeRefresh: (path: string) => void;
}

// 控制器对外接口:三个信号入口 + dispose(卸载时停止后续回调)。
export interface WritingAttributionController {
  // 转发一条 writing: run 的 CLI 事件(WritingWorkspace 从 bridge.onCliEvent 转发)。
  handleCliEvent: (runId: string, event: CliStreamEvent) => void;
  // 转发一次 writing: run 退出(开启尾窗)。
  handleCliExit: (exit: CliExitEvent) => void;
  // 转发一次目录变化(无路径),触发当前文件重读归因。
  handleDirChanged: () => void;
  // 卸载:标记 disposed,后续所有入口成为 no-op,清空运行态。
  dispose: () => void;
}

// 从一条 tool 事件解析写文件目标路径;非写工具 / 无路径返回 null。
// 兼容 file_path(claude)/ path(codex)/ filePath 三种键。
function extractWriteToolPath(event: CliStreamEvent): string | null {
  if (event.type !== "tool") return null;
  if (!WRITE_TOOL_NAME.test(event.name)) return null;
  const input = event.input;
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const fp = obj.file_path ?? obj.path ?? obj.filePath;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
}

// 创建一个归因控制器。exitTailMs / now 可注入便于确定性单测(now 用可控时钟替代 Date.now)。
export function createWritingAttribution(
  cb: WritingAttributionCallbacks,
  options: { exitTailMs?: number; now?: () => number } = {},
): WritingAttributionController {
  const exitTailMs = options.exitTailMs ?? EXIT_TAIL_MS;
  const now = options.now ?? ((): number => Date.now());

  // 在跑的 writing: run 集合;非空即 agent 活跃。
  const activeRuns = new Set<string>();
  // 全部 run 退出后的尾窗截止时刻(0=无尾窗)。尾窗内到达的 dirChanged 仍归因 agent。
  let tailUntil = 0;
  let disposed = false;

  // agent 是否活跃:有 run 在跑,或处于 cli:exit 尾窗内。
  const agentActive = (): boolean => activeRuns.size > 0 || now() <= tailUntil;

  // 评估「当前打开文件」是否被改及归因。forceAgent=true(写工具命中当前文件)时,即便 run 活跃态
  // 因事件时序尚未更新也恒判 agent。异步读盘期间若已 dispose 则中止,避免卸载后仍回调。
  const evaluateCurrentFile = async (forceAgent: boolean): Promise<void> => {
    const path = cb.getCurrentFile();
    if (!path) return;
    let disk: string;
    try {
      disk = await cb.readFile(path);
    } catch {
      // 读盘失败(可能刚被删 / 瞬时锁):忽略此信号,交其它信号或用户手动处理。
      return;
    }
    if (disposed) return;
    // ① 自写回声:盘上内容 = 本端上次所写 → 忽略(不刷新 / 不审阅)。
    if (isSelfEcho(path, disk)) return;
    const bl = getBaseline(path);
    // ② 与基线一致:外部信号但内容没变,忽略。
    if (bl && bl.content === disk) return;
    if (forceAgent || agentActive()) {
      // ③ agent 改动:基线取写盘时刻的磁盘基线(= diff original),新版为盘上内容。
      cb.onAgentChange({ path, baseline: bl?.content ?? "", disk });
    } else {
      // ④ run 非活跃期的差异 → 外部改动(编辑器句柄自判干净刷新 / 脏冲突)。
      cb.onExternalChange();
    }
  };

  // 处理一条写工具路径:命中当前文件 → 当前文件归因(恒 agent);否则仅刷新文件树。
  const handleToolPath = (toolPath: string): void => {
    const current = cb.getCurrentFile();
    if (current && toolPath === current) {
      void evaluateCurrentFile(true);
    } else {
      cb.onTreeRefresh(toolPath);
    }
  };

  return {
    handleCliEvent: (runId, event): void => {
      if (disposed || !isWritingRunId(runId)) return;
      // 收到任一 writing: 事件即视为该 run 活跃(init 会最先到,tool/text 随后)。
      activeRuns.add(runId);
      const toolPath = extractWriteToolPath(event);
      if (toolPath) handleToolPath(toolPath);
    },

    handleCliExit: (exit): void => {
      if (disposed || !isWritingRunId(exit.runId)) return;
      activeRuns.delete(exit.runId);
      // 全部 run 退出后开尾窗:覆盖 watch 去抖导致的迟到 dirChanged 仍归因 agent。
      if (activeRuns.size === 0) tailUntil = now() + exitTailMs;
    },

    handleDirChanged: (): void => {
      if (disposed) return;
      // dirChanged 无路径:只能重读当前文件比对基线,活跃期判 agent、否则外部。
      void evaluateCurrentFile(false);
    },

    dispose: (): void => {
      disposed = true;
      activeRuns.clear();
      tailUntil = 0;
    },
  };
}
