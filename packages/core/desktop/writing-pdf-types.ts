// 写作 PDF 阅读(U5)IPC 契约类型。
// ⚠️ 与 apps/desktop/src/main/ipc/writing-pdf-types.ts 逐字镜像(双写契约,改动两处必须同步)。
// 渲染端 PDF 阅读器(pdfjs 动态 import)经此契约向主进程取 PDF 原始字节(base64),在中栏渲染页面。
// PDF 文本抽取(供 U4 检索索引)不走 IPC——主进程内部直接调 readWritePdfText,故不在本契约内。
// 独立成文件(不并入 writing-types.ts)是为降低与并行单元在 writing-types.ts 上的编辑冲突。

// 取 PDF 字节请求:目标文件绝对路径(写作空间内)。
export interface WritingPdfDataRequest {
  path: string;
}

// 取 PDF 字节结果:ok 时给 base64 编码的原始字节 + 大小 / 修改时间(渲染端据 mtime 判是否需重载);
// 失败(非 .pdf / 超限 / 读盘错)给可读 message,渲染端展示错误占位不崩。
export type WritingPdfDataResult =
  | {
      ok: true;
      path: string;
      base64: string;
      size: number;
      mtimeMs: number;
    }
  | {
      ok: false;
      message: string;
    };
