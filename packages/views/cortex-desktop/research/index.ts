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
