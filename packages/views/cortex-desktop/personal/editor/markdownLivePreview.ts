// CodeMirror 6「实时预览(Live)」扩展:未被光标/选区触及的行把 markdown 标记隐藏/渲染成成品,
// 光标或选区触及的行还原源码可编辑。移植自 Kun src/renderer/src/write/markdown-live-preview.ts,
// 剥离 Kun 特有耦合(计划 KTD6):
//   - 删除 infographic / html-embed 分支与对应 import。
//   - 图片仅内联 http(s): / data: URI;本地相对路径返回 null → 退化为普通 markdown 文本
//     (不再依赖 markdown-image / @shared/write-markdown-resource / window.cortexGui)。
//   - 去掉 markdownImageContextFacet 与 writeMarkdownLivePreviewExtensions 的 filePath/workspaceRoot 参数。
// 代码块/表格 widget 见 ./markdownLiveWidgets。

import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import {
  RangeSetBuilder,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  CodeBlockToolbarWidget,
  CodeBlockWidget,
  HrWidget,
  ImageWidget,
  ListBulletWidget,
  TableWidget,
  TaskCheckboxWidget,
  closingFencePattern,
  openingFence,
  parseFencedCodeBlock,
  type CodeBlockRange,
  type ParsedTable,
} from "./markdownLiveWidgets";

type DecorationRange = {
  from: number;
  to: number;
  deco: Decoration;
};

type BlockRange = {
  from: number;
  to: number;
};

const CONCEAL_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "LinkMark",
  "URL",
  "QuoteMark",
]);

const hideMark = Decoration.mark({ class: "cm-write-md-hidden-mark" });
const centerLineDeco = Decoration.line({ class: "cm-write-md-center-line" });
const blockquoteLineDeco = Decoration.line({ class: "cm-write-md-blockquote-line" });
const autolinkDeco = Decoration.mark({ class: "cm-write-md-link-text" });
const markDeco = Decoration.mark({ class: "cm-write-md-mark" });
const codeBlockLineDeco = Decoration.line({ class: "cm-write-md-codeblock-line" });

const writeMarkdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.875em", fontWeight: "700", letterSpacing: "-0.02em" },
  { tag: tags.heading2, fontSize: "1.5em", fontWeight: "650", letterSpacing: "-0.015em" },
  { tag: tags.heading3, fontSize: "1.25em", fontWeight: "650" },
  { tag: tags.heading4, fontSize: "1.06em", fontWeight: "650" },
  { tag: tags.heading5, fontSize: "1em", fontWeight: "650" },
  { tag: tags.heading6, fontSize: "0.95em", fontWeight: "650", color: "var(--text-2)" },
  { tag: tags.processingInstruction, color: "var(--text-3)", opacity: "0.58" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.monospace,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: "0.9em",
    backgroundColor: "color-mix(in srgb, var(--text-1) 6%, transparent)",
    borderRadius: "5px",
  },
  { tag: tags.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--text-3)", fontSize: "0.86em" },
  { tag: tags.quote, color: "var(--text-2)" },
  { tag: tags.meta, color: "var(--text-3)" },
]);

const writeMarkdownLiveTheme = EditorView.theme({
  "&.cm-write-live-preview .cm-activeLine": {
    backgroundColor: "transparent",
  },
  "&.cm-write-live-preview .cm-line": {
    paddingTop: "0.18rem",
    paddingBottom: "0.18rem",
  },
  "&.cm-write-live-preview .cm-write-md-center-line": {
    textAlign: "center",
  },
  "&.cm-write-live-preview .cm-write-md-blockquote-line": {
    borderLeft: "3px solid color-mix(in srgb, var(--text-1) 78%, transparent)",
    color: "var(--text-1)",
    paddingLeft: "1em",
  },
  "&.cm-write-live-preview .cm-write-md-link-text": {
    color: "var(--accent)",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
  "&.cm-write-live-preview .cm-write-md-mark": {
    borderRadius: "4px",
    backgroundColor: "color-mix(in srgb, #f7d154 48%, transparent)",
    padding: "0 2px",
  },
});

// 行内标记的揭示集入口(ViewPlugin 用),委托给下面的纯函数。
function collectRevealLines(view: EditorView): Set<number> {
  return collectRevealLinesFromState(view.state, view.hasFocus);
}

// 揭示集 = 选区(空 caret 或拖拽选区)触及的所有行。刻意不区分选区空/非空:
// 旧实现对非空选区「隐藏一切」,拖拽时选区在空↔非空间反复切换,conceal 状态振荡、
// 行内宽度来回变化,导致选择文本时剧烈抖动、无法精准选中;现与块级 widget
// (markdownBlockPreviewField)的「选区触及即揭示」规则保持一致。
function collectRevealLinesFromState(state: EditorState, hasFocus: boolean): Set<number> {
  if (!hasFocus) return new Set();
  return collectActiveLinesFromState(state);
}

function collectActiveLinesFromState(state: EditorState): Set<number> {
  const active = new Set<number>();
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let line = start; line <= end; line += 1) active.add(line);
  }
  return active;
}

