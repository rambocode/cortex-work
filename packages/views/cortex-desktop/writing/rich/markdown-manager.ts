// 富文本(rich)模式的 Markdown ↔ tiptap 往返内核 + 保真审计(移植自 Kun write/tiptap/markdown-manager.ts)。
// 数据安全红线:富文本编辑的是 tiptap 文档,但落盘的是 .md 源文件,每次保存都要把文档序列化回 Markdown。
// 若往返不无损,会静默改写/损坏用户原文,故所有从外部进入富文本的内容都必须先过 auditWriteMarkdownFidelity。
//
// ⚠️ 本模块顶层 import 了 @tiptap/*,只允许被「动态 import」触达(WritingRichEditor 在 useEffect 内 import),
// 绝不能被 WritingEditorPane 等静态引用 —— 否则 tiptap 会被卷进 Next.js 的 web 产物(与 CM 同约束)。
import type { AnyExtension, JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { WriteLocalImage } from "./local-image";

// 富文本扩展的可选项:目前仅本地图片的显示解析器(相对路径 → 可渲染 URL)。
export interface WriteRichExtensionOptions {
  resolveImage?: (rawSrc: string) => Promise<string | null>;
}

// 保真审计结果:eligible=可进富文本(附归一化后的无损文本);否则带拒绝原因供 UI 提示 + 回落 CM。
export type WriteRichFidelity =
  | { eligible: true; normalized: string }
  | { eligible: false; reason: "parse-error" | "unstable" | "text-loss" | "too-large"; detail?: string };

// 富文本拒绝超大文档:CM 更适合处理,且开档审计(两趟 parse/serialize)在超大文档上开销过大。
export const WRITE_RICH_MAX_CHARS = 300_000;

// 构造富文本模式的 tiptap 扩展集(最小集:StarterKit + 表格 + 任务列表 + 本地图片节点)。
// 关键:MarkdownManager 与实际编辑器必须用「同一套扩展」构造,否则 schema 不一致会导致往返错位。
// resolveImage 只影响图片「显示」(节点视图),不影响 schema/序列化,故 manager 用默认(无解析)、
// 编辑器注入解析器,两者 schema 仍一致,往返安全。
export function buildWriteRichExtensions(opts?: WriteRichExtensionOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      link: { openOnClick: false },
      // 富文本自管 undo 深度,对齐 CM 的 history()。
      undoRedo: { depth: 200 },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    WriteLocalImage.configure({ resolve: opts?.resolveImage ?? null }),
  ];
}

let sharedManager: MarkdownManager | null = null;

// 单例 MarkdownManager(gfm)。parse/serialize 与保真审计共用,保证同一套 schema 与序列化规则。
export function getWriteMarkdownManager(): MarkdownManager {
  if (!sharedManager) {
    sharedManager = new MarkdownManager({
      markedOptions: { gfm: true },
      extensions: buildWriteRichExtensions(),
    });
  }
  return sharedManager;
}

export function parseWriteMarkdown(markdown: string): JSONContent {
  return getWriteMarkdownManager().parse(markdown);
}

export function serializeWriteMarkdown(doc: JSONContent): string {
  return getWriteMarkdownManager().serialize(doc);
}

// 递归收集文档里的纯文本(用于「往返未丢文本」校验)。
function collectPlainText(node: JSONContent | undefined, acc: string[]): string[] {
  if (!node) return acc;
  if (node.type === "text" && node.text) acc.push(node.text);
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectPlainText(child, acc);
  }
  return acc;
}

// 归一化纯文本(合并空白),用于两趟解析的文本一致性比较。
function normalizedPlainText(doc: JSONContent): string {
  return collectPlainText(doc, []).join(" ").replace(/\s+/g, " ").trim();
}

// 开档保真门:仅当 Markdown 往返「一趟后即幂等」且「不丢任何纯文本」时才放行富文本;
// 其余(硬换行的列表续行、原始 HTML 块、schema 无法表达的语法)一律留在 CM,保证磁盘文件不被静默改写。
// 返回 too-large / parse-error / unstable / text-loss 四类拒绝原因。
export function auditWriteMarkdownFidelity(markdown: string): WriteRichFidelity {
  if (markdown.length > WRITE_RICH_MAX_CHARS) {
    return { eligible: false, reason: "too-large", detail: "文档过大,富文本不予处理" };
  }
  const manager = getWriteMarkdownManager();
  let firstDoc: JSONContent;
  let firstPass: string;
  let secondPass: string;
  let secondDoc: JSONContent;
  try {
    firstDoc = manager.parse(markdown);
    firstPass = manager.serialize(firstDoc);
    secondDoc = manager.parse(firstPass);
    secondPass = manager.serialize(secondDoc);
  } catch (error) {
    return {
      eligible: false,
      reason: "parse-error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  // 两趟序列化不一致 → 往返不幂等(会漂移),拒绝。
  if (firstPass !== secondPass) {
    return { eligible: false, reason: "unstable" };
  }
  // 纯文本在两趟间发生变化 → 有内容被吞,拒绝。
  if (normalizedPlainText(firstDoc) !== normalizedPlainText(secondDoc)) {
    return { eligible: false, reason: "text-loss" };
  }
  return { eligible: true, normalized: firstPass };
}
