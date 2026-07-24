// bento runtime 空壳定位:打包态在 process.resourcesPath/slides/bento/,开发态在仓库
// apps/desktop/resources 下(由 scripts/sync-bento-runtime.mjs 从 vendor/bento 构建产物同步)。
// 读取失败向上抛,由调用方(IPC handler)转结构化错误 —— 壳缺失属于构建/安装问题,须显式暴露。
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** runtime.html 的绝对路径(打包态优先,回落开发态仓库资源)。 */
export function bentoRuntimePath(): string {
  const packaged = join(process.resourcesPath ?? "", "slides", "bento", "runtime.html");
  if (process.resourcesPath && existsSync(packaged)) return packaged;
  return join(app.getAppPath(), "resources", "slides", "bento", "runtime.html");
}

let cachedRuntime: string | null = null;

/** 读取 runtime 空壳(进程内缓存;资源只读,不需失效)。 */
export async function readBentoRuntimeHtml(): Promise<string> {
  if (cachedRuntime !== null) return cachedRuntime;
  cachedRuntime = await fsp.readFile(bentoRuntimePath(), "utf8");
  return cachedRuntime;
}
