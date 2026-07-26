// 用户记忆的渲染端 Zustand store（模块级单例，无需 CoreProvider 参与）。
//
// 定位：**只读缓存**——记忆真源是 main 侧 ~/.cortex-desktop/memory/*.md（main 唯一写者），
// 经 bridge.memoryGet 启动装填、onMemoryChanged（做梦写回后推送）刷新；本 store 的变更
// 不进 personal-workspace.json 持久化投影（形态同 store/reply.ts 的 memory 缓存）。
// 设置页编辑时先乐观更新本缓存，再同步调 bridge.memorySetFile 写真源。

import { create } from "zustand";
import {
  emptyUserMemoryState,
  normalizeUserMemory,
  type DreamStateSummary,
  type UserMemoryFile,
  type UserMemoryScope,
  type UserMemoryState,
} from "../memory/memory";

export interface MemoryStore {
  /// 分区记忆只读缓存（buildMemoryAppend 注入 prompt 时同步读取）。
  memory: UserMemoryState;
  /// 做梦状态摘要缓存（设置页展示上次整理时间与历史；null=尚未拉取）。
  dreamState: DreamStateSummary | null;

  /// 装填/刷新记忆缓存（来源：bridge.memoryGet 或 onMemoryChanged 推送；内部做字段级兜底）。
  hydrateMemory: (memory: UserMemoryState) => void;
  /// 装填/刷新做梦状态摘要（来源：bridge.memoryGetDreamState）。
  hydrateDreamState: (state: DreamStateSummary) => void;
  /// 写单分区手写区/自动区的本地缓存（真源写入由设置页同步调 bridge.memorySetFile）。
  setMemoryFile: (scope: UserMemoryScope, patch: Partial<UserMemoryFile>) => void;
  /// 清空全部记忆的本地缓存（真源清空由设置页调 bridge.memoryClear("all")）。
  clearAllMemory: () => void;
  /// 只清自动整理区的本地缓存（真源清空由设置页调 bridge.memoryClear("auto")）。
  clearAutoMemory: () => void;
}

export const useMemoryStore = create<MemoryStore>((set) => ({
  memory: emptyUserMemoryState(),
  dreamState: null,

  // 装填时过字段级兜底（防旧版 main 推来半缺结构导致下游 .trim() 抛错）。
  hydrateMemory: (memory) => set({ memory: normalizeUserMemory(memory) }),

  hydrateDreamState: (state) => set({ dreamState: state }),

  setMemoryFile: (scope, patch) =>
    set((state) => ({
      memory: { ...state.memory, [scope]: { ...state.memory[scope], ...patch } },
    })),

  clearAllMemory: () => set({ memory: emptyUserMemoryState() }),

  // 逐分区保留 manual 与 research、只清 auto——用新对象重建，保证引用变化触发订阅方刷新。
  // **research 必须保留**：那是用户逐条批准写入的研究结论，「清空自动整理」不该连它一起抹掉
  // （清 research 有独立入口，见设置页）。
  clearAutoMemory: () =>
    set((state) => {
      const next = emptyUserMemoryState();
      for (const scope of Object.keys(next) as UserMemoryScope[]) {
        next[scope] = {
          manual: state.memory[scope].manual,
          auto: "",
          research: state.memory[scope].research ?? "",
        };
      }
      return { memory: next };
    }),
}));
