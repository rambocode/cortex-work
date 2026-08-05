// 文档抽取 runner:在主进程内调用 @firecrawl/anydoc 抽取。
//
// 进程模型:沿用 v1「主进程内跑」的决策(fork 独立 worker 会破坏 electron-vite 单入口 lib 预设,
// 见 git 史上 officeparser 时期的注释)。anydoc 是 napi-rs 原生模块,转换跑在 libuv 线程池、
// 不阻塞主进程事件循环,且纯 Rust 无 wasm/worker 资产,中位数毫秒级——风险面比 officeparser 更小。
// 代价不变:超时只能 Promise.race 甩开、无法硬 kill 卡死的原生调用;以 50MB 输入上限 + 输出截断缓解。
//
// anydoc 用动态 import 延迟加载(避免原生 .node 在 app 启动即载入,只在首次抽取时载)。

import { EXTRACT_TIMEOUT_MS, MAX_EXTRACT_TEXT_BYTES, extractDocText, type ConvertToMarkdown, type ExtractResult } from "./extract";

export interface RunExtractionOptions {
  timeoutMs?: number;
  maxBytes?: number;
  // 测试可注入 convert,避开真实 anydoc 原生模块。
  convert?: ConvertToMarkdown;
}

// 跑一次抽取:懒加载 anydoc + best-effort 超时包装。
export async function runExtraction(absPath: string, opts: RunExtractionOptions = {}): Promise<ExtractResult> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_EXTRACT_TEXT_BYTES;
  // 纯文本类(.txt/.csv/.md)在 extractDocText 内直读,不会用到 convert;二进制文档才需 anydoc。
  const convert = opts.convert ?? (await import("@firecrawl/anydoc")).toMarkdown;

  const work = extractDocText(absPath, { maxBytes, convert });
  // best-effort 超时:anydoc 异步跑在线程池,正常可被甩开;主进程内无法对卡死的原生调用硬 kill(隔离的代价)。
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
