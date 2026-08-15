// 文件检索引擎的主进程薄壳:纯逻辑全部在 fs-search-core.ts(零 electron 依赖,pi-host
// worker 的 glob 工具复用同一份),此处只补 electron 相关的 spill 目录定位并原样 re-export。
// 设计说明与移植出处(deepseek-harness tool-fs-search)见 fs-search-core.ts 文件头。
import { join } from "path";
import { documentsCortexDir } from "../paths";
import { saveSpillFile } from "./fs-search-core";

export * from "./fs-search-core";

/** spill 目录:落在 Documents/cortex 下(fs 白名单根内,渲染端可直接读/预览)。 */
export function searchSpillDir(): string {
  return join(documentsCortexDir(), ".search-results");
}

/** 主进程侧 spill:写进白名单内的 .search-results 目录(best-effort,语义见 saveSpillFile)。 */
export async function saveSearchSpill(baseName: string, content: string): Promise<string | undefined> {
  return saveSpillFile(searchSpillDir(), baseName, content);
}
