// Research Worker 入口路径解析（spec §19.5「Worker 路径位于 asar 外的受控位置」）。
//
// 纯函数 + 参数注入（照 capabilities/agent-browser/locate.ts 的写法），因此可以在不打包的
// 情况下把两种形态都测到。
import path from "node:path";
import { existsSync } from "node:fs";

/// 候选产物文件名（按优先级）。
///
/// ⚠️ 为什么有两个：electron.worker.config.ts 声明的是 `lib.fileName -> research-worker.js`，
/// 但该配置同时开了 `build.ssr: true`，vite 在 ssr 模式下会忽略 lib.fileName，**实测产出的是
/// `out/worker/index.js`**。两个名字都接受，可以让「配置修好」与「配置维持现状」都不至于
/// 让 Worker 直接找不到入口。规范名排在前面，修好后自动切回去。
const WORKER_FILE_NAMES = ["research-worker.js", "index.js"] as const;

/// 产物相对 appPath 的目录。
const WORKER_DIR = path.join("out", "worker");

/// 解析入参。isPackaged / resourcesPath / appPath 由 electron 的 app 注入，exists 便于测试。
export interface ResearchWorkerEntryInput {
  isPackaged: boolean;
  /// 打包态是 `<...>/Resources/app.asar`；开发态是仓库里的 apps/desktop。
  appPath: string;
  resourcesPath: string;
  exists?: (candidate: string) => boolean;
}

/// 解析 Worker 入口的绝对路径；两种形态都找不到时返回 null（调用方据此判定 Worker 不可用）。
///
/// 打包态优先 `app.asar.unpacked`：electron-builder.yml 已配 `asarUnpack: out/worker/**`，
/// 子进程的模块解析根与 asar 边界的交互历史上不稳（doc-extract 的教训），解包纯 JS 零成本。
/// 仍保留 asar 内路径作为回退，避免打包配置漂移时功能直接消失。
export function resolveResearchWorkerEntry(input: ResearchWorkerEntryInput): string | null {
  const exists = input.exists ?? existsSync;
  // 目录优先级在外层、文件名优先级在内层：打包态先把 asar 外的两个名字都试完，再回退 asar 内。
  const roots = input.isPackaged
    ? [path.join(input.resourcesPath, "app.asar.unpacked"), input.appPath]
    : [input.appPath];

  const candidates = roots.flatMap((root) =>
    WORKER_FILE_NAMES.map((fileName) => path.join(root, WORKER_DIR, fileName)),
  );
  return candidates.find((candidate) => exists(candidate)) ?? null;
}
