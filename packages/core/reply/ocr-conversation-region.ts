// 已知 IM 主窗口的 OCR 预过滤：在会话重建前先剔除左侧应用导航 / 会话列表，
// 只把右侧“当前打开的对话区”交给 ConversationLayoutBuilder。

import { boxMaxX, boxMidY, boxMinX, type OCRTextBlock } from "./types";

export interface CapturedAppInfo {
  name?: string | null;
  bundleId?: string | null;
}

const KNOWN_MULTI_PANE_IM_PATTERNS = [
  /wechat/i,
  /wework/i,
  /wecom/i,
  /dingtalk/i,
  /lark/i,
  /feishu/i,
  /飞书/,
  /微信/,
  /企业微信/,
  /钉钉/,
];

const IM_TOP_CHROME_MIN_MID_Y = 0.86;
const IM_BOTTOM_TOOLBAR_MAX_MID_Y = 0.16;
const WATERMARK_SEPARATORS = /[@＠◎○◉◯]/gu;
const BOTTOM_TOOLBAR_LABELS = ["快速会议"] as const;

/** 对已知 IM 主窗口，只保留右侧打开对话区；非 IM 或未识别出多栏结构时返回原数组。 */
export function filterOcrBlocksForVisibleConversation(
  blocks: readonly OCRTextBlock[],
  capturedApp: CapturedAppInfo,
): readonly OCRTextBlock[] {
  if (!shouldPreferOcrForVisibleConversation(capturedApp)) return blocks;
  const cleaned = filterKnownImNoiseBlocks(blocks);
  const splitX = estimateConversationPanelMinX(cleaned);
  const conversationBlocks =
    splitX == null
      ? cleaned
      : cleaned.filter((block) => boxMinX(block.boundingBox) >= splitX - 0.006);
  return conversationBlocks;
}

/** 已知多栏 IM 的 AX 常返回整窗文本（含左侧会话列表），应优先走 OCR 当前对话区裁剪。 */
export function shouldPreferOcrForVisibleConversation(capturedApp: CapturedAppInfo): boolean {
  const haystack = `${capturedApp.bundleId ?? ""} ${capturedApp.name ?? ""}`;
  return KNOWN_MULTI_PANE_IM_PATTERNS.some((pattern) => pattern.test(haystack));
}

function estimateConversationPanelMinX(blocks: readonly OCRTextBlock[]): number | null {
  const candidates = [...new Set(blocks.map((block) => round3(boxMinX(block.boundingBox))))]
    .filter((x) => x >= 0.24 && x <= 0.46)
    .sort((a, b) => a - b);

  for (const splitX of candidates) {
    const leftBlocks = blocks.filter((block) => boxMinX(block.boundingBox) < splitX - 0.012);
    const rightBlocks = blocks.filter((block) => boxMinX(block.boundingBox) >= splitX - 0.006);
    if (!looksLikeSidebar(leftBlocks, splitX)) continue;
    if (!looksLikeConversationPanel(rightBlocks)) continue;
    return splitX;
  }
  return null;
}

function looksLikeSidebar(blocks: readonly OCRTextBlock[], splitX: number): boolean {
  const confined = blocks.filter(
    (block) => boxMinX(block.boundingBox) < 0.24 && boxMaxX(block.boundingBox) <= splitX + 0.04,
  );
  if (confined.length < 4) return false;
  const top = Math.max(...confined.map((block) => block.boundingBox.y));
  const bottom = Math.min(...confined.map((block) => block.boundingBox.y));
  return top - bottom >= 0.35;
}

function looksLikeConversationPanel(blocks: readonly OCRTextBlock[]): boolean {
  if (blocks.length < 3) return false;
  const minX = Math.min(...blocks.map((block) => boxMinX(block.boundingBox)));
  const maxX = Math.max(...blocks.map((block) => boxMaxX(block.boundingBox)));
  const top = Math.max(...blocks.map((block) => block.boundingBox.y));
  const bottom = Math.min(...blocks.map((block) => block.boundingBox.y));
  return maxX - minX >= 0.25 && top - bottom >= 0.25;
}

