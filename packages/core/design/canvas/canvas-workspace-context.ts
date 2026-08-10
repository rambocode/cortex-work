import { createContext, useContext } from 'react'
import type { CanvasFilePort } from './canvas-file-port'

export type CanvasWorkspaceValue = {
  /** Workspace root used to resolve workspace-relative image paths to data URLs. */
  workspaceRoot: string
  /** 宿主显式注入的文件能力；会话白板用它隔离 Kun 兼容层。 */
  filePort?: CanvasFilePort
}

export const CanvasWorkspaceContext = createContext<CanvasWorkspaceValue>({ workspaceRoot: '' })

export function useCanvasWorkspaceRoot(): string {
  return useContext(CanvasWorkspaceContext).workspaceRoot
}

export function useCanvasWorkspaceFilePort(): CanvasFilePort | undefined {
  return useContext(CanvasWorkspaceContext).filePort
}
