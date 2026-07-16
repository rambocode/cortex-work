// Slides PDF 导出:把整套 deck 组合成一个固定尺寸的打印文档,交隐藏窗口
// printToPDF(preferCSSPageSize) **一次**导出 —— 不逐页打印再依赖系统工具拼接。
//
// 生命周期:临时目录 + 隐藏窗口都在 finally 清理;超时销毁窗口并回结构化 timeout。
import { BrowserWindow } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../../../log";
import { READY_WAIT_SCRIPT, SlideRenderTimeoutError } from "../render";
import { buildPrintableHtml, type PresenterSlide } from "./html";

const log = createLogger("slides");

/** 整册 PDF 渲染超时(10 页 deck 的质量门槛是 90s,这里给足余量)。 */
export const PDF_RENDER_TIMEOUT_MS = 120_000;

/** printToPDF 能力注入(单测替身用;生产用真实隐藏窗口)。 */
export interface PdfPrinter {
  (html: string, timeoutMs: number): Promise<Buffer>;
}

// 生产实现:临时 html 文件 → 隐藏窗口加载 → 等就绪 → printToPDF。
export async function printCombinedHtmlToPdf(html: string, timeoutMs: number): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "cortex-slides-pdf-"));
  const tempHtmlPath = join(tempDir, "deck.html");
  await writeFile(tempHtmlPath, html, "utf8");
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: { sandbox: true },
  });
  const deadline = Date.now() + timeoutMs;
  const guard = async <T>(promise: Promise<T>, what: string): Promise<T> => {
    const remaining = Math.max(1000, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SlideRenderTimeoutError(what, remaining)), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    await guard(win.loadURL(pathToFileURL(tempHtmlPath).href), "loadURL");
    await guard(win.webContents.executeJavaScript(READY_WAIT_SCRIPT), "fonts/images ready");
    // 各页以 iframe srcdoc 承载,其内部资源就绪不被外层 READY_WAIT 覆盖 —— 补一帧等待,
    // 让子文档完成首次绘制(实测足以避免空白页;超时仍有 guard 兜底)。
    await guard(
      win.webContents.executeJavaScript(
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))))",
      ),
      "frames",
    );
    const pdf = await guard(
      win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }),
      "printToPDF",
    );
    return Buffer.from(pdf);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** deck → PDF buffer。printer 可注入(单测不拉 Chromium)。 */
export async function buildDeckPdf(options: {
  title: string;
  slides: PresenterSlide[];
  printer?: PdfPrinter;
  timeoutMs?: number;
}): Promise<Buffer> {
  const html = buildPrintableHtml({ title: options.title, slides: options.slides });
  const printer = options.printer ?? printCombinedHtmlToPdf;
  const buffer = await printer(html, options.timeoutMs ?? PDF_RENDER_TIMEOUT_MS);
  log.info(`[slides] pdf built slides=${options.slides.length} bytes=${buffer.byteLength}`);
  return buffer;
}
