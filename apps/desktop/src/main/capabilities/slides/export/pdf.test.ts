// PDF 导出测试:注入假 printer,验证「组合成一个打印文档、一次 printToPDF」的契约
// (不逐页打印)、页尺寸固定、超时透传。真实 Chromium 打印由 Task 12 的人工验收覆盖。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("../../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { buildDeckPdf, PDF_RENDER_TIMEOUT_MS } from "./pdf";

const SLIDES = [
  { title: "封面", html: "<!doctype html><html><body><h1>封面</h1></body></html>" },
  { title: "内容", html: "<!doctype html><html><body><p>内容</p></body></html>" },
];

describe("buildDeckPdf", () => {
  it("只调用一次 printer(整册组合后一次导出,不逐页打印)", async () => {
    const printer = vi.fn(async () => Buffer.from("%PDF-fake"));
    const buffer = await buildDeckPdf({ title: "季度", slides: SLIDES, printer });
    expect(printer).toHaveBeenCalledOnce();
    expect(buffer.toString()).toBe("%PDF-fake");
  });

  it("交给 printer 的是含全部页面、固定页尺寸的组合文档", async () => {
    let received = "";
    await buildDeckPdf({
      title: "季度",
      slides: SLIDES,
      printer: async (html) => {
        received = html;
        return Buffer.from("%PDF");
      },
    });
    expect(received).toContain("@page { size: 1280px 720px; margin: 0; }");
    expect((received.match(/class="page"/g) ?? []).length).toBe(2);
    expect(received).toContain("&lt;h1&gt;封面&lt;/h1&gt;");
  });

  it("默认超时透传给 printer", async () => {
    let timeout = 0;
    await buildDeckPdf({
      title: "t",
      slides: SLIDES,
      printer: async (_html, ms) => {
        timeout = ms;
        return Buffer.from("%PDF");
      },
    });
    expect(timeout).toBe(PDF_RENDER_TIMEOUT_MS);
  });

  it("printer 抛错时向上传播(调用方转结构化错误)", async () => {
    await expect(
      buildDeckPdf({
        title: "t",
        slides: SLIDES,
        printer: async () => {
          throw new Error("printToPDF 失败");
        },
      }),
    ).rejects.toThrow("printToPDF 失败");
  });
});
