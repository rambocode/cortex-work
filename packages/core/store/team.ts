// 团队工作区的客户端态（Zustand）：仅存 UI 选择——每个会话目标（contactId/分身）当前
// 选定的「(runtime, 服务器工作区)」。占用/排队/工作区列表等权威态一律留在 React Query
// （serverWorkspaceKeys），本 store 不复制任何服务端数据（遵守双数据源禁令）。

import { create } from "zustand";

export interface ServerWorkspaceSelection {
  runtimeId: string;
  serverWorkspaceId: string;
}

interface TeamUIState {
  // key = 会话目标 id（通讯录 contactId；分身即 runtime_id）。undefined = 未选择，
  // Composer 显示「选择服务器工作区」占位并禁用发送到服务器工作区的路径。
  selection: Record<string, ServerWorkspaceSelection | undefined>;
  setSelection: (targetId: string, sel: ServerWorkspaceSelection | undefined) => void;
  clearAllSelections: () => void;
}

export const useTeamUIStore = create<TeamUIState>((set) => ({
  selection: {},
  setSelection: (targetId, sel) =>
    set((s) => ({ selection: { ...s.selection, [targetId]: sel } })),
  // 切 workspace/登出时调用：选择与 wsId 绑定的资源 id 全部失效，必须整体清空。
  clearAllSelections: () => set({ selection: {} }),
}));
