// `electron` 模块的 worker 侧替身（构建期 alias 目标）。
//
// ── 为什么要 stub 掉整个 electron ─────────────────────────────────────────────────────
// 仓库既定规则（见 `src/worker/research/index.ts` 文件头）：**worker 目录禁止 import 任何
// electron API**——它跑在 `utilityProcess` 里，`electron` 模块只暴露极小的子集，`app` /
// `ipcMain` / `safeStorage` 全都不在其中。
//
// 但 pi-host 复用的主进程模块里有几条**只在函数体内**用 `app` 的路径：
//   · `agents/pi-extensions.ts` / `pi-mcp-bridge.ts` / `pi-providers.ts` → `app.getPath("userData")`
//     （都是 binary 路径「生成 .js extension 文件」用的，gateway 路径根本不会调）
//   · `agents/pi-locate.ts` → `app.isPackaged`（定位 bun 二进制，同上不会调）
// 它们经 `pi-rpc.ts`（`session.ts` 要它的 `mapPiEvent` / `slashCommandName`）进入依赖图。
//
// 把 `electron` external 掉也能跑（require 成功、成员访问才失败），但那样**失败点是
// `undefined.getPath is not a function`**，堆栈里看不出「这是主进程独有的 API」。
// 换成本 stub 后同样的误用会得到一句指名道姓的错误，且构建产物里完全没有 `require("electron")`
// ——「worker 不依赖 electron」从约定变成可 grep 的事实。

/** 被访问即抛。属性名进错误文案，让「谁在 worker 里碰了主进程 API」一眼可见。 */
function unavailable(namespace: string): never {
  throw new Error(
    `pi-host worker 不能使用 Electron 主进程 API（${namespace}）。` +
      `worker 跑在 utilityProcess 里，需要主进程能力请经 pi-gateway 协议回主进程取。`,
  );
}

/**
 * `app` 的替身。任何成员访问立即抛错。
 *
 * 用 Proxy 而不是逐个方法写桩：主进程模块用到的 `app` 成员会随迭代增减，
 * 漏一个就退回「undefined is not a function」那种无从下手的失败。
 */
export const app: unknown = new Proxy(
  {},
  {
    get: (_target, prop) => unavailable(`app.${String(prop)}`),
  },
);

/** `ipcMain` 的替身。理由同 `app`。 */
export const ipcMain: unknown = new Proxy(
  {},
  {
    get: (_target, prop) => unavailable(`ipcMain.${String(prop)}`),
  },
);

/** `safeStorage` 的替身。凭据必须经协议的 `credentialRequest` 回主进程解密（KTD1）。 */
export const safeStorage: unknown = new Proxy(
  {},
  {
    get: (_target, prop) => unavailable(`safeStorage.${String(prop)}`),
  },
);

// 默认导出：CJS 侧 `require("electron")` 的解构写法与 ESM 具名导入都能命中。
export default { app, ipcMain, safeStorage };