function nodeTouchesActiveLine(view: EditorView, from: number, to: number, activeLines: Set<number>): boolean {
  return rangeTouchesActiveLine(view.state, from, to, activeLines);
}

function rangeTouchesActiveLine(state: EditorState, from: number, to: number, activeLines: Set<number>): boolean {
  const start = state.doc.lineAt(from).number;
  const end = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let line = start; line <= end; line += 1) {
    if (activeLines.has(line)) return true;
  }
  return false;
}

function parseMarkdownImageSource(source: string): { alt: string; rawSrc: string } | null {
  const match = /^!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)$/.exec(source.trim());
  if (!match) return null;
  return { alt: match[1] || "", rawSrc: match[2] ?? match[3] ?? "" };
}

// 仅内联远程 / data URI 图片;本地相对路径返回 null,让该图片 markdown 退化为普通文本
// (计划 KTD6:不接 workspace 图片解析)。
function markdownImageFromSource(source: string): { src: string; alt: string } | null {
  const parsed = parseMarkdownImageSource(source);
  if (!parsed) return null;
  const { alt, rawSrc } = parsed;
  if (!/^(?:https?:|data:)/i.test(rawSrc)) return null;
  return { alt, src: rawSrc };
}

function splitTableLine(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseMarkdownTable(source: string): ParsedTable | null {
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = splitTableLine(lines[0] ?? "");
  const delimiter = splitTableLine(lines[1] ?? "");
  if (headers.length === 0 || delimiter.length !== headers.length) return null;
  const validDelimiter = delimiter.every((cell) => /^:?-{3,}:?$/.test(cell));
  if (!validDelimiter) return null;
  const rows = lines.slice(2).map((line) => {
    const cells = splitTableLine(line);
    while (cells.length < headers.length) cells.push("");
    return cells.slice(0, headers.length);
  });
  return { headers, rows };
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitTableLine(trimmed).length >= 2;
}

function looksLikeTableDelimiter(line: string, expectedCells: number): boolean {
  const delimiter = splitTableLine(line);
  return delimiter.length === expectedCells && delimiter.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function collectMarkdownTableRanges(
  view: EditorView,
  from: number,
  to: number,
  activeLines: Set<number>,
): Array<BlockRange & { table: ParsedTable }> {
  return collectMarkdownTableRangesFromState(view.state, from, to, activeLines);
}

function collectMarkdownTableRangesFromState(
  state: EditorState,
  from: number,
  to: number,
  activeLines: Set<number>,
): Array<BlockRange & { table: ParsedTable }> {
  const tables: Array<BlockRange & { table: ParsedTable }> = [];
  let line = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to).number;

  while (line.number < endLine) {
    const headerText = line.text;
    if (!looksLikeTableRow(headerText)) {
      if (line.to >= to) break;
      line = state.doc.line(line.number + 1);
      continue;
    }

    const delimiterLine = state.doc.line(line.number + 1);
    const headers = splitTableLine(headerText);
    if (!looksLikeTableDelimiter(delimiterLine.text, headers.length)) {
      if (line.to >= to) break;
      line = state.doc.line(line.number + 1);
      continue;
    }

    let lastLine = delimiterLine;
    let nextNumber = delimiterLine.number + 1;
    while (nextNumber <= state.doc.lines) {
      const nextLine = state.doc.line(nextNumber);
      if (!looksLikeTableRow(nextLine.text)) break;
      lastLine = nextLine;
      nextNumber += 1;
    }

    if (!rangeTouchesActiveLine(state, line.from, lastLine.to, activeLines)) {
      const source = state.doc.sliceString(line.from, lastLine.to);
      const table = parseMarkdownTable(source);
      if (table) tables.push({ from: line.from, to: lastLine.to, table });
    }

    if (lastLine.number >= endLine || lastLine.to >= to) break;
    line = state.doc.line(lastLine.number + 1);
  }

  return tables;
}

function collectMarkdownCodeBlockRanges(
  view: EditorView,
  from: number,
  to: number,
  activeLines: Set<number>,
): CodeBlockRange[] {
  return collectMarkdownCodeBlockRangesFromState(view.state, from, to, activeLines);
}

function collectMarkdownCodeBlockRangesFromState(
  state: EditorState,
  from: number,
  to: number,
  _activeLines: Set<number>,
): CodeBlockRange[] {
  const blocks: CodeBlockRange[] = [];
  let line = state.doc.line(1);
  const rangeFrom = Math.max(0, from);
  const rangeTo = Math.max(rangeFrom, to);

  while (line.number <= state.doc.lines) {
    const fence = openingFence(line.text);
    if (!fence) {
      if (line.number >= state.doc.lines) break;
      line = state.doc.line(line.number + 1);
      continue;
    }

    const closePattern = closingFencePattern(fence.marker);
    let lastLine = line;
    let nextNumber = line.number + 1;
    while (nextNumber <= state.doc.lines) {
      const nextLine = state.doc.line(nextNumber);
      lastLine = nextLine;
      if (closePattern.test(nextLine.text)) break;
      nextNumber += 1;
    }

    if (lastLine.to >= rangeFrom && line.from <= rangeTo) {
      const source = state.doc.sliceString(line.from, lastLine.to);
      blocks.push({ from: line.from, to: lastLine.to, block: parseFencedCodeBlock(source) });
    }

    if (lastLine.number >= state.doc.lines) break;
    line = state.doc.line(lastLine.number + 1);
  }

  return blocks;
}

export const markdownLivePreviewTestInternals = {
  collectMarkdownCodeBlockRangesFromState,
  collectRevealLinesFromState,
  markdownImageFromSource,
};

function addFencedCodeLineDecorations(
  view: EditorView,
  block: CodeBlockRange,
  activeLines: Set<number>,
  ranges: DecorationRange[],
): void {
  const startLine = view.state.doc.lineAt(block.from);
  const endLine = view.state.doc.lineAt(Math.max(block.from, block.to - 1));
  let blockActive = false;
  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    if (activeLines.has(lineNumber)) {
      blockActive = true;
      break;
    }
  }

  if (!blockActive) return;

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    ranges.push({ from: line.from, to: line.from, deco: codeBlockLineDeco });
  }

  if (startLine.from < startLine.to) {
    ranges.push({
      from: startLine.from,
      to: startLine.to,
      deco: Decoration.replace({ widget: new CodeBlockToolbarWidget(block.block) }),
    });
  }

  if (endLine.number !== startLine.number && endLine.from < endLine.to) {
    ranges.push({
      from: endLine.from,
      to: endLine.to,
      deco: Decoration.replace({}),
    });
  }
}

