// 文档抽取 runner:在独立子进程里跑 worker(officeParser),带超时 + 堆上限。
// 进程模型(KTD2):child_process.fork —— 仓库已验证可用的子进程模式,崩溃/CPU 隔离等效,
// 不阻塞主进程。fork-per-request(每次抽取一个全新进程,超时即 SIGKILL),实现最简、隔离最彻底;
// v1 文档抽取频次低,冷启动成本可接受。
//
// 资源边界(KTD9 / 安全):
//  - execArgv --max-old-space-size 限 worker 堆,防恶意/超大文档(ZIP 膨胀、pdfjs 内存耗尽)撑爆。
//  - timeoutMs 到点 SIGKILL,杜绝卡死;输出字节上限在 extract.ts 内截断。
//
// ⚠ 打包待验证(U6,仓库外 ditto→/tmp):worker 脚本与 officeParser 的 pdfjs/tesseract wasm 资产
//   位于 asar 内,fork 出的子进程能否加载取决于打包方式。U6 须确认;若 fork-from-asar 失败,
//   回退方案 = asarUnpack worker + officeParser,或改用 utilityProcess.fork(asar-aware)。

import { fork } from "child_process";
import { join } from "path";
import { EXTRACT_TIMEOUT_MS, MAX_EXTRACT_TEXT_BYTES, type ExtractResult } from "./extract";

// worker 编译产物与 main 同目录(out/main/doc-extract-worker.js;构建入口见 U6 electron.vite.config)。
function workerPath(): string {
  return join(__dirname, "doc-extract-worker.js");
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: ExtractResult;
  error?: string;
}

export interface RunExtractionOptions {
  timeoutMs?: number;
  maxBytes?: number;
  // 测试可注入 worker 路径(指向编译后的 worker 或一个 stub)。
  workerScript?: string;
}

let seq = 0;

export function runExtraction(absPath: string, opts: RunExtractionOptions = {}): Promise<ExtractResult> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_EXTRACT_TEXT_BYTES;
  const id = ++seq;

  return new Promise<ExtractResult>((resolve, reject) => {
    const child = fork(opts.workerScript ?? workerPath(), [], {
      // 限 worker 堆,隔离恶意文档的内存耗尽;静默 stdio 避免污染主进程日志。
      execArgv: ["--max-old-space-size=512"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL"); // fork-per-request:回复后即销毁
      } catch {
        /* 已退出 */
      }
      fn();
    };

    const timer = setTimeout(() => {
      done(() => reject(new Error(`文档抽取超时(>${timeoutMs}ms)`)));
    }, timeoutMs);

    child.once("message", (msg: WorkerReply) => {
      if (msg.ok && msg.result) done(() => resolve(msg.result as ExtractResult));
      else done(() => reject(new Error(msg.error ?? "文档抽取失败")));
    });
    child.once("error", (e) => done(() => reject(e)));
    child.once("exit", (code) => {
      if (!settled) done(() => reject(new Error(`抽取 worker 异常退出(code=${code})`)));
    });

    child.send({ id, path: absPath, maxBytes });
  });
}
