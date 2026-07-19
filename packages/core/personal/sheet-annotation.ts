// 表格批注 → agent prompt 合成（内置表格预览的「批注发送到会话」功能核心）。
// 批注是 UI 层临时态（不写入 xlsx 文件本身）:每条绑定 sheet 名 + A1 地址 + 值/公式快照,
// 发送时合成一段结构化中文 prompt 注入聊天 composer,由 agent 自行读改磁盘上的表格文件。
// 纯函数、无 React/DOM 依赖,放 core 便于单测——范式对齐 design/canvas/image-annotation-prompt.ts。

export interface SheetAnnotation {
  id: string;
  sheetName: string;
  // "B3" 或 "B3:D5"（A1 记法,已含起止）。
  rangeA1: string;
  // 选区当前显示值快照（多格压平为逗号/省略号,由采集方截断);发送后 agent 可据此定位语境。
  valueSnapshot: string;
  // 单格公式（含 "=" 前缀）;无公式或多格选区则缺省。
  formula?: string;
  // 用户写的批注文字。
  note: string;
  createdAt: number;
}

// 逐条批注行:`1. [Sheet1 · B3] 当前值「1200」（公式 =A2*12）——批注：改成按季度汇总`
function annotationLine(index: number, a: SheetAnnotation): string {
  const parts = [`${index + 1}. [${a.sheetName} · ${a.rangeA1}]`];
  if (a.valueSnapshot) parts.push(`当前值「${a.valueSnapshot}」`);
  if (a.formula) parts.push(`（公式 ${a.formula}）`);
  return `${parts.join(" ")}——批注：${a.note.trim()}`;
}

// 合成发给 agent 的完整 prompt。filePath 必须是磁盘绝对路径（agent 直接读改该文件）。
export function buildSheetAnnotationPrompt(filePath: string, annotations: readonly SheetAnnotation[]): string {
  const lines: string[] = [
    "我在表格文件里对若干单元格/区域做了批注，请你据此直接修改磁盘上的这个文件：",
    `文件：${filePath}`,
    "",
    "批注（逐条对应一处修改）：",
  ];
  annotations.forEach((a, i) => lines.push(annotationLine(i, a)));
  lines.push(
    "",
    "请用能读写该表格格式的方式（如 Python 脚本）打开文件，只修改批注指向的单元格/区域，",
    "其余单元格、公式与格式尽量保持不变，完成后保存回原路径。",
  );
  return lines.join("\n");
}

// 会话气泡/toast 用的短文案:取首条批注,多条时带计数。
export function sheetAnnotationDisplayText(annotations: readonly SheetAnnotation[]): string {
  if (annotations.length === 0) return "按表格批注修改";
  const first = annotations[0]!;
  const head = `按表格批注修改：[${first.rangeA1}] ${first.note.trim()}`;
  return annotations.length > 1 ? `${head} 等 ${annotations.length} 条` : head;
}
