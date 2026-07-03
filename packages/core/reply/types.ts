// packages/core/reply 会话链路的共享类型契约（纯 Foundation 级，无 Node / DOM 依赖）。
// 移植自 ReplyClone 的 ReplyCore；供 core 纯逻辑与 apps/desktop 主进程共用。

// ── OCR 坐标系契约（务必遵守）─────────────────────────────────────────────────
//
// OCRBoundingBox 采用 **Vision 归一化坐标系**：
//   - 取值范围 0~1（相对窗口截图宽高归一化）；
//   - **原点在左下角**，y 越大越靠屏幕上方 → 对话中越早的消息 y 越大。
//
// 责任划分：坐标系转换由 helper 输出侧负责——helper 把 Vision 结果按此契约喂进来，
// core 侧的对话重建（conversation-layout）直接假定「原点左下、y 越大越靠上」，
// 不再做任何坐标翻转。若接入的识别引擎原点在左上，转换必须在 helper 侧完成。

/** 归一化包围盒（Vision 坐标系：0~1，原点左下）。用普通对象而非 CGRect，保持纯 TS 可测。 */
export interface OCRBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** OCR 识别出的一段文本及其归一化位置。 */
export interface OCRTextBlock {
  readonly text: string;
  readonly boundingBox: OCRBoundingBox;
}

/** 包围盒左边界（x 起点）。 */
export function boxMinX(box: OCRBoundingBox): number {
  return box.x;
}

/** 包围盒右边界（x + width）。 */
export function boxMaxX(box: OCRBoundingBox): number {
  return box.x + box.width;
}

/** 包围盒垂直中点（原点左下，故 midY 越大越靠上）。 */
export function boxMidY(box: OCRBoundingBox): number {
  return box.y + box.height / 2;
}
