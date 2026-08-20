// 完整运行详情弹层的宿主。Kun 对齐后，当前轮思考和 tool input/output 已可在消息流逐项展开；
// 本弹层保留跨轮事件、耗时、筛选和统计，不再渲染第二枚圆形运行状态。
// typing 无结构化过程时仍可通过 store 请求打开本弹层，因此详情能力没有随旧入口一起删除。

import { useEffect, useState } from "react";
import { usePersonalStore } from "@cortex-work/core";
import { useChatViewActive } from "./agentMeta";
import { AgentTranscriptDialog } from "./AgentTranscriptDialog";

export function PersonalProcessPanel() {
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const chatViewActive = useChatViewActive();

  // 切会话时关闭，避免弹层残留展示上一个会话；外部请求以 sessionId + nonce 精确触发。
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [target, setTarget] = useState<{
    runId?: string;
    toolCallId?: string;
    initialTab?: "overview" | "input" | "output" | "error";
  }>();
  useEffect(() => {
    setTranscriptOpen(false);
    setTarget(undefined);
  }, [activeSessionId]);
  // 外部打开请求来自内联过程段的「查看完整过程」，以及无结构化过程时的 typing 活动行。
  const openReq = usePersonalStore((s) => s.processPanelOpenReq);
  useEffect(() => {
    if (openReq && openReq.sessionId === activeSessionId) {
      setTarget({ runId: openReq.runId, toolCallId: openReq.toolCallId, initialTab: openReq.initialTab });
      setTranscriptOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq?.nonce]);

  if (!chatViewActive || !activeSessionId) return null;
  return (
    <AgentTranscriptDialog
      open={transcriptOpen}
      onClose={() => setTranscriptOpen(false)}
      sessionId={activeSessionId}
      target={target}
    />
  );
}
