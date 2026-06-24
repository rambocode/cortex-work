// 文档抽取 worker(child_process.fork 的子进程入口)。
// 跑在独立进程里隔离 officeParser(pdfjs/@xmldom 等)的 CPU 占用与崩溃风险,不阻塞 Electron 主进程。
// 协议:父进程 send { id, path, maxBytes };本进程回 { id, ok, result } 或 { id, ok:false, error }。
// 超时由父进程(runner)在 fork 层 SIGKILL 强制,故此处不自管超时。

import { parseOffice } from "officeparser";
import { extractDocText, type ParseOffice } from "./extract";

interface ExtractRequest {
  id: number;
  path: string;
  maxBytes?: number;
}

process.on("message", (msg: ExtractRequest) => {
  void (async () => {
    try {
      const result = await extractDocText(msg.path, {
        maxBytes: msg.maxBytes,
        parse: parseOffice as unknown as ParseOffice,
      });
      process.send?.({ id: msg.id, ok: true, result });
    } catch (e) {
      process.send?.({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
});
