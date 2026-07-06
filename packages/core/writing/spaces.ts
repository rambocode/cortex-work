// 写作空间 store（standalone zustand）：一空间一根目录。
// 运行态在此持有；持久化经 serialize()→PersistedState.writingUi 分片落盘、hydrate() 回灌
// （落盘 wiring 由个人工作区持久化统一节流兜底，见 usePersonalPersistence）。
// 空间根经系统目录选择器（bridge.pickDirectory）添加：取消返回 null 不加、重复根拒绝、
// 移除仅移出列表不删盘。core 禁用 localStorage，故这里不碰浏览器存储。

import { create } from "zustand";
import type { DesktopBridge } from "../desktop/bridge";
import type { WritingSpace, WritingUiState } from "../desktop/writing-types";

// 单调递增序号，配合时间戳生成稳定空间 id（core 跨端，避免依赖 crypto.randomUUID）。
let idSeq = 0;
function genSpaceId(): string {
  return `ws-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;
}

// 归一化根路径用于去重：仅去掉尾部斜杠，不做 realpath（core 无 node path，且真实性由 fs 白名单兜底）。
function normalizeRoot(root: string): string {
  return root.replace(/[/\\]+$/, "");
}

// 从根目录派生展示名：取 basename（末段），无末段时回落整串。不依赖 node path（core 跨端）。
function deriveName(root: string): string {
  const parts = normalizeRoot(root).split(/[/\\]/);
  return parts[parts.length - 1] || root;
}

export interface WritingSpacesState {
  spaces: WritingSpace[];
  activeSpaceId: string | null;

  // 经系统目录选择器添加空间：取消（pickDirectory 返回 null）不加并回 null；
  // 根已存在则拒绝、不加第二条并回 null；成功则追加、设为活跃并回该空间。
  addSpace: (bridge: DesktopBridge | null) => Promise<WritingSpace | null>;
  // 首次进入写作工作区时以 fs:writingWorkspaceRoot 建默认空间；已有空间则不动、回 null。
  ensureDefaultSpace: (bridge: DesktopBridge | null) => Promise<WritingSpace | null>;
  // 移除空间：仅移出列表不删盘；被移除的是活跃空间则回落到剩余首个（或 null）。
  removeSpace: (id: string) => void;
  // 切换活跃空间（id 不在列表时忽略，避免指向不存在的空间）。
  setActiveSpace: (id: string) => void;
  // 序列化为持久化分片 / 从分片回灌（缺字段回落空默认，兼容旧档）。
  serialize: () => WritingUiState;
  hydrate: (state: WritingUiState | undefined | null) => void;
}

export const useWritingSpacesStore = create<WritingSpacesState>((set, get) => ({
  spaces: [],
  activeSpaceId: null,

  addSpace: async (bridge) => {
    // web/旧壳无目录选择器能力时直接放弃（入口本应已降级隐藏，这里做防御）。
    if (!bridge?.pickDirectory) return null;
    const picked = await bridge.pickDirectory();
    if (picked == null) return null; // 用户取消
    const root = normalizeRoot(picked);
    // 重复根拒绝：同一目录不重复建空间（一空间一根目录）。
    if (get().spaces.some((s) => normalizeRoot(s.root) === root)) return null;
    const space: WritingSpace = { id: genSpaceId(), name: deriveName(root), root };
    set((s) => ({ spaces: [...s.spaces, space], activeSpaceId: space.id }));
    return space;
  },

  ensureDefaultSpace: async (bridge) => {
    if (get().spaces.length > 0) return null; // 已有空间，不重复建默认
    if (!bridge?.writingWorkspaceRoot) return null;
    const root = normalizeRoot(await bridge.writingWorkspaceRoot());
    // 理论上空列表不会撞根，仍防御去重（避免并发调用重复追加）。
    if (get().spaces.some((s) => normalizeRoot(s.root) === root)) return null;
    // isDefault:true —— 这是零配置默认空间，UI 据此在其行下渲染「默认写作空间」副标。
    const space: WritingSpace = { id: genSpaceId(), name: deriveName(root), root, isDefault: true };
    set((s) => ({ spaces: [...s.spaces, space], activeSpaceId: space.id }));
    return space;
  },

  removeSpace: (id) =>
    set((s) => {
      const spaces = s.spaces.filter((sp) => sp.id !== id);
      // 被移除的是活跃空间 → 回落到剩余首个；列表空则 null。
      const activeSpaceId = s.activeSpaceId === id ? (spaces[0]?.id ?? null) : s.activeSpaceId;
      return { spaces, activeSpaceId };
    }),

  setActiveSpace: (id) =>
    set((s) => (s.spaces.some((sp) => sp.id === id) ? { activeSpaceId: id } : {})),

  serialize: () => {
    const s = get();
    return { spaces: s.spaces, activeSpaceId: s.activeSpaceId };
  },

  hydrate: (state) =>
    set({
      spaces: state?.spaces ?? [],
      activeSpaceId: state?.activeSpaceId ?? null,
    }),
}));
