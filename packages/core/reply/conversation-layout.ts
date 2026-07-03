// 把带坐标的 OCR 文本块重建成会话文稿，替代无结构的逐行拼接。
// 逐函数移植自 ReplyClone ConversationLayoutBuilder.swift，行为契约与其测试一致。

import { boxMaxX, boxMidY, boxMinX, type OCRTextBlock } from "./types";

/** 对话重建的可选启发式参数（噪声标记 / 系统事件前缀）。 */
export interface ConversationLayoutOptions {
  /** 含这些标记的文本块（如输入框占位符）在重建前直接过滤。 */
  noiseMarkers?: readonly string[];
  /**
   * 系统事件气泡的文案前缀（通话已取消 / 未接听等）。这类气泡常带被 OCR
   * 误读成残字的图标，故按「前缀匹配 + 总长不超过前缀 +4 字」判定后整块丢弃。
   */
  systemEventPrefixes?: readonly string[];
}

/**
 * 把带坐标的 OCR 文本块重建成会话文稿：
 * 1) 剔除左侧聊天列表 / 图标栏等侧栏列，只保留当前会话面板；
 * 2) 面板内按左右对齐区分「对方 / 我」，居中的块（时间戳 / 系统提示）转分隔行；
 * 3) 按 y 从上到下排序，相邻同侧行合并为同一条消息。
 */
export class ConversationLayoutBuilder {
  private readonly noiseMarkers: readonly string[];
  private readonly systemEventPrefixes: readonly string[];

  constructor(options: ConversationLayoutOptions = {}) {
    this.noiseMarkers = options.noiseMarkers ?? [];
    this.systemEventPrefixes = options.systemEventPrefixes ?? [];
  }

  /** 重建会话文稿；无法辨认结构时返回空串，由调用方决定兜底方式。 */
  transcript(blocks: readonly OCRTextBlock[]): string {
    const cleaned = blocks.filter((block) => {
      const text = block.text.trim();
      if (text.length === 0 || !containsMeaningfulText(text)) return false;
      // 窗口最顶部是标题栏（联系人名 / 工具条），不属于会话内容
      if (boxMidY(block.boundingBox) >= 0.95) return false;
      if (
        this.systemEventPrefixes.some(
          (prefix) => text.startsWith(prefix) && text.length <= prefix.length + 4,
        )
      ) {
        return false;
      }
      return !this.noiseMarkers.some((marker) => text.includes(marker));
    });
    if (cleaned.length === 0) return "";

    const panelBlocks = conversationPanelBlocks(cleaned);
    const minXs = panelBlocks.map((b) => boxMinX(b.boundingBox));
    const maxXs = panelBlocks.map((b) => boxMaxX(b.boundingBox));
    const panelMinX = Math.min(...minXs);
    const panelMaxX = Math.max(...maxXs);
    if (!(panelMaxX > panelMinX)) return "";
    const panelWidth = panelMaxX - panelMinX;

    // Vision 原点在左下：y 越大越靠上、消息越早，故按 midY 降序；同一行按 x 从左到右
    const ordered = [...panelBlocks].sort((a, b) => {
      const ma = boxMidY(a.boundingBox);
      const mb = boxMidY(b.boundingBox);
      if (Math.abs(ma - mb) > 0.01) return mb - ma;
      return boxMinX(a.boundingBox) - boxMinX(b.boundingBox);
    });

    // 先把相邻的「行」聚成「气泡」，再以整个气泡的联合包围盒判断归属：
    // 右侧长消息换行后的续行偏左，逐行判断会被误归给对方，整气泡判断才稳定
    const bubbles: OCRTextBlock[][] = [];
    for (const block of ordered) {
      const lastBubble = bubbles.at(-1);
      const previous = lastBubble?.at(-1);
      if (lastBubble && previous && isSameBubble(previous, block)) {
        lastBubble.push(block);
      } else {
        bubbles.push([block]);
      }
    }

    const lines: string[] = [];
    for (const bubble of bubbles) {
      const bubbleMinX = Math.min(...bubble.map((b) => boxMinX(b.boundingBox)));
      const bubbleMaxX = Math.max(...bubble.map((b) => boxMaxX(b.boundingBox)));
      const leftMargin = (bubbleMinX - panelMinX) / panelWidth;
      const rightMargin = (panelMaxX - bubbleMaxX) / panelWidth;
      const text = bubble.map((b) => b.text.trim()).join(" ");

      // 两侧留白接近且都不小 → 居中块（时间戳 / 系统提示）：作为 [分隔行] 保留时间
      // 结构，不归属任何一方。容差放宽到 0.25，因为面板边界可能被图片内文字等噪声
      // 带偏；真正的气泡总有一侧留白 < 0.18，不会被误判。
      if (Math.abs(leftMargin - rightMargin) < 0.25 && Math.min(leftMargin, rightMargin) > 0.18) {
        // 去掉两端被 OCR 误读的符号残渣（如尾部的 "|"）
        const stamp = trimToAlphanumericEdges(text);
        if (stamp.length > 0) lines.push(`[${stamp}]`);
        continue;
      }
      // 气泡更贴近哪一侧边缘就归属哪一方：右对齐是「我」，左对齐是「对方」
      const mine = rightMargin < leftMargin;
      lines.push(`${mine ? "我" : "对方"}：${text}`);
    }
    return lines.join("\n");
  }
}

