// 失效信号 → React Query invalidation 的静态映射表(信封归一方案 P1)。
//
// 主进程 ipc/sync-invalidate.ts 广播 {scope, hint};本表是渲染端「scope 该失效哪些 key」的
// 唯一事实。新增失效域只需:主进程扩 SyncInvalidateScope 联合 + 本表加一行,不动 preload /
// DesktopBridge 契约。表中动作只做 invalidate(信号语义),不得 setQueryData 塞数据——
// 数据推送语义的通道(workflow/automation/roles/memory)不走本表。
//
// 与 tasks.ts / notes.ts 的 key 工厂存在函数调用期的循环 import(与 subagent-stream 同款
// 判例):双方模块求值期互不解引用,ESM live binding 下安全。

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { useDesktopBridge } from "../provider";
import type { SyncInvalidateScope } from "../desktop/types";
import { jobTypesKey, membersKey, stageTemplatesKey, tasksKeys } from "./tasks";
import { notesKeys } from "./notes";

/** scope → 失效动作。satisfies 锚定联合类型:主进程加域、这里漏加行 → 编译期报错。 */
const SYNC_INVALIDATE_ACTIONS = {
  tasks: (qc) => {
    qc.invalidateQueries({ queryKey: tasksKeys.all });
    qc.invalidateQueries({ queryKey: tasksKeys.projects });
  },
  "task-resources": (qc) => {
    qc.invalidateQueries({ queryKey: membersKey });
    qc.invalidateQueries({ queryKey: jobTypesKey });
    qc.invalidateQueries({ queryKey: stageTemplatesKey });
  },
  notes: (qc) => {
    qc.invalidateQueries({ queryKey: notesKeys.all });
  },
} satisfies Record<SyncInvalidateScope, (qc: QueryClient) => void>;

/**
 * 订阅单个失效域(工作区/视图根部挂载一次)。同一 scope 多处挂载是幂等的:
 * invalidate 本身幂等,重复触发只多一次 no-op 检查。
 */
export function useSyncScopeSubscription(scope: SyncInvalidateScope): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge?.onSyncInvalidate) return;
    return bridge.onSyncInvalidate((incoming) => {
      if (incoming !== scope) return;
      SYNC_INVALIDATE_ACTIONS[scope]?.(qc);
    });
  }, [bridge, qc, scope]);
}
