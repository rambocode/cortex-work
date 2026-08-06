// pi-host worker 的入口路径解析（U1 / KTD3）。
//
// 纯函数 + 参数注入（照 research/worker/entry-resolver.ts 与 capabilities/agent-browser/locate.ts
// 的写法），因此开发态与打包态两种形态都能在**不真的打包**的情况下测到；也刻意不 import
// `electron`，让本文件的单测不必装 electron 替身。app 的注入在 transport.ts 那一侧。
import path from "node:path";
import { existsSync } from "node:fs";

/**
 * 候选产物文件名（按优先级）。
 *
 * ⚠️ **刻意不含 `index.js`**（这与 research 的 entry-resolver 是有意的分歧）：
 * 两个 worker 的产物落在同一个 `out/worker/` 目录下，而 research 那边因为 `build.ssr: true`
 * 让 vite 忽略 `lib.fileName`、**实测产出的就是 `out/worker/index.js`**。若这里也把 `index.js`
 * 列为回退，一旦 pi-host 的产物名漂移，我们会**静默 fork 起 research worker**——它能正常启动、
 * 只是永远不回 pi 协议的任何一条消息，表现为「开会话超时」，排查成本极高。
 * 宁可找不到入口（响亮失败），也不要找错入口。
 */
const WORKER_FILE_NAMES = ["pi-host.js", path.join("pi-host", "index.js")] as const;

/** 产物相对 appPath / unpacked 根的目录。`electron-builder.yml` 的 `asarUnpack` 已含 `out/worker/**`。 */
const WORKER_DIR = path.join("out", "worker");

/** 解析入参。isPackaged / appPath / resourcesPath 由 electron 的 `app` 注入，exists 便于测试。 */
export interface PiHostEntryInput {
  isPackaged: boolean;
  /** 打包态是 `<...>/Resources/app.asar`；开发态是仓库里的 apps/desktop。 */
  appPath: string;
  resourcesPath: string;
  exists?: (candidate: string) => boolean;
}

/**
 * 解析 pi-host worker 入口的绝对路径；两种形态都找不到时返回 null（调用方据此响亮失败）。
 *
 * **打包态必须优先 `app.asar.unpacked`（KTD3）**：给 asar 内路径时 `utilityProcess.fork`
 * 会**静默失败**——进程起不来却不报错，表现为「code=0、无任何输出」，与 KTD2 的 stdin 配错
 * 是同一种症状、完全不同的成因。asar 内路径仍保留为最后回退，避免打包配置漂移时功能直接消失
 * （届时至少能拿到一条可诊断的启动失败，而不是「入口为 null」）。
 */
export function resolvePiHostEntry(input: PiHostEntryInput): string | null {
  const exists = input.exists ?? existsSync;
  // 目录优先级在外层、文件名优先级在内层：打包态先把 asar 外的候选全试完，再回退 asar 内。
  const roots = input.isPackaged
    ? [path.join(input.resourcesPath, "app.asar.unpacked"), input.appPath]
    : [input.appPath];

  const candidates = roots.flatMap((root) =>
    WORKER_FILE_NAMES.map((fileName) => path.join(root, WORKER_DIR, fileName)),
  );
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** 供诊断日志枚举「都找过哪些路径」——入口缺失时这份清单是唯一线索。 */
export function piHostEntryCandidates(input: Omit<PiHostEntryInput, "exists">): string[] {
  const roots = input.isPackaged
    ? [path.join(input.resourcesPath, "app.asar.unpacked"), input.appPath]
    : [input.appPath];
  return roots.flatMap((root) => WORKER_FILE_NAMES.map((fileName) => path.join(root, WORKER_DIR, fileName)));
}
