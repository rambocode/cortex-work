// 文档抽取 runner:在主进程内调用 officeParser 抽取(v1)。
//
// 进程模型(执行期决策,修订自计划 KTD2):原计划 child_process.fork 独立 worker 隔离,但
// 为 worker 单独建 electron-vite 构建入口会覆盖主进程单入口 lib 预设、使 externalizeDepsPlugin
// 失效(把 nodemailer/electron-updater/MCP SDK 等全打进 chunk),是回归;且 asar 内 worker +
// pdfjs/tesseract wasm 的 fork 加载无法在本地经验性验证。故 v1 改为主进程内跑:officeParser 经
// externalizeDepsPlugin 正常外部化、配合 electron-builder asarUnpack 取真实文件(wasm 完整)。
// 代价:失去进程隔离(恶意/超大文档可能拖累主进程);以 50MB 输入上限 + 输出截断 + best-effort
// 超时缓解。进程隔离(utilityProcess.fork + 旁置 worker 资产)列为二期 follow-up。
//
// officeParser 用动态 import 延迟加载(避免 pdfjs/tesseract 在 app 启动即载入,只在首次抽取时载)。

import { EXTRACT_TIMEOUT_MS, MAX_EXTRACT_TEXT_BYTES, extractDocText, type ExtractResult, type ParseOffice } from "./extract";

export interface RunExtractionOptions {
  timeoutMs?: number;
  maxBytes?: number;
  // 测试可注入 parse,避开真实 officeParser/wasm。
  parse?: ParseOffice;
}

export async function runExtraction(absPath: string, opts: RunExtractionOptions = {}): Promise<ExtractResult> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_EXTRACT_TEXT_BYTES;
  // 纯文本类(.txt/.csv/.md)在 extractDocText 内直读,不会用到 parse;Office 类才需 officeParser。
  const parse = opts.parse ?? ((await import("officeparser")).parseOffice as unknown as ParseOffice);

  const work = extractDocText(absPath, { maxBytes, parse });
  // best-effort 超时:officeParser 异步,正常可被甩开;主进程内无法对卡死的解析硬 kill(隔离的代价)。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`文档抽取超时(>${timeoutMs}ms)`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
