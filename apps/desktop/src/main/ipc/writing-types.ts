// 写作工作区（writing）持久化契约：写作空间列表 + 当前活跃空间 id。
// ⚠️ 与 packages/core/desktop/writing-types.ts 逐字镜像（双写契约，改动两处必须同步）。
// 一空间一根目录：默认空间根在 Documents/cortex/writing（fs 白名单内零配置可用），
// 用户可经系统目录选择器添加空间（根落在白名单外时由 fs.allowedRoots 兜底放行）。

// 单个写作空间：id（内部稳定标识）、name（展示名，默认取根目录 basename）、root（绝对路径）。
// isDefault：ensureDefaultSpace 建的那个空间为 true，UI 在其行下渲染「默认写作空间」副标。
// 缺省（旧档 / 用户手动添加的空间）视为 false。
export interface WritingSpace {
  id: string;
  name: string;
  root: string;
  isDefault?: boolean;
}

// 一条写作助手会话的元数据（U8）：id（threadUuid，参与 sessionId 组装）、title（展示名，
// 首轮由用户正文派生）、spaceId（归属空间）、resumeSessionId（agent 侧真实会话 id，续接用）。
// 消息本体不持久化（重启后靠 resumeSessionId 让 agent 续上下文，见 run-manager）。
export interface WritingThreadMeta {
  id: string;
  title: string;
  spaceId: string;
  resumeSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

// 中栏编辑器视图档位：rich（富文本所见即所得）/ source（源码）/ live（实时预览）/ preview（仅预览）。
// 对应 Kun WritePreviewMode 的子集（Kun 另有 split 分屏，本仓库不支持）。
export type WritingPreviewMode = "rich" | "source" | "live" | "preview";

// 选中文字工具栏「快捷指令」处理方式：chat=把 prompt 填进助手输入框（不自动发送）；
// edit=对选区就地改写（走 ⌘K 同款 inline-edit → 红绿 diff 审阅链路）。
export type WritingQuickActionMode = "chat" | "edit";

// 一条快捷指令：id（内置为固定 id；自定义为 custom-*）；label/prompt（内置留空=用 i18n 内置默认）；
// mode；enabled（内置可禁用不可删，自定义恒 true 且可删）。对齐 Kun WriteQuickActionV1 + 附加 enabled。
export interface WritingQuickAction {
  id: string;
  label: string;
  prompt: string;
  mode: WritingQuickActionMode;
  enabled: boolean;
}

// 写作空间 UI/持久化态：空间列表 + 当前活跃空间 id（无空间时为 null）+ 会话元数据 + 编辑器视图偏好。
// 替代 Kun 侧 localStorage（core 禁用 localStorage），经 PersistedState.writingUi 分片落盘。
export interface WritingUiState {
  spaces: WritingSpace[];
  activeSpaceId: string | null;
  // 全部会话元数据（跨空间扁平列表，按 spaceId 归属）。缺省视为空（兼容旧档）。
  threads?: WritingThreadMeta[];
  // 每空间最后活跃的会话 id（重进恢复上次会话）。缺省视为空。
  activeThreadBySpace?: Record<string, string | null>;
  // 编辑器视图档位（跨空间共享，中栏工具栏切换）。缺省视为 "live"（兼容旧档）。
  previewMode?: WritingPreviewMode;
  // 编辑器字号 px（中栏工具栏步进，Kun 口径 10–48，默认 16）。缺省回落默认（兼容旧档）。
  fontSizePx?: number;
  // 工作区级检索上下文开关（U4，跨空间共享）。缺省视为开启（默认 true，兼容旧档）。
  retrievalEnabled?: boolean;
  // 选中文字工具栏「快捷指令」配置（跨空间共享，对齐 Kun selectionAssist.quickActions）。缺省视为内置默认集。
  quickActions?: WritingQuickAction[];
}
