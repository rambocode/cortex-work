/**
 * 画布所需的最小文件能力。调用方显式注入，画布核心不感知 Electron、Web 或 Kun 全局对象。
 * 路径始终是相对 `workspaceRoot` 的工作区路径；越界与写权限由宿主实现负责校验。
 */
export interface CanvasFilePort {
  readText(workspaceRoot: string, relativePath: string): Promise<string | null>
  writeText(workspaceRoot: string, relativePath: string, content: string): Promise<boolean>
  readImageDataUrl?(workspaceRoot: string, path: string): Promise<string | null>
}
