// 右侧执行过程入口（U4）：中栏右侧的圆形状态 icon。运行中转圈、完成绿勾即为「执行感知」;
// 点击直接打开运行过程详情弹层（AgentTranscriptDialog:工具输入/输出/统计/筛选）。
// 旧的「向下展开步骤卡片」形态已移除——详情统一走弹层,不再维护两套过程 UI。
//
// 关键约定（沿用 KTD3/KTD9）：
//  - icon 作为 .pw-center-col 里的右侧占位列参与布局，**不遮挡**消息和输入框;
//    **不**进 rightView、不进 PersonalRightPanel。
//  - 门控与 rightOpen/rightView 解耦：仅当中栏显示会话区（非 automation/home/timeline/noteEditor/
//    settings）且当前会话有过程流或正在运行时渲染。
//  - 可达性：入口是原生 <button>,键盘可聚焦;出现不抢当前焦点（无 autoFocus/focus() 调用）。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import { usePersonalProcess, usePersonalStore } from "@cortex-work/core";
import type { Message } from "@cortex-work/core/types";
import { useChatViewActive } from "./agentMeta";
import { AgentTranscriptDialog } from "./AgentTranscriptDialog";

// 过程流里是否仍有运行中的步骤（agentLog/reasoning 的 active）。
function isProcessActive(process: Message[]): boolean {
  for (const m of process) {
    if ((m.kind === "agentLog" || m.kind === "reasoning") && m.active === true) return true;
  }
  return false;
}

export function PersonalProcessPanel() {
  const { t } = useTranslation("chat");
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const runId = usePersonalStore((s) => (s.activeSessionId ? s.runningBySession[s.activeSessionId] : undefined));
  // 扩展命令(/cmd)轮:pi 即时执行、无过程步骤,命令输出走消息流。无内容时不渲染入口,
  // 避免空态「运行中」一闪而过。
  const isExtensionCommand = usePersonalStore((s) =>
    s.activeSessionId ? !!s.piRuntimeBySession[s.activeSessionId]?.extensionCommand : false,
  );
  const chatViewActive = useChatViewActive();
  // 过程流按 activeSessionId 隔离：只据当前会话判定 icon 呈现与运行状态（R7）。
  const process = usePersonalProcess(activeSessionId);
  const active = isProcessActive(process) || !!runId;

  // 运行过程详情弹层开关。切会话时关闭,避免弹层残留展示上一个会话。
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  useEffect(() => {
    setTranscriptOpen(false);
  }, [activeSessionId]);
  // 外部打开请求(点聊天流 typing 活动行):nonce 变化即打开一次弹层。
  const openReq = usePersonalStore((s) => s.processPanelOpenReq);
  useEffect(() => {
    if (openReq && openReq.sessionId === activeSessionId) setTranscriptOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq?.nonce]);

  // 门控：中栏非会话区 / 当前会话既无过程也未运行 → 不渲染。
  // 扩展命令轮且无过程步骤 → 不渲染（命令输出在消息流,入口无内容,避免空态闪现）。
  if (!chatViewActive || !activeSessionId || (process.length === 0 && !runId)) return null;
  if (isExtensionCommand && process.length === 0) return null;

  // 圆形状态 icon:运行中转圈、完成绿勾;点击打开详情弹层。原生 <button> → 键盘/读屏可达。
  return (
    <>
      <button
        type="button"
        className="pw-process is-collapsed"
        data-active={active}
        aria-label={t("transcript.openButton")}
        title={t("transcript.openButton")}
        onClick={() => setTranscriptOpen(true)}
      >
        <span className="pw-process-fab-ic" aria-hidden="true">
          {active ? <span className="spinner" /> : <Icon.CheckCircle size={18} />}
        </span>
      </button>
      <AgentTranscriptDialog
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        sessionId={activeSessionId}
      />
    </>
  );
}
