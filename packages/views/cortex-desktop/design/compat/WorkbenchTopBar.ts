// Kun chat/WorkbenchTopBar 的类型垫层：design 树只消费 RightPanelMode 联合类型。
// 与 Kun 侧 RightPanelMode 对齐:code canvas 提示流程会切到 "canvas" 模式。
export type RightPanelMode = "todo" | "changes" | "browser" | "file" | "plan" | "canvas";
