// 写作重型导出(U6)IPC 契约类型。
// ⚠️ 与 apps/desktop/src/main/ipc/writing-export-types.ts 逐字镜像(双写契约,改动两处必须同步)。
// 当前 md 文档 → 主进程同源渲染 HTML(内联本地图片为 dataURI)→ DOCX(html-to-docx)/
// PDF/PNG(隐藏 BrowserWindow printToPDF/capturePage)/ HTML 文件 / 复制富文本(clipboard html)。
// 目标路径由导出 handler 内的系统保存对话框选取(对齐 Kun write-export-service,不再单开 fs:pickSavePath)。
// 独立成文件(不并入 writing-types.ts)是为降低与并行单元在 writing-types.ts 上的编辑冲突。

// 导出格式:docx / pdf / png / html。复制富文本走独立通道(WritingCopyRichText*),不在此枚举。
export type WritingExportFormat = "docx" | "pdf" | "png" | "html";

// 导出请求:path(当前文件绝对路径——算相对图片基准 + 默认文件名 + 白名单校验)+
// content(当前草稿,未落盘也能导出)+ format;title 可选(缺省取文件名去扩展)。
export interface WritingExportRequest {
  path: string;
  content: string;
  format: WritingExportFormat;
  title?: string;
}

// 导出结果:
//   - ok:给最终落盘绝对路径与 format(渲染端 toast 展示);
//   - 取消(用户在保存对话框点取消):canceled=true,渲染端静默不 toast;
//   - 失败(渲染/落盘/html-to-docx 异常):canceled 省略/false + 可读 message。
// 失败与取消一律不写半成品文件(先渲染成 buffer 再落盘)。
export type WritingExportResult =
  | { ok: true; path: string; format: WritingExportFormat }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; message: string };

// 复制富文本请求:path(相对图片基准 + md/纯文本判定)+ content(当前草稿)。
export interface WritingCopyRichTextRequest {
  path: string;
  content: string;
}

// 复制富文本结果:成功写入系统剪贴板(html + 纯文本双写)或失败给可读 message。
export type WritingCopyRichTextResult = { ok: true } | { ok: false; message: string };