function isInsideBlockRanges(from: number, to: number, blocks: BlockRange[]): boolean {
  return blocks.some((block) => from >= block.from && to <= block.to);
}

function addConcealRange(view: EditorView, nodeName: string, from: number, to: number, ranges: DecorationRange[]): void {
  let hideTo = to;
  if (nodeName === "HeaderMark" && view.state.doc.sliceString(hideTo, hideTo + 1) === " ") {
    hideTo += 1;
  }
  ranges.push({ from, to: hideTo, deco: hideMark });
}

function addTaskMarker(view: EditorView, from: number, to: number, ranges: DecorationRange[]): void {
  const marker = view.state.doc.sliceString(from, to);
  const checked = /\[[xX]\]/.test(marker);
  ranges.push({
    from,
    to,
    deco: Decoration.replace({
      widget: new TaskCheckboxWidget(checked, from, to),
    }),
  });
}

function buildDecorationSet(ranges: DecorationRange[]): DecorationSet {
  return Decoration.set(
    ranges.filter((range) => range.to >= range.from).map((range) => range.deco.range(range.from, range.to)),
    true,
  );
}

type TableEntry = BlockRange & { table: ParsedTable };

type BlockPreviewState = {
  decorations: DecorationSet;
  codeBlocks: CodeBlockRange[];
  tables: TableEntry[];
  activeKey: string;
};

