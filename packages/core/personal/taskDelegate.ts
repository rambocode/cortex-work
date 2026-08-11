// Agent 委派派发（「交给 agent」）：以任务标题+备注为上下文起一个 headless 会话
//（复用 createSession + send），任务转 waiting 并记录 delegation
//（sessionId 供回写重校验 shouldAcceptDelegationWriteback）。无 project 任务 cwd 走默认工作区
// 目录（R17；task-project 无路径，KTD10）。
//
// 跨窗口拓扑（KTD10）：sessions 是 renderer 本地 Zustand、不跨窗口同步，故委派必须区分入口：
//  - 主窗口右栏 TasksView 直接点「交给 agent」→ useDelegateTask 本地 createSession+send（下方）。
//  - 「项目管理」独立窗口的中列 → useDelegateTaskRelay 只发委派意图 IPC + 本地 toast，不本地起会话；
//    main 唤起主窗口并转发意图 → 主窗口 useDelegateIntentListener 解析任务后本地执行 useDelegateTask。
// 覆盖层时代的 keepView/prevNav 存档还原语义随窗口化移除（projectsOpen 已删）。

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDesktopBridge } from "../provider";
import { initialModelDraft, usePersonalStore } from "../store/personal";
import { usePersonalActions } from "./messages";
import { dayKey } from "./date";
import { tasksKeys, useUpdateTask } from "./tasks";
import type { TaskDelegateIntent, TaskMeta } from "../desktop/types";

// 主窗口本地委派执行器：createSession + 记 delegation + send，并切到该会话观察 agent。
// 两条入口共用：① 主窗口右栏 TasksView 直接点击；② 主窗口监听项目管理窗口转发来的委派意图。
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

      // 切到新会话观察 agent 执行（createSession 已切走视图，这里补 activeSession；意图中继场景下
      // 主窗口已由 main show()+focus()，此处导航把用户落到该 session）。
      st.setActiveSession(sess.id);

      const context = task.notes?.trim() ? `${task.title}\n\n${task.notes}` : task.title;
      await send(sess, cwd, `请完成这个任务：\n\n${context}`, [], undefined);
    },
    [bridge, send, updateTask],
  );
}

// 「项目管理」独立窗口侧的委派：不本地起会话（跨窗口 sessions 不同步，KTD10），只把委派意图经
// bridge 发给 main → main 唤起主窗口执行。本地即时 toast 反馈（R22）。
export function useDelegateTaskRelay(): (task: TaskMeta, onToast: (text: string) => void) => void {
  const bridge = useDesktopBridge();
  return useCallback(
    (task, onToast) => {
      if (!bridge?.sendTaskDelegateIntent) {
        onToast("当前环境不支持委派（缺少桌面能力）");
        return;
      }
      // 再委派守卫（即时反馈）：项目窗口与主窗口共享同一份 main-owned 任务缓存，可本地先拦一道；
      // 主窗口执行器 useDelegateTask 仍会再校验一次作为权威。
      if (task.delegation?.state === "running") {
        onToast("该任务已有 agent 在跑");
        return;
      }
      bridge.sendTaskDelegateIntent({ taskId: task.id });
      onToast("已请求主窗口执行委派");
    },
    [bridge],
  );
}

// 主窗口挂载（PersonalWorkspace）：订阅项目管理窗口经 main 转发来的委派意图，据 taskId 从 React
// Query 缓存（main-owned、跨窗口广播一致）解析任务对象后本地执行委派。用 ref 固定最新依赖，避免
// 任务缓存/回调每次变化都重订阅 IPC。
export function useDelegateIntentListener(onToast: (text: string) => void): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  const delegate = useDelegateTask();
  const ref = useRef({ delegate, onToast, qc });
  ref.current = { delegate, onToast, qc };
  useEffect(() => {
    if (!bridge?.onTaskDelegateIntent) return;
    // 意图解析：从 main-owned 任务缓存（跨窗口广播一致）据 taskId 定位任务并本地执行委派。
    const handle = (intent: TaskDelegateIntent) => {
      const list = ref.current.qc.getQueryData<TaskMeta[]>(tasksKeys.all) ?? [];
      const task = list.find((t) => t.id === intent.taskId);
      if (!task) {
        ref.current.onToast("未找到要委派的任务");
        return;
      }
      void ref.current.delegate(task, ref.current.onToast);
    };
    // 冷窗口兜底（仿 spotlightHandoff）：主窗口冷启动/隐藏时 live 意图在订阅前发丢，先 consume 一次
    // main 暂存的 pending，再订阅 live。注意：consume 落库缓存可能尚未 hydrate，找不到任务会 toast，
    // 但项目窗口委派前主窗口通常已运行过，缓存已就绪；此处兜底优先保证不静默丢派发。
    void bridge.consumeTaskDelegateIntent?.().then((intent) => {
      if (intent) handle(intent);
    });
    return bridge.onTaskDelegateIntent(handle);
  }, [bridge]);
}