function filterKnownImNoiseBlocks(blocks: readonly OCRTextBlock[]): readonly OCRTextBlock[] {
  const watermarkHints = collectWatermarkHints(blocks);
  let changed = false;
  const filtered = blocks.filter((block) => {
    if (
      !looksLikeTopChromeBlock(block) &&
      !looksLikeBottomToolbarBlock(block) &&
      !looksLikeBackgroundWatermark(block.text, watermarkHints)
    ) {
      return true;
    }
    changed = true;
    return false;
  });
  return changed ? filtered : blocks;
}

interface WatermarkHints {
  readonly personPrefixes: ReadonlySet<string>;
}

function collectWatermarkHints(blocks: readonly OCRTextBlock[]): WatermarkHints {
  const personPrefixes = new Set<string>();
  for (const block of blocks) {
    const parsed = parseFullWatermark(block.text);
    if (!parsed) continue;
    const prefix = parsed.person.slice(0, 2);
    if (prefix.length >= 2) personPrefixes.add(prefix);
  }
  return { personPrefixes };
}

function looksLikeTopChromeBlock(block: OCRTextBlock): boolean {
  return boxMidY(block.boundingBox) >= IM_TOP_CHROME_MIN_MID_Y;
}

function looksLikeBottomToolbarBlock(block: OCRTextBlock): boolean {
  if (boxMidY(block.boundingBox) > IM_BOTTOM_TOOLBAR_MAX_MID_Y) return false;
  if (boxMinX(block.boundingBox) < 0.72) return false;
  const compact = compactText(block.text).replace(/[^\p{L}\p{N}]/gu, "");
  return BOTTOM_TOOLBAR_LABELS.some((label) => compact === label);
}

function looksLikeBackgroundWatermark(text: string, hints: WatermarkHints): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 48) return false;

  if (parseFullWatermark(trimmed)) return true;
  if (looksLikeOrganizationIdWatermark(trimmed)) return true;
  if (looksLikeWatermarkPersonWithSeparatorOnly(trimmed)) return true;
  return looksLikeWatermarkPersonFragment(trimmed, hints);
}

function parseFullWatermark(text: string): { person: string; organization: string } | null {
  const compact = compactText(text);
  const separators = compact.match(WATERMARK_SEPARATORS) ?? [];
  if (separators.length !== 1) return null;

  const separator = separators[0];
  if (!separator) return null;

  const separatorIndex = compact.indexOf(separator);
  const person = compact.slice(0, separatorIndex);
  const organizationWithId = compact.slice(separatorIndex + separator.length);
  const idMatch = organizationWithId.match(/\d{3,}$/u);
  if (!idMatch) return null;

  const organization = organizationWithId.slice(0, -idMatch[0].length);
  if (!person || !organization) return null;
  if (!looksLikeWatermarkNamePart(person, 12)) return null;
  if (!looksLikeWatermarkNamePart(organization, 24)) return null;
  return { person, organization };
}

function looksLikeOrganizationIdWatermark(text: string): boolean {
  const compact = compactText(text);
  const idMatch = compact.match(/\d{3,}$/u);
  if (!idMatch) return false;
  const organization = compact.slice(0, -idMatch[0].length);
  if (organization.length < 4 || organization.length > 24) return false;
  return looksLikeWatermarkNamePart(organization, 24);
}

function looksLikeWatermarkPersonWithSeparatorOnly(text: string): boolean {
  const compact = compactText(text);
  const separators = compact.match(WATERMARK_SEPARATORS) ?? [];
  if (separators.length !== 1) return false;
  const separator = separators[0];
  if (!separator || !compact.endsWith(separator)) return false;
  const person = compact.slice(0, -separator.length);
  return looksLikeWatermarkNamePart(person, 12);
}

function looksLikeWatermarkPersonFragment(text: string, hints: WatermarkHints): boolean {
  if (hints.personPrefixes.size === 0) return false;
  const compact = compactText(text);
  if (compact.length < 2 || compact.length > 4) return false;
  if (!/^\p{Script=Han}+$/u.test(compact)) return false;
  return hints.personPrefixes.has(compact.slice(0, 2));
}

function compactText(text: string): string {
  return text
    .trim()
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[·•∙・]/g, "");
}

function looksLikeWatermarkNamePart(value: string, maxLength: number): boolean {
  if (value.length < 2 || value.length > maxLength) return false;
  return /^[\p{L}\p{N}_-]+$/u.test(value) && /\p{L}/u.test(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