// 能引入/破坏代码块或表格结构的字符。周围行不含这些字符的编辑不可能改变块结构,
// 于是可跳过昂贵的全文扫描。
const BLOCK_STRUCTURE_MARKERS = /[`~|]/;

function scanBlockRanges(state: EditorState): { codeBlocks: CodeBlockRange[]; tables: TableEntry[] } {
  const noActiveLines = new Set<number>();
  return {
    codeBlocks: collectMarkdownCodeBlockRangesFromState(state, 0, state.doc.length, noActiveLines),
    tables: collectMarkdownTableRangesFromState(state, 0, state.doc.length, noActiveLines),
  };
}

function revealedBlockKey(
  state: EditorState,
  codeBlocks: CodeBlockRange[],
  tables: TableEntry[],
  activeLines: Set<number>,
): string {
  const revealed: string[] = [];
  for (const block of codeBlocks) {
    if (rangeTouchesActiveLine(state, block.from, block.to, activeLines)) {
      revealed.push(`c${block.from}-${block.to}`);
    }
  }
  for (const table of tables) {
    if (rangeTouchesActiveLine(state, table.from, table.to, activeLines)) {
      revealed.push(`t${table.from}-${table.to}`);
    }
  }
  return revealed.join("|");
}

function assembleBlockPreview(
  state: EditorState,
  codeBlocks: CodeBlockRange[],
  tables: TableEntry[],
): BlockPreviewState {
  const activeLines = collectActiveLinesFromState(state);
  const ranges: DecorationRange[] = [];
  const renderedBlocks: BlockRange[] = [];

  for (const codeRange of codeBlocks) {
    if (rangeTouchesActiveLine(state, codeRange.from, codeRange.to, activeLines)) continue;
    renderedBlocks.push({ from: codeRange.from, to: codeRange.to });
    ranges.push({
      from: codeRange.from,
      to: codeRange.to,
      deco: Decoration.replace({
        widget: new CodeBlockWidget(codeRange.block, codeRange.from, codeRange.to),
        block: true,
      }),
    });
  }

  for (const tableRange of tables) {
    if (rangeTouchesActiveLine(state, tableRange.from, tableRange.to, activeLines)) continue;
    if (isInsideBlockRanges(tableRange.from, tableRange.to, renderedBlocks)) continue;
    ranges.push({
      from: tableRange.from,
      to: tableRange.to,
      deco: Decoration.replace({ widget: new TableWidget(tableRange.table, tableRange.from, tableRange.to), block: true }),
    });
  }

  return {
    decorations: buildDecorationSet(ranges),
    codeBlocks,
    tables,
    activeKey: revealedBlockKey(state, codeBlocks, tables, activeLines),
  };
}

function blockStructureMayHaveChanged(
  transaction: Transaction,
  cached: { codeBlocks: CodeBlockRange[]; tables: TableEntry[] },
): boolean {
  let suspicious = false;
  transaction.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (suspicious) return;
    if (BLOCK_STRUCTURE_MARKERS.test(transaction.startState.sliceDoc(fromA, toA))) {
      suspicious = true;
      return;
    }
    const startLine = transaction.state.doc.lineAt(fromB);
    const endLine = transaction.state.doc.lineAt(Math.min(transaction.state.doc.length, toB));
    if (BLOCK_STRUCTURE_MARKERS.test(transaction.state.sliceDoc(startLine.from, endLine.to))) {
      suspicious = true;
      return;
    }
    const touchesBlock = (range: BlockRange): boolean => fromA <= range.to && toA >= range.from;
    if (cached.codeBlocks.some(touchesBlock) || cached.tables.some(touchesBlock)) {
      suspicious = true;
    }
  });
  return suspicious;
}

function mapBlockRange<T extends BlockRange>(range: T, changes: ChangeDesc): T {
  return {
    ...range,
    from: changes.mapPos(range.from, 1),
    to: changes.mapPos(range.to, -1),
  };
}

const markdownBlockPreviewField = StateField.define<BlockPreviewState>({
  create(state) {
    const { codeBlocks, tables } = scanBlockRanges(state);
    return assembleBlockPreview(state, codeBlocks, tables);
  },
  update(value, transaction) {
    if (transaction.docChanged) {
      // 快路径:不会改变块结构的编辑只平移缓存范围,而非全文重扫。
      if (blockStructureMayHaveChanged(transaction, value)) {
        const { codeBlocks, tables } = scanBlockRanges(transaction.state);
        return assembleBlockPreview(transaction.state, codeBlocks, tables);
      }
      const codeBlocks = value.codeBlocks.map((range) => mapBlockRange(range, transaction.changes));
      const tables = value.tables.map((range) => mapBlockRange(range, transaction.changes));
      return assembleBlockPreview(transaction.state, codeBlocks, tables);
    }
    if (transaction.selection) {
      const activeLines = collectActiveLinesFromState(transaction.state);
      const activeKey = revealedBlockKey(transaction.state, value.codeBlocks, value.tables, activeLines);
      if (activeKey === value.activeKey) return value;
      return assembleBlockPreview(transaction.state, value.codeBlocks, value.tables);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const activeLines = collectRevealLines(view);
  const ranges: DecorationRange[] = [];
  const renderedBlocks: BlockRange[] = [];
  // 复用 markdownBlockPreviewField 缓存的块范围,使滚动/打字/移动光标都不触发全文重扫。
  const blockCache = view.state.field(markdownBlockPreviewField, false) ?? null;

  for (const { from, to } of view.visibleRanges) {
    const codeRanges = blockCache
      ? blockCache.codeBlocks.filter((block) => block.to >= from && block.from <= to)
      : collectMarkdownCodeBlockRanges(view, from, to, activeLines);
    for (const codeRange of codeRanges) {
      renderedBlocks.push({ from: codeRange.from, to: codeRange.to });
      addFencedCodeLineDecorations(view, codeRange, activeLines, ranges);
    }
  }

  for (const { from, to } of view.visibleRanges) {
    const tableRanges = blockCache
      ? blockCache.tables.filter(
          (table) =>
            table.to >= from &&
            table.from <= to &&
            !rangeTouchesActiveLine(view.state, table.from, table.to, activeLines),
        )
      : collectMarkdownTableRanges(view, from, to, activeLines);
    for (const tableRange of tableRanges) {
      renderedBlocks.push({ from: tableRange.from, to: tableRange.to });
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "Document" && isInsideBlockRanges(node.from, node.to, renderedBlocks)) {
          return false;
        }
        const line = view.state.doc.lineAt(node.from);
        const isActive = activeLines.has(line.number);

        switch (node.name) {
          case "FencedCode":
          case "CodeBlock":
            return false;
          case "Blockquote":
            ranges.push({ from: line.from, to: line.from, deco: blockquoteLineDeco });
            break;
          case "HorizontalRule":
            if (!isActive) {
              ranges.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new HrWidget(node.from) }) });
              ranges.push({ from: line.from, to: line.from, deco: centerLineDeco });
            }
            return false;
          default:
            break;
        }

        if (node.name === "TaskMarker") {
          if (!isActive) addTaskMarker(view, node.from, node.to, ranges);
          return false;
        }

        if (isActive) return undefined;

        switch (node.name) {
          case "Image": {
            const source = view.state.doc.sliceString(node.from, node.to);
            const parsed = markdownImageFromSource(source);
            if (parsed) {
              ranges.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({ widget: new ImageWidget(parsed.src, parsed.alt, node.from) }),
              });
              return false;
            }
            break;
          }
          case "Table": {
            if (nodeTouchesActiveLine(view, node.from, node.to, activeLines)) return false;
            const parsed = parseMarkdownTable(view.state.doc.sliceString(node.from, node.to));
            if (parsed) return false;
            break;
          }
          case "Autolink": {
            const source = view.state.doc.sliceString(node.from, node.to);
            if (source.startsWith("<") && source.endsWith(">")) {
              ranges.push({ from: node.from, to: node.from + 1, deco: hideMark });
              ranges.push({ from: node.from + 1, to: node.to - 1, deco: autolinkDeco });
              ranges.push({ from: node.to - 1, to: node.to, deco: hideMark });
              return false;
            }
            break;
          }
          case "ListMark": {
            const markText = view.state.doc.sliceString(node.from, node.to);
            if (markText !== "-" && markText !== "*" && markText !== "+") break;
            let hideTo = node.to;
            if (view.state.doc.sliceString(hideTo, hideTo + 1) === " ") hideTo += 1;
            const rest = view.state.doc.sliceString(node.to, Math.min(node.to + 5, line.to));
            if (/^ ?\[[ xX]\]/.test(rest)) {
              ranges.push({ from: node.from, to: hideTo, deco: hideMark });
            } else {
              ranges.push({
                from: node.from,
                to: hideTo,
                deco: Decoration.replace({ widget: new ListBulletWidget(node.from, hideTo) }),
              });
            }
            break;
          }
          case "Mark": {
            ranges.push({ from: node.from, to: node.to, deco: markDeco });
            break;
          }
          default:
            if (CONCEAL_MARKS.has(node.name)) addConcealRange(view, node.name, node.from, node.to, ranges);
            break;
        }
        return undefined;
      },
    });
  }

  return buildDecorationSet(ranges);
}

const markdownLivePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildMarkdownDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export function writeMarkdownLivePreviewExtensions(): Extension[] {
  return [
    EditorView.editorAttributes.of({ class: "cm-write-live-preview" }),
    syntaxHighlighting(writeMarkdownHighlight),
    writeMarkdownLiveTheme,
    markdownBlockPreviewField,
    markdownLivePreviewPlugin,
  ];
}

// 源码模式的 markdown 着色：只给标题上品牌紫（--accent），字号/字重不动——
// 源码模式的价值是「所见即文件内容」，放大标题会破坏等宽排版的对齐感。
// 这里**刻意不给** processingInstruction（HeaderMark）单独配色：`#` 是标题节点的子节点，
// 不覆盖就继承标题色，于是 `#` 与标题文字同为紫色；而同样归到 processingInstruction 的
// 列表符号 / 引用符号不在标题内，保持默认色不受影响。
const writeMarkdownSourceHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: "var(--accent)" },
  { tag: tags.heading2, color: "var(--accent)" },
  { tag: tags.heading3, color: "var(--accent)" },
  { tag: tags.heading4, color: "var(--accent)" },
  { tag: tags.heading5, color: "var(--accent)" },
  { tag: tags.heading6, color: "var(--accent)" },
]);

