import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_PREVIEW_BYTES,
  MAX_STANDARD_BINARY_BYTES,
  binaryReadLimitForPath,
} from "./fs-binary";

describe("binaryReadLimitForPath", () => {
  it("PDF/PPTX 预览允许读取到 500 MiB", () => {
    expect(binaryReadLimitForPath("/docs/whitepaper.pdf")).toBe(MAX_DOCUMENT_PREVIEW_BYTES);
    expect(binaryReadLimitForPath("/docs/deck.PPTX")).toBe(MAX_DOCUMENT_PREVIEW_BYTES);
    expect(MAX_DOCUMENT_PREVIEW_BYTES).toBe(500 * 1024 * 1024);
  });

  it("表格、DOCX 与其它二进制继续保持 25 MiB 上限", () => {
    expect(binaryReadLimitForPath("/docs/report.docx")).toBe(MAX_STANDARD_BINARY_BYTES);
    expect(binaryReadLimitForPath("/docs/data.xlsx")).toBe(MAX_STANDARD_BINARY_BYTES);
    expect(binaryReadLimitForPath("/docs/archive.zip")).toBe(MAX_STANDARD_BINARY_BYTES);
    expect(MAX_STANDARD_BINARY_BYTES).toBe(25 * 1024 * 1024);
  });
});
