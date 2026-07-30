// workflow-sticky.ts — 便签(sticky note)节点的共享常量：调色板、默认文案与尺寸。
// 纯数据、无 React 依赖，供 createWorkflowNode(工厂)、StickyNoteNode(画布组件)、
// StickyNoteForm(配置面板)、画布右键改色菜单共用，避免色值/默认值在多处漂移。
//
// ⚠️ 便签是画布注释，不参与执行；颜色用柔和底色(浅色画布 + 深色文字可读)。

/** 便签预设调色板。value 为卡片背景十六进制色，label 供改色菜单/选择器展示。 */
export const STICKY_NOTE_COLORS: ReadonlyArray<{ value: string; label: string }> =
  [
    { value: "#fde7ea", label: "粉" },
    { value: "#fef3c7", label: "黄" },
    { value: "#dbeafe", label: "蓝" },
    { value: "#dcfce7", label: "绿" },
    { value: "#ede9fe", label: "紫" },
    { value: "#ffedd5", label: "橙" },
    { value: "#f1f5f9", label: "灰" },
  ];

/** 默认背景色（取调色板首色，粉色——与设计稿一致）。 */
export const STICKY_DEFAULT_COLOR = STICKY_NOTE_COLORS[0]!.value;

/** 默认卡片尺寸（px）。 */
export const STICKY_DEFAULT_WIDTH = 240;
export const STICKY_DEFAULT_HEIGHT = 160;

/** 缩放下限，避免便签被拖到不可用的尺寸。 */
export const STICKY_MIN_WIDTH = 120;
export const STICKY_MIN_HEIGHT = 80;

/** 默认正文（Markdown 源）：标题 + 加粗提示，渲染后形如设计稿。 */
export const STICKY_DEFAULT_CONTENT = "## I'm a note\n\n**Double click** to edit me.";

/** 校验/兜底色值：非预设色（如手改 JSON）回落默认色，避免渲染异常背景。 */
export function normalizeStickyColor(color: unknown): string {
  if (typeof color !== "string") return STICKY_DEFAULT_COLOR;
  // 接受任意 #rgb/#rrggbb 十六进制（用户可能自定义），否则回落默认。
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : STICKY_DEFAULT_COLOR;
}
