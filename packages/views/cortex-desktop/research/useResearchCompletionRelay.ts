// 研究结束 → 回流到发起它的聊天会话。
//
// **为什么必须有这一层**：/skill:research 的活由主进程的 CRE 引擎干，聊天会话里没有任何
// agent 轮次。没有回流的话，用户切走再回来，会话流里只剩自己问的那句话——研究出没出结果、
// 报告文件落在哪，全都看不出来（用户实测反馈）。
//
// **为什么订阅 onEvent 而不是消费 background store 的 finished 队列**：那个队列由
// PersonalWorkspace 的 toast effect 消费并立即 clearFinished，两个消费者抢同一个队列，
// 谁先跑谁拿到，另一个就永远漏。onEvent 是广播，各订阅者互不影响。
//
// **本 hook 绝不调用 ui-store.applyEvent**（那是 live-sync 的独占职责，见 core/research/live-sync.ts）：
// report_delta 是增量拼接、activity 是环形追加，调两次就会翻倍。这里只读 done 事件。
import { useEffect, useRef } from "react";

import { buildResearchCompletionMessage } from "@cortex-work/core/research/completion-message";
import type { ResearchEvent } from "@cortex-work/core/research/types";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { usePersonalActions } from "@cortex-work/core/personal/messages";

import type { ResearchBridgeLike } from "./bridge-like";

/// 完成消息在会话流里的作者标识（非 "me" 即渲染成 agent 侧气泡）。
const RESEARCH_AUTHOR = "深度研究";

/// 订阅研究终态事件，把结论指针（状态 / 统计 / 归档文件路径）写回发起该研究的会话。
///
/// 挂载点必须与 live-sync 同级（PersonalWorkspace 根部）：研究是分钟级任务，
/// 挂在会话页或右栏面板里的话，用户切走即卸载，回流就丢了。
export function useResearchCompletionRelay(bridge: ResearchBridgeLike | null): void {
  const { appendLocalAgentMessage } = usePersonalActions();
  // 已处理过的研究 id：done 事件可能因重连等原因重复到达，重复写会让会话里出现两条一样的回执。
  const handledRef = useRef<Set<string>>(new Set());
  // 回调里要读最新的 append，但不能让它进 effect 依赖——那会导致每次渲染重订阅。
  const appendRef = useRef(appendLocalAgentMessage);
  appendRef.current = appendLocalAgentMessage;

  useEffect(() => {
    if (!bridge) return;

    const onEvent = (event: ResearchEvent): void => {
      if (event.type !== "done") return;
      const researchSessionId = event.sessionId;
      if (handledRef.current.has(researchSessionId)) return;

      // 只回流「绑定到某个聊天会话」的研究：agent 经 MCP 自主发起的研究没有归属会话，
      // 硬塞进当前会话会让用户看到一条不知从哪冒出来的回执。
      const chat = usePersonalStore
        .getState()
        .sessions.find((s) => s.researchSessions?.some((r) => r.sessionId === researchSessionId));
      if (!chat) return;

      handledRef.current.add(researchSessionId);
      void (async () => {
        try {
          // 取 "full" 而非 "evidence"：要的是报告归档路径与统计，不碰几 MB 的证据正文。
          const view = await bridge.get(researchSessionId, "full");
          const text = buildResearchCompletionMessage({
            objective: view.summary.objective,
            status: event.status,
            ...(view.report?.archivedPath ? { archivedPath: view.report.archivedPath } : {}),
            roundCount: view.summary.roundCount,
            documentCount: view.summary.documentCount,
            citationCount: view.report?.citations?.length ?? 0,
            ...(view.summary.errorMessage ? { errorMessage: view.summary.errorMessage } : {}),
          });
          await appendRef.current(chat.id, RESEARCH_AUTHOR, text);
        } catch {
          // 详情拉取失败（会话已删等）时退化成只报状态：宁可少几行统计，
          // 也不能让用户在会话里完全看不到研究已经结束。
          const fallback = buildResearchCompletionMessage({
            objective:
              chat.researchSessions?.find((r) => r.sessionId === researchSessionId)?.objective ?? "深度研究",
            status: event.status,
          });
          await appendRef.current(chat.id, RESEARCH_AUTHOR, fallback).catch(() => {});
        }
      })();
    };

    return bridge.onEvent(onEvent);
  }, [bridge]);
}
