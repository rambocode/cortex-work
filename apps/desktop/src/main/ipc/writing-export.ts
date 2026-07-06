// 写作重型导出(U6)IPC 域:当前 md 文档 → 同源 HTML(writing-markdown-html)→
//   DOCX(html-to-docx)/ PDF·PNG(隐藏 BrowserWindow printToPDF·capturePage)/ HTML 文件 /
//   复制富文本(clipboard html + text)。目标路径由本域内的系统保存对话框选取(对齐 Kun
//   write-export-service,不单开 fs:pickSavePath)。
//
// 跨进程契约:
//   writing:export(invoke, WritingExportRequest → WritingExportResult):弹保存框 → 落盘;
//     取消 → { ok:false, canceled:true }(渲染端静默);失败 → { ok:false, message }(渲染端 toast)。
//   writing:copyRichText(invoke, WritingCopyRichTextRequest → WritingCopyRichTextResult):写系统剪贴板。
//
// 打包核查(见计划 U6 Verification / lessons):html-to-docx 是 apps/desktop 声明依赖,走
//   externalizeDepsPlugin 从 asar node_modules 运行时解析;electron-builder.yml 的 files 排除清单
//   未含 html-to-docx 及其传递依赖(排除项均为 renderer-only 包),故打包后可正常 require。
//   Markdown→HTML 自研零依赖(见 writing-markdown-html.ts 头注),不引入 marked/react-markdown 打包风险。
//
// 依赖注入:electron / html-to-docx 能力经 WritingExportRuntime 注入,HTML 构造为纯函数,
//   便于就近单测(纯函数快照 + 冒烟集成),html-to-docx 在 docx 分支内懒加载(纯函数测试不拉它)。

import { BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  WritingCopyRichTextRequest,
  WritingCopyRichTextResult,
  WritingExportFormat,
  WritingExportRequest,
  WritingExportResult,
} from "./writing-export-types";
import {
  inlineLocalImagesInHtml,
  isMarkdownPath,
  renderMarkdownToHtml,
  renderPlainTextFragment,
} from "./writing-markdown-html";

