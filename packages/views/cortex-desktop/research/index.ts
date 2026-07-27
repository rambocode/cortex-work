// Deep Research 组件层的对外出口。
//
// 整窗覆盖层（ResearchWorkspace/ResearchCreateForm）已移除：入口统一为会话 /skill:research
// （派发在 personal/researchDispatch.ts），进度与报告在右栏 ResearchArtifactPanel 展示。
export { ResearchArtifactPanel, type ResearchArtifactPanelProps } from "./ResearchArtifactPanel";
export { ResearchSessionList, type ResearchSessionListProps } from "./ResearchSessionList";
export { ResearchRunView, type ResearchRunViewProps } from "./ResearchRunView";
export { ResearchSourcePanel, type ResearchSourcePanelProps } from "./ResearchSourcePanel";
export type { ResearchBridgeLike } from "./bridge-like";
// 「本次研究用哪个模型 + 数据会去哪」的解析：设置页与新建表单共用，避免两处各拼一遍。
export { resolveResearchModelDisplay, type ResearchModelDisplay } from "./modelDisplay";
export {
  FETCH_FAILURE_LABELS,
  RESEARCH_MODE_LABELS,
  RESEARCH_STAGE_LABELS,
  RESEARCH_STATUS_META,
  canCancelSession,
  canPauseSession,
  canRerunSession,
  canResumeSession,
  canStartSession,
  fetchFailureLabel,
  isTerminalSession,
  type ResearchStatusMeta,
} from "./labels";
