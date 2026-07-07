// 写作空间 store（standalone zustand）：一空间一根目录。
// 运行态在此持有；持久化经 serialize()→PersistedState.writingUi 分片落盘、hydrate() 回灌
// （落盘 wiring 由个人工作区持久化统一节流兜底，见 usePersonalPersistence）。
// 空间根经系统目录选择器（bridge.pickDirectory）添加：取消返回 null 不加、重复根拒绝、
// 移除仅移出列表不删盘。core 禁用 localStorage，故这里不碰浏览器存储。

import { create } from "zustand";
import type { DesktopBridge } from "../desktop/bridge";
import type {
  WritingFontPreset,
  WritingPreviewMode,
  WritingQuickAction,
  WritingSpace,
  WritingUiState,
} from "../desktop/writing-types";
import { defaultWritingQuickActions, normalizeWritingQuickActions } from "./quick-actions";
import {
  DEFAULT_WRITING_FONT_PRESET,
  WRITING_LINE_HEIGHT_DEFAULT,
  clampWritingLineHeight,
  normalizeWritingFontPreset,
} from "./typography";

// 便于 views 经本子路径直接取用编辑器视图档位类型(core 主入口未导出 writing-types)。
export type { WritingPreviewMode } from "../desktop/writing-types";

// 编辑器字号步进边界（与 Kun WRITE_EDITOR_FONT_SIZE_MIN/MAX/DEFAULT 一致）。
export const WRITING_FONT_SIZE_MIN = 10;
export const WRITING_FONT_SIZE_MAX = 48;
export const WRITING_FONT_SIZE_DEFAULT = 16;

// 字号夹取到合法区间；非数值/越界回落默认（兼容旧档脏值）。
function clampFontSize(px: number | undefined): number {
  if (typeof px !== "number" || !Number.isFinite(px)) return WRITING_FONT_SIZE_DEFAULT;
  return Math.min(WRITING_FONT_SIZE_MAX, Math.max(WRITING_FONT_SIZE_MIN, Math.round(px)));
}

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
  // 中栏编辑器视图偏好（跨空间共享，由中栏工具栏切换/步进；随 WritingUiState 分片持久化）。
  previewMode: WritingPreviewMode;
  fontSizePx: number;
  // 排版（设置节「排版与字体」）：字体预设 + custom 字体 + 行距。字号复用 fontSizePx（与工具栏同源）。
  fontPreset: WritingFontPreset;
  customFontFamily: string;
  lineHeight: number;
  // 工作区级检索上下文开关（U4，跨空间共享）：开启时助手发送按用户正文检索 top-k 片段注入 prompt。
  // 默认 true；关闭或检索失败/超时时静默不注入。
  retrievalEnabled: boolean;
  // 选中文字工具栏「快捷指令」配置（跨空间共享）：内置 + 自定义;渲染前经 resolveWritingQuickActions 解析。
  quickActions: WritingQuickAction[];

  // 编辑器视图档位切换（source/live/preview）。
  setPreviewMode: (mode: WritingPreviewMode) => void;
  // 字号设置（自动夹取到 10–48；工具栏与设置滑杆共用）。
  setFontSizePx: (px: number) => void;
  // 排版设置（字体预设 / custom 字体 / 行距）+ 一键重置排版为默认。
  setFontPreset: (preset: WritingFontPreset) => void;
  setCustomFontFamily: (family: string) => void;
  setLineHeight: (lineHeight: number) => void;
  resetTypography: () => void;
  // 检索上下文开关切换（写作设置节;单一真源）。
  setRetrievalEnabled: (enabled: boolean) => void;
  // 覆盖快捷指令配置（设置编辑器增删改后整表写入，写入即归一化）。
  setQuickActions: (actions: WritingQuickAction[]) => void;

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
  previewMode: "rich",
  fontSizePx: WRITING_FONT_SIZE_DEFAULT,
  fontPreset: DEFAULT_WRITING_FONT_PRESET,
  customFontFamily: "",
  lineHeight: WRITING_LINE_HEIGHT_DEFAULT,
  retrievalEnabled: true,
  quickActions: defaultWritingQuickActions(),

  setPreviewMode: (mode) => set({ previewMode: mode }),
  setFontSizePx: (px) => set({ fontSizePx: clampFontSize(px) }),
  setFontPreset: (preset) => set({ fontPreset: normalizeWritingFontPreset(preset) }),
  setCustomFontFamily: (family) => set({ customFontFamily: family.slice(0, 200) }),
  setLineHeight: (lineHeight) => set({ lineHeight: clampWritingLineHeight(lineHeight) }),
  resetTypography: () =>
    set({
      fontSizePx: WRITING_FONT_SIZE_DEFAULT,
      fontPreset: DEFAULT_WRITING_FONT_PRESET,
      customFontFamily: "",
      lineHeight: WRITING_LINE_HEIGHT_DEFAULT,
    }),
  setRetrievalEnabled: (enabled) => set({ retrievalEnabled: enabled }),
  setQuickActions: (actions) => set({ quickActions: normalizeWritingQuickActions(actions) }),

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
    return {
      spaces: s.spaces,
      activeSpaceId: s.activeSpaceId,
      previewMode: s.previewMode,
      fontSizePx: s.fontSizePx,
      fontPreset: s.fontPreset,
      customFontFamily: s.customFontFamily,
      lineHeight: s.lineHeight,
      retrievalEnabled: s.retrievalEnabled,
      quickActions: s.quickActions,
    };
  },

  hydrate: (state) =>
    set({
      spaces: state?.spaces ?? [],
      activeSpaceId: state?.activeSpaceId ?? null,
      // 缺字段回落默认（兼容旧档）；字号夹取到合法区间。
      previewMode: state?.previewMode ?? "rich",
      fontSizePx: clampFontSize(state?.fontSizePx),
      // 排版：预设/字体/行距缺省或脏值回落默认。
      fontPreset: normalizeWritingFontPreset(state?.fontPreset),
      customFontFamily: typeof state?.customFontFamily === "string" ? state.customFontFamily.slice(0, 200) : "",
      lineHeight: clampWritingLineHeight(state?.lineHeight),
      // 缺省视为开启（默认 true）：旧档没有该字段时保持检索启用。
      retrievalEnabled: state?.retrievalEnabled ?? true,
      // 缺字段（旧档）→ 归一化空输入即得内置默认集；有档则补齐内置 + 夹取自定义。
      quickActions: normalizeWritingQuickActions(state?.quickActions),
    }),
}));