// 导出文档的内联样式:浅色文档纸样式(A4 版心),对齐 Kun write-export-service 的排版口径。
// 注意:CSS 内不得出现 块注释结束符(仓库硬规则),故本段不加 CSS 注释。
const EXPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { background: #ffffff; }
  body {
    margin: 0;
    background: #ffffff;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.72;
  }
  a { color: #0f62fe; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .document-shell { padding: 22mm 18mm; }
  .markdown-body { max-width: 100%; }
  .markdown-body > :first-child { margin-top: 0; }
  .markdown-body > :last-child { margin-bottom: 0; }
  .markdown-body p,
  .markdown-body ul,
  .markdown-body ol,
  .markdown-body blockquote,
  .markdown-body pre,
  .markdown-body table { margin: 0 0 1em; }
  .markdown-body h1,
  .markdown-body h2,
  .markdown-body h3,
  .markdown-body h4,
  .markdown-body h5,
  .markdown-body h6 {
    margin: 1.45em 0 0.65em;
    line-height: 1.24;
    color: #0f172a;
    font-weight: 700;
  }
  .markdown-body h1 { font-size: 2em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
  .markdown-body h2 { font-size: 1.55em; border-bottom: 1px solid #edf2f7; padding-bottom: 0.24em; }
  .markdown-body h3 { font-size: 1.25em; }
  .markdown-body ul, .markdown-body ol { padding-left: 1.5em; }
  .markdown-body li + li { margin-top: 0.3em; }
  .markdown-body blockquote {
    padding: 0.3em 0 0.3em 1em;
    border-left: 4px solid #dbe4ff;
    color: #475569;
    background: #f8fbff;
  }
  .markdown-body code {
    font-family: "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace;
    font-size: 0.92em;
  }
  .markdown-body p code,
  .markdown-body li code,
  .markdown-body td code {
    padding: 0.12em 0.38em;
    border-radius: 0.42em;
    background: #f1f5f9;
    color: #0f172a;
  }
  .markdown-body pre {
    overflow-x: auto;
    padding: 0.95em 1.05em;
    border-radius: 0.9em;
    background: #0f172a;
    color: #e2e8f0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .markdown-body pre code { background: transparent; color: inherit; padding: 0; }
  .markdown-body hr { height: 1px; border: 0; background: #e5e7eb; margin: 1.6em 0; }
  .markdown-body table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
  .markdown-body th, .markdown-body td {
    border: 1px solid #dbe3ee;
    padding: 0.5em 0.7em;
    vertical-align: top;
    text-align: left;
  }
  .markdown-body th { background: #f8fafc; font-weight: 700; }
  .markdown-body img { display: block; max-width: 100%; height: auto; margin: 1rem auto; }
  .markdown-body .task-list-item { list-style: none; }
  .plain-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace;
  }
  @page { size: A4; margin: 0; }
`;

// 文件名(去扩展):导出默认文件名与标题回落。
export function basenameWithoutExtension(filePath: string): string {
  const name = basename(filePath);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// 各格式的扩展名与保存对话框过滤器。
function exportExtension(format: WritingExportFormat): string {
  return format === "html" ? ".html" : format === "pdf" ? ".pdf" : format === "png" ? ".png" : ".docx";
}

function exportDialogFilter(format: WritingExportFormat): Electron.FileFilter {
  if (format === "html") return { name: "HTML", extensions: ["html"] };
  if (format === "pdf") return { name: "PDF", extensions: ["pdf"] };
  if (format === "png") return { name: "PNG", extensions: ["png"] };
  return { name: "Word 文档", extensions: ["docx"] };
}

// 对话框返回的路径无扩展名时补上目标扩展名(用户可能删掉了 .docx 等)。
function ensureExportExtension(targetPath: string, format: WritingExportFormat): string {
  return extname(targetPath).trim() ? targetPath : `${targetPath}${exportExtension(format)}`;
}

// 默认导出路径:与源文件同目录、同名、换目标扩展名。
export function defaultExportPath(sourcePath: string, format: WritingExportFormat): string {
  return join(dirname(sourcePath), `${basenameWithoutExtension(sourcePath)}${exportExtension(format)}`);
}

// 构造「剪贴板/DOCX 用」的 HTML 片段(<article class="markdown-body">…</article>):
//   md 文件走 Markdown 渲染,非 md 文件走纯文本 <pre>;随后把本地图片内联为 dataURI(自包含)。
// baseDir 缺省取 sourcePath 所在目录(相对图片解析基准)。readImage 可注入(测试)。
export async function buildWriteClipboardHtmlFragment(options: {
  sourcePath: string;
  content: string;
  readImage?: (path: string) => Promise<Buffer>;
}): Promise<string> {
  const fragment = isMarkdownPath(options.sourcePath)
    ? renderMarkdownToHtml(options.content)
    : renderPlainTextFragment(options.content);
  const inlined = await inlineLocalImagesInHtml(fragment, dirname(options.sourcePath), options.readImage);
  return `<article class="markdown-body">${inlined}</article>`;
}

// 构造完整导出 HTML 文档(含 <head> 样式 + base href)。wordCompatible 目前无 .doc 分支,预留参数省略。
export async function buildWritingExportHtmlDocument(options: {
  sourcePath: string;
  content: string;
  title?: string;
  readImage?: (path: string) => Promise<Buffer>;
}): Promise<string> {
  const title = options.title?.trim() || basenameWithoutExtension(options.sourcePath);
  const body = await buildWriteClipboardHtmlFragment({
    sourcePath: options.sourcePath,
    content: options.content,
    readImage: options.readImage,
  });
  // base href 指向文档所在目录:即便有图片未被内联(如远程/不支持类型),相对资源仍可解析。
  const baseHref = pathToFileURL(`${dirname(options.sourcePath)}/`).href;
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-Hans">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtmlAttr(title)}</title>`,
    `  <base href="${escapeHtmlAttr(baseHref)}" />`,
    `  <style>${EXPORT_CSS}</style>`,
    "</head>",
    "<body>",
    '  <main class="document-shell">',
    `    ${body}`,
    "  </main>",
    "</body>",
    "</html>",
  ].join("\n");
}

// 复制富文本到系统剪贴板:html(带样式片段)+ text(原文)双写。失败给可读 message。
export async function copyWritingDocumentAsRichText(
  req: WritingCopyRichTextRequest,
  readImage?: (path: string) => Promise<Buffer>,
): Promise<WritingCopyRichTextResult> {
  try {
    if (!req.path?.trim()) return { ok: false, message: "缺少文件路径" };
    const html = await buildWriteClipboardHtmlFragment({
      sourcePath: req.path,
      content: req.content ?? "",
      readImage,
    });
    clipboard.write({ html, text: req.content ?? "" });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// html-to-docx 的返回可能是 Buffer / ArrayBuffer / TypedArray / Blob,统一归一为 Buffer。
async function bufferFromDocxResult(result: ArrayBuffer | Blob | Buffer | Uint8Array): Promise<Buffer> {
  if (Buffer.isBuffer(result)) return result;
  if (ArrayBuffer.isView(result)) return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  if (typeof ArrayBuffer !== "undefined" && result instanceof ArrayBuffer) return Buffer.from(new Uint8Array(result));
  if (typeof Blob !== "undefined" && result instanceof Blob) return Buffer.from(await result.arrayBuffer());
  throw new TypeError("html-to-docx 返回了不支持的结果类型");
}

// 隐藏 BrowserWindow 渲染 HTML → PDF(printToPDF)或 PNG(capturePage)。等字体与图片就绪再产出。
// 复用 Kun renderHtmlDocument 做法:写临时 html 文件、file:// 加载、产出后销毁窗口并清理临时目录。
async function renderHtmlToBuffer(html: string, format: "pdf" | "png"): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "cortex-writing-export-"));
  const tempHtmlPath = join(tempDir, "document.html");
  await writeFile(tempHtmlPath, html, "utf8");
  const win = new BrowserWindow({
    show: false,
    backgroundColor: "#ffffff",
    width: 1200,
    height: 900,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadURL(pathToFileURL(tempHtmlPath).href);
    // 等字体与所有图片 load/error 完成再产出,避免截到半张图或未排版好的版面。
    await win.webContents.executeJavaScript(`
      Promise.all([
        document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
        Promise.all(Array.from(document.images).map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((res) => {
            const done = () => res(undefined);
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          });
        }))
      ]).then(() => undefined)
    `);
    if (format === "png") {
      // PNG:按内容实际宽高调整窗口内容尺寸再整页截图(夹到合理上下限,防超长/超宽)。
      const size = (await win.webContents.executeJavaScript(`({
        width: Math.min(1600, Math.max(800, document.documentElement.scrollWidth)),
        height: Math.min(16384, Math.max(600, document.documentElement.scrollHeight))
      })`)) as { width: number; height: number };
      win.setContentSize(size.width, size.height);
      const image = await win.webContents.capturePage();
      return image.toPNG();
    }
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await rm(tempDir, { recursive: true, force: true });
  }
}

// 导出运行时依赖:electron / html-to-docx / fs 能力经此注入,便于单测替身(不拉 electron/html-to-docx)。
export interface WritingExportRuntime {
  // 弹系统保存对话框,返回用户选择(canceled + filePath)。
  showSaveDialog(
    defaultPath: string,
    format: WritingExportFormat,
  ): Promise<{ canceled: boolean; filePath?: string }>;
  // HTML → PDF/PNG buffer(隐藏窗口渲染)。
  renderHtmlToBuffer(html: string, format: "pdf" | "png"): Promise<Buffer>;
  // HTML → DOCX buffer(html-to-docx,懒加载)。
  convertHtmlToDocx(html: string, opts: { title: string; source: string }): Promise<Buffer>;
  // 落盘(字符串或二进制)。
  writeArtifact(targetPath: string, data: string | Buffer): Promise<void>;
  // 读本地图片(供 HTML 内联);缺省 node fs.readFile。
  readImage?(path: string): Promise<Buffer>;
}

// 默认运行时:绑定真实 electron / html-to-docx / fs。parent 用于把保存对话框挂到发起窗口(mac 体验)。
export function defaultWritingExportRuntime(parent: BrowserWindow | null): WritingExportRuntime {
  return {
    async showSaveDialog(defaultPath, format) {
      const options: Electron.SaveDialogOptions = {
        title: "导出文档",
        defaultPath,
        filters: [exportDialogFilter(format)],
      };
      const res = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      return { canceled: res.canceled, filePath: res.filePath };
    },
    renderHtmlToBuffer,
    async convertHtmlToDocx(html, opts) {
      // 懒加载 html-to-docx:仅 DOCX 分支才拉入(externalizeDepsPlugin 下从 asar node_modules 解析)。
      const require = createRequire(import.meta.url);
      const htmlToDocx = require("html-to-docx") as (
        html: string,
        header?: string | null,
        docOptions?: Record<string, unknown>,
        footer?: string | null,
      ) => Promise<ArrayBuffer | Blob | Buffer | Uint8Array>;
      const result = await htmlToDocx(html, null, {
        title: opts.title,
        creator: "Cortex",
        keywords: ["markdown", "export"],
        description: `Exported from ${basename(opts.source)}`,
        font: "Arial",
        fontSize: 24,
      });
      return bufferFromDocxResult(result);
    },
    writeArtifact: (targetPath, data) => writeFile(targetPath, data),
    readImage: (path) => readFile(path),
  };
}

// 编排一次导出:校验 → 构造 HTML(内联图片)→ 弹保存框(取消即返回)→ 按格式产出并落盘。
// 边界与取舍:
//   - 缺 path → 失败(需相对图片基准 + 默认文件名);content 允许为空(导出空文档)。
//   - 「先弹框、后产出、再落盘」:任何一步抛错都不写半成品文件;取消不写文件。
//   - html/docx/pdf/png 各分支产物已在内存(string/Buffer)就绪后才 writeArtifact,失败前不落盘。
export async function exportWritingDocument(
  req: WritingExportRequest,
  runtime: WritingExportRuntime,
): Promise<WritingExportResult> {
  try {
    const sourcePath = req.path?.trim();
    if (!sourcePath) return { ok: false, message: "缺少文件路径" };
    const format = req.format;
    const title = req.title?.trim() || basenameWithoutExtension(sourcePath);

    const html = await buildWritingExportHtmlDocument({
      sourcePath,
      content: req.content ?? "",
      title,
      readImage: runtime.readImage,
    });

    const picked = await runtime.showSaveDialog(defaultExportPath(sourcePath, format), format);
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    const targetPath = ensureExportExtension(picked.filePath, format);

    if (format === "html") {
      await runtime.writeArtifact(targetPath, html);
    } else if (format === "docx") {
      const docx = await runtime.convertHtmlToDocx(html, { title, source: sourcePath });
      await runtime.writeArtifact(targetPath, docx);
    } else {
      const buffer = await runtime.renderHtmlToBuffer(html, format);
      await runtime.writeArtifact(targetPath, buffer);
    }

    return { ok: true, path: targetPath, format };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// 注册重型导出 IPC:export(弹框落盘)+ copyRichText(写剪贴板)。均不抛,失败/取消回可读结果。
export function registerWritingExportHandlers(): void {
  ipcMain.handle("writing:export", async (event, req: WritingExportRequest): Promise<WritingExportResult> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    return exportWritingDocument(req, defaultWritingExportRuntime(parent));
  });

  ipcMain.handle(
    "writing:copyRichText",
    async (_event, req: WritingCopyRichTextRequest): Promise<WritingCopyRichTextResult> =>
      copyWritingDocumentAsRichText(req),
  );
}
