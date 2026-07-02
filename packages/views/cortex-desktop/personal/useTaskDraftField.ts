// 受控草稿守卫（U1 / KTD6）：修复中列 ↔ 右列 ↔ 主窗口右列 的 title/notes 编辑不同步缺陷。
//
// 缺陷根因：title/notes 各站点持有「仅按 task.id 冻结」的本地草稿——切任务才重置，
// 同一任务内一侧编辑落库后，另一侧因草稿挡掉合法外部更新而不刷新。结构化字段（状态/日期/
// 标记）直读 prop 无本地副本，本就随 React Query 缓存同步；唯独连续输入的 title/notes 这层草稿有此病。
//
// 状态机（与计划「草稿守卫状态机」一致）：
//   - 挂载：draft = 基线 = 外部值。
//   - 聚焦中：外部更新一律忽略（不冲掉正在输入的草稿）。
//   - 未聚焦 且 外部值 ≠ 基线：draft 与基线跟随外部值（跨列/跨窗口热更可见）。
//   - blur 保存后：立即把基线设为已提交值——非乐观更新下 external 尚未回灌，
//     若不更新基线，随后一次 re-render 会拿旧 external 把 draft 回弹到旧值。
//   - taskId 变化：无条件重置为新任务外部值（切任务不保留上一条草稿）。
//
// 同时把每个实例的 flush 回调注册进窗口级 pending 注册表（R21）：renderer 销毁不触发 blur，
// 关窗前须由 U7 的关窗握手调用 flushPendingDrafts() 统一提交未保存草稿，否则静默丢数据。

import { useCallback, useEffect, useRef, useState } from "react";

// ── 窗口级 pending 草稿注册表（跨组件契约，供 U7 关窗握手消费）──────────────────────
// 每个挂载中的草稿实例注册其 commit 回调；flushPendingDrafts() 逐个提交（读各自最新草稿）。
const pendingFlushers = new Set<() => void>();

/** 提交所有挂载中草稿的未保存值（关窗 / beforeunload 前调用）。单个失败不阻断其余。 */
export function flushPendingDrafts(): void {
  // 先快照再遍历：commit 可能触发 setState → 卸载 → 改动集合，避免遍历中修改。
  for (const flush of [...pendingFlushers]) {
    try {
      flush();
    } catch {
      // 单字段 flush 失败（如 mutation 抛错）不应阻断其它字段落库。
    }
  }
}

/** 当前挂载中的 pending 草稿实例数（测试 / 诊断用）。 */
export function pendingDraftCount(): number {
  return pendingFlushers.size;
}

export type TaskDraftField = {
  /** 当前草稿值（受控输入的 value）。 */
  value: string;
  /** 输入回调（受控输入的 onChange 内调用）。 */
  setValue: (v: string) => void;
  /** 获得焦点：进入 Editing，冻结外部跟随。 */
  onFocus: () => void;
  /** 失焦：提交草稿并更新基线（回到 Synced）。 */
  onBlur: () => void;
  /** 立即提交（Enter / 返回 / 关窗 flush）；不改变焦点态。 */
  commit: () => void;
};

export function useTaskDraftField(opts: {
  /** 当前任务 id：变化即无条件重置草稿。 */
  taskId: string;
  /** 外部权威值（task.title / task.notes ?? ""）。 */
  external: string;
  /** 落库回调（仅当归一化后的草稿 ≠ 外部值时调用）。 */
  onCommit: (value: string) => void;
  /** 提交前归一化（如 title 用 trim）；不传则原样提交。 */
  normalize?: (v: string) => string;
}): TaskDraftField {
  const { taskId, external, onCommit, normalize } = opts;

  const [value, setValueState] = useState(external);
  const baselineRef = useRef(external); // 上次同步/提交的权威值
  const focusedRef = useRef(false);
  const prevTaskIdRef = useRef(taskId);

  // 最新值走 ref，供 commit（可能在关窗 flush 时于聚焦态被外部调用）读取，避免闭包捕获旧值。
  const valueRef = useRef(value);
  const externalRef = useRef(external);
  const onCommitRef = useRef(onCommit);
  const normalizeRef = useRef(normalize);
  valueRef.current = value;
  externalRef.current = external;
  onCommitRef.current = onCommit;
  normalizeRef.current = normalize;

  const setValue = useCallback((v: string) => {
    valueRef.current = v;
    setValueState(v);
  }, []);

  // taskId 变化 → 无条件重置；同 taskId 的外部更新 → 仅未聚焦且 ≠ 基线时跟随。
  useEffect(() => {
    if (prevTaskIdRef.current !== taskId) {
      prevTaskIdRef.current = taskId;
      baselineRef.current = external;
      setValue(external);
      return;
    }
    if (!focusedRef.current && external !== baselineRef.current) {
      baselineRef.current = external;
      setValue(external);
    }
  }, [taskId, external, setValue]);

  // 提交：归一化后若 ≠ 外部值则落库；无论是否落库都把基线推到已提交值（防旧值回弹）。
  const commit = useCallback(() => {
    const norm = normalizeRef.current;
    const raw = valueRef.current;
    const next = norm ? norm(raw) : raw;
    if (next !== externalRef.current) onCommitRef.current(next);
    baselineRef.current = next;
    if (next !== raw) setValue(next); // 归一化改写了草稿（如 trim）时同步显示值
  }, [setValue]);

  const onFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);
  const onBlur = useCallback(() => {
    focusedRef.current = false;
    commit();
  }, [commit]);

  // 注册进窗口级 pending 注册表：commit 稳定（依赖 setValue 稳定），仅注册/注销一次。
  useEffect(() => {
    pendingFlushers.add(commit);
    return () => {
      pendingFlushers.delete(commit);
    };
  }, [commit]);

  return { value, setValue, onFocus, onBlur, commit };
}
