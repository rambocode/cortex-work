// Deep Research 组件层的对外出口。
//
// 目前尚未接线：侧栏入口与设置页由后续阶段接入，届时只需在
// `packages/views/cortex-desktop/index.ts` 里转出本 barrel（或直接从子路径 import），
// 不必再改动本目录内部结构。
export { ResearchWorkspace, type ResearchWorkspaceProps } from "./ResearchWorkspace";
export { ResearchSessionList, type ResearchSessionListProps } from "./ResearchSessionList";
export { ResearchCreateForm, type ResearchCreateFormProps } from "./ResearchCreateForm";
export { ResearchRunView, type ResearchRunViewProps } from "./ResearchRunView";
export { ResearchSourcePanel, type ResearchSourcePanelProps } from "./ResearchSourcePanel";
export { ResearchPolicyNotice, type ResearchPolicyNoticeProps } from "./ResearchPolicyNotice";
export type { ResearchBridgeLike } from "./bridge-like";
export {
  FETCH_FAILURE_LABELS,
  MODEL_DATA_POLICY_LABELS,
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
