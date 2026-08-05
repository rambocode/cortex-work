// 聊天文档附件落盘(doc:save)。支持 @firecrawl/anydoc 可解析的全部格式:PDF / Office 新旧全系
// (.doc/.docx/.xls/.xlsx/.ppt/.pptx 及宏/放映变体)/ OpenDocument / RTF / EPUB / 纯文本(.csv/.txt/.md)。
// 文档内容不进消息,由 agent 经文档抽取 MCP 工具(doc-extract)按需读取(见 capabilities/doc-extract)。
//
// 安全要点(对齐 image.ts 范式):
//  - 写侧:扩展名 allowlist(由原始名嗅探)+ 二进制类型 magic-bytes 复核
//    (PDF=%PDF、zip 系 Office/ODF/EPUB=PK、旧 Office=OLE 复合文档头、RTF={\rtf;纯文本无 magic 跳过)
//    + randomUUID 文件名(原始名不参与路径)
//    + byteLength 上限 + 目录 0700。
//  - 读侧(供 doc-extract 工具复用):assertDocPath 做 realpath + lstat 拒符号链接 + 严格根边界
//    + 扩展名 allowlist,**不**走 fs.ts 的 assertOpenable(其「任意真实文件即放行」兜底会击穿限制)。
//    读「校验后的真实路径」消除 TOCTOU。
//  - 核心逻辑抽成接收 root 入参的纯函数(saveDocInto / assertDocPath),可用临时目录单测。

import { ipcMain } from "electron";
import { promises as fsp } from "fs";
import { randomUUID } from "crypto";
import { extname, join } from "path";
import { chatDocsRoot } from "../paths";
import { enqueue } from "./sessionWriteQueue";
import { isInsideRoot } from "./image";
import type { DocSaveRequest, DocSaveResult } from "./types";

// 主进程是权威闸门(renderer 预检常量须与此值一致)。
export const MAX_DOC_BYTES = 50 * 1024 * 1024; // 50MB

const SAFE_ID = /^[\w-]+$/;

// 支持的文档扩展名(anydoc 覆盖二进制类;txt/csv/md 在抽取侧直读)。
export type DocExt =
  | "pdf"
  | "doc"
  | "docx"
  | "docm"
  | "xls"
  | "xlsx"
  | "xlsm"
  | "xlsb"
  | "ppt"
  | "pptx"
  | "pptm"
  | "ppsx"
  | "ppsm"
  | "pot"
  | "pps"
  | "odt"
  | "ods"
  | "odp"
  | "rtf"
  | "epub"
  | "csv"
  | "txt"
  | "md";

const DOC_EXTS: readonly DocExt[] = [
  "pdf",
  "doc",
  "docx",
  "docm",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "ppt",
  "pptx",
  "pptm",
  "ppsx",
  "ppsm",
  "pot",
  "pps",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
  "csv",
  "txt",
  "md",
];

// 二进制文档 magic-bytes 复核分组(纯文本无 magic,跳过):
//  - zip 系:现代 Office(OOXML 及宏变体)/ OpenDocument / EPUB 都是 ZIP 容器。
//  - OLE 系:旧二进制 Office(.doc/.xls/.ppt/.pot/.pps)是 OLE 复合文档。
const ZIP_DOCS: ReadonlySet<DocExt> = new Set([
  "docx",
  "docm",
  "xlsx",
  "xlsm",
  "xlsb",
  "pptx",
  "pptm",
  "ppsx",
  "ppsm",
  "odt",
  "ods",
  "odp",
  "epub",
]);
const OLE_DOCS: ReadonlySet<DocExt> = new Set(["doc", "xls", "ppt", "pot", "pps"]);

export function extToDocExt(fileName: string): DocExt | null {
  const e = extname(fileName).replace(/^\./, "").toLowerCase();
  return (DOC_EXTS as readonly string[]).includes(e) ? (e as DocExt) : null;
}

