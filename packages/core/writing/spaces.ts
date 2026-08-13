// 写作空间 store（standalone zustand）：一空间一根目录。
// 运行态在此持有；持久化经 serialize()→PersistedState.writingUi 分片落盘、hydrate() 回灌
// （落盘 wiring 由个人工作区持久化统一节流兜底，见 usePersonalPersistence）。
// 空间根经系统目录选择器（bridge.pickDirectory）添加：取消返回 null 不加、重复根拒绝、
// 移除仅移出列表不删盘。core 禁用 localStorage，故这里不碰浏览器存储。

import { create } from "zustand";
import type { DesktopBridge } from "../desktop/bridge";
import type {
  WritingDocSortKey,
  WritingDocSortOrder,
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

// 便于 views 经本子路径直接取用编辑器视图档位 / 文稿列表排序类型(core 主入口未导出 writing-types)。
export type {
  WritingDocSortKey,
  WritingDocSortOrder,
  WritingPreviewMode,
} from "../desktop/writing-types";

// 左栏文稿列表默认偏好：保持原有「名称升序」不变，展示项默认开（时间 + 概要即是本次新增的列表形态）。
const DEFAULT_DOC_SORT_KEY: WritingDocSortKey = "name";
const DEFAULT_DOC_SORT_ORDER: WritingDocSortOrder = "asc";

// 排序键/序脏值(旧档或手改落盘文件)回落默认，避免 UI 拿到不认识的枚举值。
function normalizeDocSortKey(key: unknown): WritingDocSortKey {
  return key === "created" || key === "updated" || key === "name" ? key : DEFAULT_DOC_SORT_KEY;
}
function normalizeDocSortOrder(order: unknown): WritingDocSortOrder {
  return order === "asc" || order === "desc" ? order : DEFAULT_DOC_SORT_ORDER;
}

// 编辑器字号边界（Kun 口径 10–48）。默认 13——注意这个值只对「用户从没手动调过字号」的档生效，
// 判据是 fontSizeUserSet（见 hydrate）：旧档一律写过 fontSizePx:16，只看这个数字无法区分
// 「用户特意选了 16」和「从来没动过，落盘的只是当年的默认值」，所以必须靠显式标记。
export const WRITING_FONT_SIZE_MIN = 10;
export const WRITING_FONT_SIZE_MAX = 48;
export const WRITING_FONT_SIZE_DEFAULT = 13;

// 字号夹取到合法区间；非数值/越界回落默认（兼容旧档脏值）。
function clampFontSize(px: number | undefined): number {
  if (typeof px !== "number" || !Number.isFinite(px)) return WRITING_FONT_SIZE_DEFAULT;
  return Math.min(WRITING_FONT_SIZE_MAX, Math.max(WRITING_FONT_SIZE_MIN, Math.round(px)));
}

// 禅模式偏好默认值。背景照片 id = 资源文件名去后缀(桌面端 resources/zen/backgrounds,取自
// Metion zen 资源,清单已裁剪);默认雾山山景 asoggetti;背景音默认「晨莺」(morning_bird.mp3)。
// 脏值/资产缺失不在 core 校验:主进程 show 时回落清单首张,音色由渲染端预设表兜底。背景音默认关闭。
export const WRITING_ZEN_BACKGROUND_DEFAULT = "asoggetti-zxcBR3zNc7I-unsplash";
export const WRITING_ZEN_SOUND_DEFAULT = "morning_bird";

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
  // 用户是否手动调过字号：false（含旧档缺字段）时 hydrate 回落到当前默认值，
  // 使默认值调整能对「没动过设置」的用户即时生效；一旦手动调过就永远尊重用户的选择。
  fontSizeUserSet: boolean;
  // 排版（设置节「排版与字体」）：字体预设 + custom 字体 + 行距。字号复用 fontSizePx（与工具栏同源）。
  fontPreset: WritingFontPreset;
  // 用户是否手动选过字体预设：与 fontSizeUserSet 同款语义——false（含旧档缺字段）时 hydrate
  // 回落当前默认预设，使默认字体升级（如切到随包思源宋体）对没动过设置的用户即时生效。
  fontPresetUserSet: boolean;
  customFontFamily: string;
  lineHeight: number;
  // 工作区级检索上下文开关（U4，跨空间共享）：开启时助手发送按用户正文检索 top-k 片段注入 prompt。
  // 默认 true；关闭或检索失败/超时时静默不注入。
  retrievalEnabled: boolean;
  // 选中文字工具栏「快捷指令」配置（跨空间共享）：内置 + 自定义;渲染前经 resolveWritingQuickActions 解析。
  quickActions: WritingQuickAction[];
  // 写作助手 composer 选择记忆（跨空间共享,面板 AgentSelect + ModelThinkingPill 持久化）:
  // agent、按 agent 的模型/思考强度、pi 模型所属供应商。宽松 string,合法值由渲染端兜底回落。
  assistantAgent: string | null;
  assistantModelByAgent: Record<string, string>;
  assistantThinkingByAgent: Record<string, string>;
  assistantPiProviderId: string | null;
  // 聚焦模式（跨空间共享）：中栏只高亮光标所在行，其余内容变灰。默认关闭。
  focusMode: boolean;
  // 禅模式（OmmWriter 式全屏沉浸写作）。zenMode 为瞬态开关——不落盘,每次都从普通态进入;
  // 背景场景 / 背景音三项偏好持久化(跨空间共享)。id 为宽松 string,渲染端按预设表兜底回落。
  zenMode: boolean;
  zenBackgroundId: string;
  zenSoundOn: boolean;
  zenSoundId: string;
  // 左栏文稿列表偏好（跨空间共享）：排序键 + 升降序；是否显示创建时间 / 概要。
  // 时间与概要要额外向主进程取 stat/正文（writing:docMeta），故这两个开关同时是「要不要拉元信息」的闸门。
  docSortKey: WritingDocSortKey;
  docSortOrder: WritingDocSortOrder;
  docShowCreatedAt: boolean;
  docShowExcerpt: boolean;

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
  // 聚焦模式开关（顶栏按钮）。
  setFocusMode: (on: boolean) => void;
  // 禅模式开关（顶栏进入 / 禅内菜单与 Esc 退出）与禅偏好写入;resetZenSettings 还原三项偏好为默认。
  setZenMode: (on: boolean) => void;
  setZenBackground: (id: string) => void;
  setZenSoundOn: (on: boolean) => void;
  setZenSound: (id: string) => void;
  resetZenSettings: () => void;
  // 左栏文稿列表偏好写入（排序菜单 / 显示项开关）。
  setDocSort: (key: WritingDocSortKey, order: WritingDocSortOrder) => void;
  setDocShowCreatedAt: (show: boolean) => void;
  setDocShowExcerpt: (show: boolean) => void;
  // 写作助手 composer 选择记忆写入（切 agent / 选模型 / 调思考强度时调用）。
  setAssistantAgent: (agent: string) => void;
  setAssistantModel: (agent: string, model: string, piProviderId?: string) => void;
  setAssistantThinking: (agent: string, value: string) => void;

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
  fontSizeUserSet: false,
  fontPreset: DEFAULT_WRITING_FONT_PRESET,
  fontPresetUserSet: false,
  customFontFamily: "",
  lineHeight: WRITING_LINE_HEIGHT_DEFAULT,
  retrievalEnabled: true,
  quickActions: defaultWritingQuickActions(),
  assistantAgent: null,
  assistantModelByAgent: {},
  assistantThinkingByAgent: {},
  assistantPiProviderId: null,
  focusMode: false,
  zenMode: false,
  zenBackgroundId: WRITING_ZEN_BACKGROUND_DEFAULT,
  zenSoundOn: false,
  zenSoundId: WRITING_ZEN_SOUND_DEFAULT,
  docSortKey: DEFAULT_DOC_SORT_KEY,
  docSortOrder: DEFAULT_DOC_SORT_ORDER,
  docShowCreatedAt: true,
  docShowExcerpt: true,

  setPreviewMode: (mode) => set({ previewMode: mode }),
  setFontSizePx: (px) => set({ fontSizePx: clampFontSize(px), fontSizeUserSet: true }),
  setFontPreset: (preset) =>
    set({ fontPreset: normalizeWritingFontPreset(preset), fontPresetUserSet: true }),
  setCustomFontFamily: (family) => set({ customFontFamily: family.slice(0, 200) }),
  setLineHeight: (lineHeight) => set({ lineHeight: clampWritingLineHeight(lineHeight) }),
  resetTypography: () =>
    set({
      fontSizePx: WRITING_FONT_SIZE_DEFAULT,
      // 重置排版 = 交还给默认值管理，之后默认值再变也跟着变。
      fontSizeUserSet: false,
      fontPreset: DEFAULT_WRITING_FONT_PRESET,
      fontPresetUserSet: false,
      customFontFamily: "",
      lineHeight: WRITING_LINE_HEIGHT_DEFAULT,
    }),
  setRetrievalEnabled: (enabled) => set({ retrievalEnabled: enabled }),
  setQuickActions: (actions) => set({ quickActions: normalizeWritingQuickActions(actions) }),
  setFocusMode: (on) => set({ focusMode: on }),
  setZenMode: (on) => set({ zenMode: on }),
  setZenBackground: (id) => set({ zenBackgroundId: id }),
  setZenSoundOn: (on) => set({ zenSoundOn: on }),
  setZenSound: (id) => set({ zenSoundId: id }),
  resetZenSettings: () =>
    set({
      zenBackgroundId: WRITING_ZEN_BACKGROUND_DEFAULT,
      zenSoundOn: false,
      zenSoundId: WRITING_ZEN_SOUND_DEFAULT,
    }),
  setDocSort: (key, order) =>
    set({ docSortKey: normalizeDocSortKey(key), docSortOrder: normalizeDocSortOrder(order) }),
  setDocShowCreatedAt: (show) => set({ docShowCreatedAt: show }),
  setDocShowExcerpt: (show) => set({ docShowExcerpt: show }),
  setAssistantAgent: (agent) => set({ assistantAgent: agent }),
  setAssistantModel: (agent, model, piProviderId) =>
    set((s) => ({
      assistantModelByAgent: { ...s.assistantModelByAgent, [agent]: model },
      // pi 传 providerId(与模型配对);其它 agent 不动既有值。
      ...(piProviderId !== undefined ? { assistantPiProviderId: piProviderId } : {}),
    })),
  setAssistantThinking: (agent, value) =>
    set((s) => ({ assistantThinkingByAgent: { ...s.assistantThinkingByAgent, [agent]: value } })),

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
      fontSizeUserSet: s.fontSizeUserSet,
      fontPreset: s.fontPreset,
      fontPresetUserSet: s.fontPresetUserSet,
      customFontFamily: s.customFontFamily,
      lineHeight: s.lineHeight,
      retrievalEnabled: s.retrievalEnabled,
      quickActions: s.quickActions,
      // 助手 composer 选择记忆:null → 省略字段(与可选契约对齐)。
      ...(s.assistantAgent ? { assistantAgent: s.assistantAgent } : {}),
      assistantModelByAgent: s.assistantModelByAgent,
      assistantThinkingByAgent: s.assistantThinkingByAgent,
      ...(s.assistantPiProviderId ? { assistantPiProviderId: s.assistantPiProviderId } : {}),
      focusMode: s.focusMode,
      // 禅模式偏好(zenMode 本身瞬态不落盘)。
      zenBackgroundId: s.zenBackgroundId,
      zenSoundOn: s.zenSoundOn,
      zenSoundId: s.zenSoundId,
      // 左栏文稿列表偏好。
      docSortKey: s.docSortKey,
      docSortOrder: s.docSortOrder,
      docShowCreatedAt: s.docShowCreatedAt,
      docShowExcerpt: s.docShowExcerpt,
    };
  },

  hydrate: (state) =>
    set({
      spaces: state?.spaces ?? [],
      activeSpaceId: state?.activeSpaceId ?? null,
      // 缺字段回落默认（兼容旧档）。
      previewMode: state?.previewMode ?? "rich",
      // 字号：只有「手动调过」的档才回灌落盘值；旧档 / 没动过的一律用当前默认值，
      // 否则默认值改了对老用户永远不生效（他们档里躺着上一版的默认数字）。
      fontSizePx:
        state?.fontSizeUserSet === true ? clampFontSize(state?.fontSizePx) : WRITING_FONT_SIZE_DEFAULT,
      fontSizeUserSet: state?.fontSizeUserSet === true,
      // 排版：预设/字体/行距缺省或脏值回落默认。预设与字号同款「userSet 才回灌」——
      // 否则默认预设升级(如思源宋体)对档里躺着旧默认值的用户永不生效。
      fontPreset:
        state?.fontPresetUserSet === true
          ? normalizeWritingFontPreset(state?.fontPreset)
          : DEFAULT_WRITING_FONT_PRESET,
      fontPresetUserSet: state?.fontPresetUserSet === true,
      customFontFamily: typeof state?.customFontFamily === "string" ? state.customFontFamily.slice(0, 200) : "",
      lineHeight: clampWritingLineHeight(state?.lineHeight),
      // 缺省视为开启（默认 true）：旧档没有该字段时保持检索启用。
      retrievalEnabled: state?.retrievalEnabled ?? true,
      // 缺字段（旧档）→ 归一化空输入即得内置默认集；有档则补齐内置 + 夹取自定义。
      quickActions: normalizeWritingQuickActions(state?.quickActions),
      // 助手 composer 选择记忆:宽松回灌(脏值由渲染端 AGENT_MODELS/agentThinkingOptions 兜底)。
      assistantAgent: typeof state?.assistantAgent === "string" ? state.assistantAgent : null,
      assistantModelByAgent:
        state?.assistantModelByAgent && typeof state.assistantModelByAgent === "object"
          ? state.assistantModelByAgent
          : {},
      assistantThinkingByAgent:
        state?.assistantThinkingByAgent && typeof state.assistantThinkingByAgent === "object"
          ? state.assistantThinkingByAgent
          : {},
      assistantPiProviderId:
        typeof state?.assistantPiProviderId === "string" ? state.assistantPiProviderId : null,
      // 聚焦模式缺省（旧档）视为关闭。
      focusMode: state?.focusMode === true,
      // 禅模式:回灌一律回到普通态(zenMode 瞬态);三项偏好缺省(旧档)回落默认。
      zenMode: false,
      // "the_three" 是已从随包清单裁掉的旧默认:老档写着它的迁到当前默认,
      // 否则主进程按「找不到 → 清单首张」回落,老用户永远看不到新默认背景。
      // 其余 id(含用户主动选的)原样回灌,资产缺失仍由主进程兜底。
      zenBackgroundId:
        typeof state?.zenBackgroundId === "string" &&
        state.zenBackgroundId &&
        state.zenBackgroundId !== "the_three"
          ? state.zenBackgroundId
          : WRITING_ZEN_BACKGROUND_DEFAULT,
      zenSoundOn: state?.zenSoundOn === true,
      zenSoundId:
        typeof state?.zenSoundId === "string" && state.zenSoundId
          ? state.zenSoundId
          : WRITING_ZEN_SOUND_DEFAULT,
      // 左栏文稿列表偏好：枚举脏值回落默认；两个展示开关缺省（旧档）视为开启。
      docSortKey: normalizeDocSortKey(state?.docSortKey),
      docSortOrder: normalizeDocSortOrder(state?.docSortOrder),
      docShowCreatedAt: state?.docShowCreatedAt ?? true,
      docShowExcerpt: state?.docShowExcerpt ?? true,
    }),
}));