// ── 源码模式行分类标记(标题 / 列表)──────────────────────────────────────
// 给 ATX 标题行(行首 1–6 个 # + 空白)挂 cm-src-heading + cm-src-h{n} 行装饰;
// 给列表行(-/*/+ 或「数字.」「数字)」起头)挂 cm-src-list 行装饰,并对行首记号区间
// 加 cm-src-listmark 标记装饰。只打类不做视觉:「H₁/H₂…」角标、列表提亮与记号橙色
// 仅在写作禅模式下由 CSS 显示(.pw-writing-root.is-zen 作用域,见 cortex-desktop.css),
// 普通源码档零视觉变化 —— 装饰常驻可免去进出禅模式时重配 CM 扩展,编辑器状态不动。
const headingLineDecos = [1, 2, 3, 4, 5, 6].map((n) =>
  Decoration.line({ class: `cm-src-heading cm-src-h${n}` }),
);
const listLineDeco = Decoration.line({ class: "cm-src-list" });
const listMarkDeco = Decoration.mark({ class: "cm-src-listmark" });
const ATX_HEADING_RE = /^(#{1,6})[ \t]/;
// 无序(-/*/+)或有序(1. / 1))列表:缩进≤3 空格视为列表(md 语法),记号后必须跟空白。
const LIST_LINE_RE = /^(\s{0,3})([-*+]|\d{1,9}[.)])[ \t]/;

// 扫可视范围逐行正则判定(不走语法树:两类判定都只看行首,正则足够且省一次树遍历)。
function buildSourceLineDecos(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos);
      const heading = ATX_HEADING_RE.exec(line.text);
      if (heading) {
        builder.add(line.from, line.from, headingLineDecos[heading[1]!.length - 1]!);
      } else {
        const list = LIST_LINE_RE.exec(line.text);
        if (list) {
          // 行装饰(点位,startSide 在前)先于记号标记加入,满足 RangeSetBuilder 的排序要求。
          builder.add(line.from, line.from, listLineDeco);
          const markFrom = line.from + list[1]!.length;
          builder.add(markFrom, markFrom + list[2]!.length, listMarkDeco);
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const sourceLineClassesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildSourceLineDecos(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildSourceLineDecos(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// 源码模式扩展（与 live 档共用同一个 compartment，切档即整体换掉）。
export function writeMarkdownSourceExtensions(): Extension[] {
  return [syntaxHighlighting(writeMarkdownSourceHighlight), sourceLineClassesPlugin];
}
