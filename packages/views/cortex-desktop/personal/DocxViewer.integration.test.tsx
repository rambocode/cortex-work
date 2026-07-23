import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { DesktopBridge } from "@cortex-work/core";
import { DocxViewer } from "./DocxViewer";

const REAL_DOCX = { path: "/docs/real.docx", name: "real.docx" } as const;

async function minimalDocxBase64(text: string): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
          <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
        </w:body>
      </w:document>`,
  );
  return zip.generateAsync({ type: "base64" });
}

afterEach(cleanup);

describe("DocxViewer 与 docx-preview 集成", () => {
  it("真实解析最小 DOCX 并渲染正文", async () => {
    const data = await minimalDocxBase64("真实 DOCX 正文");
    const bridge = {
      readFileBinary: vi.fn().mockResolvedValue({
        data,
        truncated: false,
        size: data.length,
        mtimeMs: 1,
      }),
    } as unknown as DesktopBridge;

    render(<DocxViewer filePath={REAL_DOCX.path} fileName={REAL_DOCX.name} bridge={bridge} />);

    expect(await screen.findByText("真实 DOCX 正文")).toBeInTheDocument();
  });
});
