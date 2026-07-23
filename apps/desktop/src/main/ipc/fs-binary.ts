import { extname } from "path";

// 表格/DOCX 等常规二进制沿用原 25 MiB 上限，避免 base64 IPC 占用过多内存。
export const MAX_STANDARD_BINARY_BYTES = 25 * 1024 * 1024;

// PDF/PPTX 在线预览按产品需求允许读取到 500 MiB。
export const MAX_DOCUMENT_PREVIEW_BYTES = 500 * 1024 * 1024;

export function binaryReadLimitForPath(path: string): number {
  const extension = extname(path).toLowerCase();
  return extension === ".pdf" || extension === ".pptx"
    ? MAX_DOCUMENT_PREVIEW_BYTES
    : MAX_STANDARD_BINARY_BYTES;
}
