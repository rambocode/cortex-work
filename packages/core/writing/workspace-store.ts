// 写作工作区运行态 store(standalone zustand):当前打开文件(绝对路径,即树节点 key)与切换动作。
// 瞬态,不持久化——重进由空间列表 + 用户重新选择恢复。U5 将在此扩展脏态/磁盘基线/删除态,
// 本单元只放最小的「当前文件」骨架供中/右栏与文件树联动。
import { create } from "zustand";

export interface WritingWorkspaceState {
  // 当前打开文件的绝对路径;无打开文件时为 null(切空间/删除当前文件后回落 null)。
  currentFile: string | null;
  // 打开某文件(树点击)/关闭(传 null)。
  setCurrentFile: (path: string | null) => void;
  // 树内重命名当前打开文件后同步 key:仅当 from 命中当前文件才改到 to,否则忽略。
  renameCurrentFile: (from: string, to: string) => void;
  // 删除某路径后收敛当前文件:命中当前文件(或其所在目录被整删)则回落 null。
  handlePathRemoved: (path: string) => void;
}

export const useWritingWorkspaceStore = create<WritingWorkspaceState>((set) => ({
  currentFile: null,
  setCurrentFile: (path) => set({ currentFile: path }),
  renameCurrentFile: (from, to) =>
    set((s) => (s.currentFile === from ? { currentFile: to } : {})),
  handlePathRemoved: (path) =>
    set((s) => {
      if (!s.currentFile) return {};
      // 当前文件本身被删,或其祖先目录被整删(路径前缀匹配 + 分隔符边界)→ 关闭。
      const hit = s.currentFile === path || s.currentFile.startsWith(`${path}/`);
      return hit ? { currentFile: null } : {};
    }),
}));
