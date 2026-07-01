// Agent 委派派发（U11，「交给 agent」）：以任务标题+备注为上下文起一个 headless 会话
//（复用 createSession + send，同 docTasks.useContinueDoc 范式），任务转 waiting 并记录 delegation
//（sessionId 供 U12 回写重校验 shouldAcceptDelegationWriteback）。无 project 任务 cwd 走默认工作区
// 目录（R17；task-project 无路径，KTD10）。
//
// 说明（与计划 U12 的差异）：完整的「main 侧会话退出观察者自动回写」需在运行的 Electron 里对接
// cli 生命周期，无法 headless 验证，故 v1 采用**用户驱动确认闭环**——委派后任务处于 waiting，
// 用户在会话观察 agent 完成后于 TasksView 点「确认完成」(→done) 或「取消委派」(→active)。
// 数据安全的回写重校验谓词已实现并测试（tasks.ts:shouldAcceptDelegationWriteback），供后续主
// 观察者接线复用。

import { useCallback } from "react";
import { useDesktopBridge } from "../provider";
import { initialModelDraft, usePersonalStore } from "../store/personal";
import { usePersonalActions } from "./messages";
import { dayKey } from "./timeline";
import { useUpdateTask } from "./tasks";
import type { TaskMeta } from "../desktop/types";

export function useDelegateTask(): (task: TaskMeta, onToast: (text: string) => void) => Promise<void> {
  const bridge = useDesktopBridge();
  const { send } = usePersonalActions();
  const updateTask = useUpdateTask();

  return useCallback(
    async (task, onToast) => {
      if (!bridge) {
        onToast("当前环境不支持委派（缺少桌面能力）");
        return;
      }
      // 再委派守卫：已有 agent 在跑则拦截二次委派（研究 I12）。
      if (task.delegation?.state === "running") {
        onToast("该任务已有 agent 在跑");
        return;
      }

      const st = usePersonalStore.getState();
      const projectId = st.activeProjectId;
      const proj = projectId ? st.projects.find((p) => p.id === projectId) : undefined;

      // cwd：task-project 无路径 → 有活动项目用其 path，否则默认无项目目录（R17 默认策略）。
      let cwd = proj?.path;
      if (!cwd) cwd = (await bridge.ensureNoProjectDir?.(dayKey(Date.now()))) ?? undefined;
      if (!cwd) {
        onToast("无法定位工作目录，无法委派。");
        return;
      }

      const draft = initialModelDraft(st);
      const sess = st.createSession(projectId, draft.agent, draft.model, proj ? undefined : { noProjectDir: cwd });
      if (draft.agent === "pi" && draft.providerId) st.updateSession(sess.id, { providerId: draft.providerId });

      // 记录委派归属（sessionId 供回写重校验），任务转 waiting。
      updateTask.mutate({
        id: task.id,
        patch: { status: "waiting", delegation: { sessionId: sess.id, state: "running" } },
      });

      st.setActiveSession(sess.id);
      const context = task.notes?.trim() ? `${task.title}\n\n${task.notes}` : task.title;
      await send(sess, cwd, `请完成这个任务：\n\n${context}`, [], undefined);
    },
    [bridge, send, updateTask],
  );
}