/**
 * 相邻两行是否属于同一个气泡：垂直间距小于行高的 0.7 倍且 x 区间有重叠。
 * 气泡之间隔着内边距和消息间距，行距比气泡内换行明显更大。
 */
function isSameBubble(upper: OCRTextBlock, lower: OCRTextBlock): boolean {
  const gap = upper.boundingBox.y - (lower.boundingBox.y + lower.boundingBox.height);
  const reference = Math.max(upper.boundingBox.height, lower.boundingBox.height);
  if (!(gap < reference * 0.7)) return false;
  const overlap =
    Math.min(boxMaxX(upper.boundingBox), boxMaxX(lower.boundingBox)) -
    Math.max(boxMinX(upper.boundingBox), boxMinX(lower.boundingBox));
  return overlap > 0;
}

/**
 * 是否含有效文字（CJK 或 ≥2 个连续拉丁字母）；
 * 语音时长（● 4"）、表情符号等纯符号 / 数字块没有对话价值，直接剔除。
 */
function containsMeaningfulText(text: string): boolean {
  let letterRun = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) {
      return true;
    }
    // ASCII 字母：连续 2 个即视为有意义（对应源项目 CharacterSet.letters + isASCII）
    if (cp < 128 && ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a))) {
      letterRun += 1;
      if (letterRun >= 2) return true;
    } else {
      letterRun = 0;
    }
  }
  return false;
}

/**
 * 去掉字符串两端非「字母 / 数字」的字符（对应 Swift
 * trimmingCharacters(in: .alphanumerics.inverted)），用于清洗时间戳尾部残渣。
 * 中间字符保持不动（空格 / 冒号仍保留）。
 */
function trimToAlphanumericEdges(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

/**
 * 侧栏剔除（启发式）：把所有块的 x 区间按重叠合并成若干「列」，
 * 从右往左找一条起点 ≤ 0.4 的纵向空隙——若空隙左侧内容跨度 ≤ 0.35
 * 而右侧跨度 ≥ 0.45，左侧就是聊天列表 / 图标栏，整体丢弃。
 * 检测不到该结构时原样保留（独立聊天窗口本来就没有侧栏）。
 */
function conversationPanelBlocks(blocks: readonly OCRTextBlock[]): readonly OCRTextBlock[] {
  const intervals = blocks
    .map((b) => ({ lower: boxMinX(b.boundingBox), upper: boxMaxX(b.boundingBox) }))
    .sort((a, b) => a.lower - b.lower);

  const columns: { lower: number; upper: number }[] = [];
  for (const interval of intervals) {
    const last = columns.at(-1);
    if (last && interval.lower <= last.upper + 0.01) {
      last.upper = Math.max(last.upper, interval.upper);
    } else {
      columns.push({ ...interval });
    }
  }
  const first = columns[0];
  const last = columns.at(-1);
  if (columns.length <= 1 || !first || !last) return blocks;

  for (let index = columns.length - 2; index >= 0; index -= 1) {
    const gapColumn = columns[index];
    const panelColumn = columns[index + 1];
    if (!gapColumn || !panelColumn) continue;
    const gapStart = gapColumn.upper;
    const panelLower = panelColumn.lower;
    if (gapStart > 0.4) continue;
    const leftSpan = gapStart - first.lower;
    const rightSpan = last.upper - panelLower;
    if (leftSpan <= 0.35 && rightSpan >= 0.45) {
      return blocks.filter((b) => boxMinX(b.boundingBox) >= panelLower - 0.005);
    }
  }
  return blocks;
}
