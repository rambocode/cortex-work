// Kun chat/WorkspaceModeTabs 的替身：Kun 里是 Code/写作/设计 三工作区切换 tab。
// cortex 的设计工作台是个人工作区内的独立视图，无对等的三工作区语义，
// 故渲染为空；返回个人工作区主界面的入口由 DesignWorkspaceView 头部承担（批5）。
type WorkspaceModeTabsProps = {
  activeView?: string;
  onCodeOpen?: () => void;
  onWriteOpen?: () => void;
  onDesignOpen?: () => void;
} & Record<string, unknown>;

export function WorkspaceModeTabs(_props: WorkspaceModeTabsProps) {
  return null;
}