// magic-bytes 复核:PDF=%PDF、zip 系=PK\x03\x04、OLE 系=D0 CF 11 E0 A1 B1 1A E1、RTF={\rtf。
// 纯文本(csv/txt/md)无 magic,放行。错配即拒,杜绝「exe 改名 pdf」。
export function sniffDocMatches(buf: Buffer, ext: DocExt): boolean {
  if (ext === "pdf") {
    return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
  }
  if (ZIP_DOCS.has(ext)) {
    return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04; // PK\x03\x04
  }
  if (OLE_DOCS.has(ext)) {
    const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return buf.length >= 8 && OLE.every((b, i) => buf[i] === b);
  }
  if (ext === "rtf") {
    return buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "{\\rtf";
  }
  return true; // csv/txt/md
}

// 取源字节:优先 srcPath(本地路径,先 stat 卡大小再读,避免把超大文件读进内存),否则用内存态 data。
async function readSource(source: { srcPath?: string; data?: ArrayBuffer }): Promise<Buffer> {
  if (source.srcPath) {
    const st = await fsp.stat(source.srcPath);
    if (st.size > MAX_DOC_BYTES) throw new Error(`文档过大: ${st.size} 字节 > 上限 ${MAX_DOC_BYTES}`);
    return fsp.readFile(source.srcPath);
  }
  if (source.data) {
    if (source.data.byteLength > MAX_DOC_BYTES) {
      throw new Error(`文档过大: ${source.data.byteLength} 字节 > 上限 ${MAX_DOC_BYTES}`);
    }
    return Buffer.from(source.data);
  }
  throw new Error("doc:save 缺少来源(srcPath 或 data)");
}

// 落盘:写侧权威校验。root = chat-docs 根,沿 sessionId 建子目录,返回绝对路径 + 字节数。
export async function saveDocInto(
  root: string,
  sessionId: string,
  fileName: string,
  source: { srcPath?: string; data?: ArrayBuffer },
): Promise<DocSaveResult> {
  if (!SAFE_ID.test(sessionId)) throw new Error(`非法 session id: ${sessionId}`);
  const ext = extToDocExt(fileName);
  if (!ext) throw new Error(`不支持的文档格式: ${fileName}(仅 PDF/Office/OpenDocument/RTF/EPUB/纯文本)`);
  const buf = await readSource(source);
  if (buf.byteLength > MAX_DOC_BYTES) throw new Error(`文档过大: ${buf.byteLength} 字节 > 上限 ${MAX_DOC_BYTES}`);
  if (!sniffDocMatches(buf, ext)) throw new Error(`文档 MIME 与真实字节不符: ${fileName}`);
  const dir = join(root, sessionId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.${ext}`);
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, path);
  return { path, sizeBytes: buf.byteLength };
}

// 读侧唯一闸门(供 doc-extract 工具调用,见 U5)。realpath + lstat 拒符号链接 + 根边界
// + 扩展名 allowlist;返回校验后的真实路径(读它而非原始入参,消除 TOCTOU)。
// 不走 fs.ts assertOpenable —— 那条路有「任意真实文件即放行」兜底,会被用来读 chat-docs 之外的任意文件。
export async function assertDocPath(root: string, requested: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root); // 根不存在 = 无任何文档可读
  } catch {
    throw new Error(`路径不在允许范围内: ${requested}`);
  }
  let st;
  try {
    st = await fsp.lstat(requested);
  } catch {
    const e = new Error(`文档不存在: ${requested}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`路径不在允许范围内: ${requested}`); // 我们落盘的都是普通文件
  const realTarget = await fsp.realpath(requested);
  if (!isInsideRoot(realRoot, realTarget)) throw new Error(`路径不在允许范围内: ${requested}`);
  if (!extToDocExt(realTarget)) throw new Error(`不支持的文档扩展名: ${requested}`);
  return realTarget;
}

export function registerDocHandlers(): void {
  // 落盘经共享 sessionWriteQueue,与同会话的 chat:save/chat:delete/image:save 串行,避免删除时留孤儿。
  ipcMain.handle("doc:save", (_e, req: DocSaveRequest): Promise<DocSaveResult> =>
    enqueue(req.sessionId, () =>
      saveDocInto(chatDocsRoot(), req.sessionId, req.fileName, { srcPath: req.srcPath, data: req.data }),
    ),
  );
}
