// 从 OCR 结果反推「输入框锚点」屏幕矩形——微信 4.x 等 AX 内容树完全为空的应用
// （实测仅暴露标题栏按钮，AXManualAccessibility/AXEnhancedUserInterface 均被拒），
// caret / 焦点输入框 / AX 扫描锚全部落空，此时唯一可靠的输入框位置信号是截图 OCR：
//   L1 输入框 placeholder 行（「输入文字，或按住Fn使用语音输入」）——空输入框主场景，精确到行；
//   L2 会话区分栏线 splitX + 窗口底缘固定偏移——正在输入草稿（placeholder 消失）时的结构兜底。
// 都不可得则返回 null，由上层沿用 windowFrame / 鼠标兜底链。

import { estimateConversationPanelMinX } from "./ocr-conversation-region";
import { boxMidY, type OCRTextBlock } from "./types";

/** 屏幕矩形（左上原点、y 向下、point）——与 desktop 侧 ReplyRect 结构兼容的本地契约。 */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// 已知 IM 输入框 placeholder 片段（compact 化后 includes 匹配，容忍 OCR 拆行/丢标点）。
// 微信中文:「输入文字，或按住Fn使用语音输入」；英文界面 "Type a message"。
const INPUT_PLACEHOLDER_FRAGMENTS = ["输入文字", "按住fn", "typeamessage"] as const;

// placeholder 必须位于窗口下部（Vision 左下原点，midY 越小越靠底）；
// 上限 0.45 而非更紧，是为了容忍输入区被多行草稿撑高的情形，同时仍能排除顶部搜索框与消息正文。
const PLACEHOLDER_MAX_MID_Y = 0.45;

// L2 结构兜底：输入框首行距窗口底缘的固定偏移（point）。微信输入区（文本行+工具条）
// 物理高度 ~120-160pt 且**不随窗口高度等比缩放**，固定偏移比按比例（旧 82%）稳定得多；
// 取值依实拍：902x727 窗口下输入框顶距底缘 ≈122pt。
export const OCR_INPUT_BAR_BOTTOM_OFFSET = 120;

/** 归一化文本：去空白 + NFKC + 转小写，抹平 OCR 的空格/全半角噪声。 */
function compactLower(text: string): string {
  return text.trim().normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function isPlaceholderText(text: string): boolean {
  const compact = compactLower(text);
  if (compact.length === 0) return false;
  return INPUT_PLACEHOLDER_FRAGMENTS.some((fragment) => compact.includes(fragment));
}

/**
 * 从 OCR blocks（Vision 归一化坐标，原点左下）+ 被截窗口屏幕 bounds（左上原点 point）
 * 推导输入框锚点屏幕矩形。命中 L1 返回 placeholder 行的精确 rect（气泡贴其下方，
 * 输入法候选窗语义）；命中 L2 返回 height=0 的「输入首行」合成锚；否则 null。
 */
export function ocrInputBarAnchor(
  blocks: readonly OCRTextBlock[],
  windowBounds: ScreenRect,
): ScreenRect | null {
  if (windowBounds.width <= 0 || windowBounds.height <= 0) return null;
  if (blocks.length === 0) return null;

  // L1：placeholder 行（多命中取最靠底部的——上半部可能出现聊天内容里的同款文案）。
  const placeholder = blocks
    .filter((b) => isPlaceholderText(b.text) && boxMidY(b.boundingBox) <= PLACEHOLDER_MAX_MID_Y)
    .sort((a, b) => boxMidY(a.boundingBox) - boxMidY(b.boundingBox))[0];
  if (placeholder) {
    const box = placeholder.boundingBox;
    return {
      x: windowBounds.x + box.x * windowBounds.width,
      // Vision 原点左下 → 屏幕 top-left：行顶 = 1 - y - height
      y: windowBounds.y + (1 - box.y - box.height) * windowBounds.height,
      width: box.width * windowBounds.width,
      height: box.height * windowBounds.height,
    };
  }

  // L2：分栏线 + 底缘固定偏移。x 贴右侧对话区左缘（避开会话列表），y 用物理偏移而非比例。
  const splitX = estimateConversationPanelMinX(blocks);
  if (splitX == null) return null;
  const anchorY = windowBounds.y + windowBounds.height - OCR_INPUT_BAR_BOTTOM_OFFSET;
  // 矮窗口保护：合成锚不高于窗口中线，防止气泡盖进消息区中部。
  const clampedY = Math.max(anchorY, windowBounds.y + windowBounds.height / 2);
  return {
    x: windowBounds.x + splitX * windowBounds.width,
    y: clampedY,
    width: windowBounds.width * (1 - splitX),
    height: 0,
  };
}
