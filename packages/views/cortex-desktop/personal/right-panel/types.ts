// 右栏面板注册表的类型合同。descriptor = 纯数据 + 三个受限函数槽（usePresence /
// renderHead / headMode 由 headClassName 辅助），宿主(PersonalRightPanel)据此通用渲染。
// 设计约束（与用户共识,2026-08-21）：
// - 纯数据字段天然可序列化,是未来第三方沙箱面板 API 的种子;函数槽是内部特权,不对外开放。
// - 组件槽 load 为懒加载形状（() => import(...)),每个面板独立 chunk,首开才解析。
// - CSS 宽度档仍由 cortex-desktop.css 的 :has(面板根类名) 规则驱动,本合同的 widthTier
//   只喂 JS 侧二档（拖拽时给中栏保留 660/488,见 PersonalRightPanel.reservedWidthForView）。

import type * as React from "react";

export type PanelWidthTier = "normal" | "wide";

export interface RightPanelDescriptor {
  /** 面板 id,即 store 的 rightView 值。core 侧是 string 通道,合法清单以注册表为准。 */
  id: string;
  /** 默认头部标题（renderHead 缺省时由宿主渲染）。 */
  title: string;
  /** rail 图标（有 rail 字段的面板必填,registry 单测兜底）。 */
  icon?: React.ComponentType<{ size?: number }>;
  /** 拖拽调宽时给中栏保留的档位:wide=660(产物级宽面板),normal=488。 */
  widthTier: PanelWidthTier;
  /**
   * 放大（绝对定位盖住中栏）开放策略。"filePreview" 是数据令牌(非函数,守住纯数据约束):
   * 仅文件预览态可放大,files 面板专用——列表态盖上去用户会以为会话不见了。
   */
  canMaximize: boolean | "filePreview";
  /** 出现在右侧竖向工具栏（PersonalRightRail）;order 决定排序。缺省 = 无常驻入口。 */
  rail?: { order: number };
  /**
   * 自定义 hook:返回 false 时宿主自动收起面板（产物被清空/研究解绑等空态）。
   * 经 <PresenceGuard key={id}> 调用,切面板即重挂载,Hook 调用序列恒定。
   */
  usePresence?: () => boolean;
  /** 自定义头部行内容（组件而非渲染函数——内部可用 hooks,如 artifact 头判 slides）。 */
  renderHead?: React.ComponentType;
  /** "none" = 整行头部不渲染（canvas 画板自带工具栏）。缺省 "default"。 */
  headMode?: "default" | "none";
  /** 附加在 .pw-rp-head 上的类名（subagents 的 "is-subagents",CSS/测试契约）。 */
  headClassName?: string;
  /** 面板主体的懒加载入口,default export 为经 PanelHost 适配的 wrapper 组件。 */
  load: () => Promise<{ default: React.ComponentType }>;
}

// ── 面板载荷类型映射（openPanel/consumePanelRequest 的类型安全来源）──────────────
// 无载荷面板（skills/canvas/subagents/artifact/research/piArtifacts）不入 map。

/** files 是唯一「一面板多请求类型」:kind 判别联合区分整仓 diff 与单文件预览。 */
export type FilesPanelPayload =
  | { kind: "gitDiff"; projectId: string }
  | { kind: "filePreview"; projectId: string; path: string; name: string };

export interface PanelPayloadMap {
  files: FilesPanelPayload;
  /** 原 taskDetailRequest:打开某 task 文件详情。 */
  todos: { projectId: string; path: string; name: string };
  /** 原 noteDetailRequest:打开某闪记详情。 */
  notes: { noteId: string };
  /** 原 browserUrlRequest:内嵌浏览器导航。nonce 由统一槽提供,消费端按 nonce 去重、不 consume。 */
  browser: { url: string };
  /** 原 knowledgeDocRequest:拉取知识库文档正文。同 browser 为 nonce 订阅型。 */
  knowledge: { sourceId: string; relPath: string };
}
