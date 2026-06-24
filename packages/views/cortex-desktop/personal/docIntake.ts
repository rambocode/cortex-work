// 聊天文档附件采集纯函数:扩展名/大小校验 + File → PendingDocFile。
// 与主进程 doc.ts 的 allowlist / MAX_DOC_BYTES 同值(主进程是权威闸门,这里仅 UX 预检)。
// 优先用 Electron 给 File 附加的非标 `path`(srcPath),避免把最大 50MB 的 ArrayBuffer 过 IPC;
// 无 path(如某些粘贴来源)才读 ArrayBuffer。

import type { PendingDocFile } from "@cortex-work/core";

export const ACCEPTED_DOC_EXTS = ["pdf", "docx", "xlsx", "pptx", "csv", "txt", "md"] as const;
export const MAX_DOC_BYTES = 50 * 1024 * 1024; // 50MB,与 main/ipc/doc.ts MAX_DOC_BYTES 同值
export const MAX_DOCS_PER_MESSAGE = 6;
// 文件选择框 accept 属性:旧二进制(.doc/.xls/.ppt)不在内,系统层即不可选。
export const DOC_ACCEPT_ATTR = ".pdf,.docx,.xlsx,.pptx,.csv,.txt,.md";

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
};

export function docExtOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function isAcceptedDoc(name: string): boolean {
  return (ACCEPTED_DOC_EXTS as readonly string[]).includes(docExtOf(name));
}

// 二进制文档(PDF/现代 Office):必须经抽取工具读,不能当文本注入。用于区分应用内 Files 面板拖入时
// 「文本文件→既有 readFile 注入 prompt」vs「二进制文档→文档附件通道」,避免破坏文本文件注入功能。
const DOC_BINARY_EXTS = new Set(["pdf", "docx", "xlsx", "pptx"]);
export function isBinaryDoc(name: string): boolean {
  return DOC_BINARY_EXTS.has(docExtOf(name));
}

export type DocRejectReason = "type" | "size";

// 纯校验(不读内容):格式不支持(含旧二进制 .doc/.xls/.ppt)/ 超大 → 原因;通过 → null。
export function checkDocFile(file: { name: string; size: number }): DocRejectReason | null {
  if (!isAcceptedDoc(file.name)) return "type";
  if (file.size > MAX_DOC_BYTES) return "size";
  return null;
}

export function docRejectText(reason: DocRejectReason, name: string): string {
  return reason === "type"
    ? `不支持的文档格式：${name || "文档"}（仅 PDF / .docx / .xlsx / .pptx / .csv / .txt / .md）`
    : `文档过大：${name || "文档"}（上限 ${Math.round(MAX_DOC_BYTES / 1024 / 1024)}MB）`;
}

// 同批 + 与已有去重的键:name + 字节数。
export function docDedupeKey(name: string, size: number): string {
  return `${name}:${size}`;
}

let intakeSeq = 0;

// 由「已知本地路径 + 名称」构造待发文档(应用内 Files 面板拖入用:文件已在磁盘,直接用 srcPath
// 落盘,无需读进内存)。sizeBytes 在渲染端拿不到,留 0(仅用于 chip 显示/同批去重;主进程落盘时
// 会按真实大小复核 50MB 上限)。调用方应先 isAcceptedDoc(name) 过滤。
export function pendingDocFromPath(path: string, name: string): PendingDocFile {
  const ext = docExtOf(name);
  intakeSeq += 1;
  return {
    id: `doc-${intakeSeq}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || "document",
    mimeType: EXT_MIME[ext] || "application/octet-stream",
    sizeBytes: 0,
    status: "ready",
    srcPath: path,
  };
}

export async function fileToPendingDocFile(file: File): Promise<PendingDocFile> {
  const ext = docExtOf(file.name);
  intakeSeq += 1;
  const base = {
    id: `doc-${intakeSeq}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "document",
    mimeType: file.type || EXT_MIME[ext] || "application/octet-stream",
    sizeBytes: file.size,
    status: "ready" as const,
  };
  // Electron 渲染端 File 带非标 path;优先用它走主进程路径直拷(避免大 ArrayBuffer 过 IPC)。
  const srcPath = (file as File & { path?: string }).path;
  if (srcPath) return { ...base, srcPath };
  const data = await file.arrayBuffer();
  return { ...base, data };
}
