// 工作区路径判定。原 Kun 版本还带着一批「识别 Kun / DeepSeekGUI 自家目录」的
// 判定函数（默认工作区、claw、write_workspace 等），移植到 cortex 后没有任何
// 调用点，且判定的是别的应用的目录，故一并删除；本文件只保留仍在用的部分。
// platform / homeDir 统一走注入式 cortexGuiPort（core 禁触 window 全局）。
import { cortexGuiPort } from './cortex-gui-port'

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// 系统临时目录不算「用户工作区」：它随时会被清理，记进最近工作区列表没有意义。
export function isInternalTemporaryWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return (
    normalized === '/tmp'
    || normalized.startsWith('/tmp/')
    || normalized === '/private/tmp'
    || normalized.startsWith('/private/tmp/')
    || /^\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /^\/private\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /\/appdata\/local\/temp(?:\/|$)/.test(normalized)
  )
}

// 对话会话不绑定项目文件夹,默认在 ~/Documents/Cortex(macOS/Windows)或
// ~/.local/share/Cortex/conversations(Linux)下按时间戳创建工作目录。
export function defaultConversationWorkspaceRoot(): string {
  const platform = cortexGuiPort()?.platform ?? ''
  return platform === 'linux' ? '~/.local/share/Cortex/conversations' : '~/Documents/Cortex'
}

export function normalizeWorkspaceRoot(path?: string): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  if (isInternalTemporaryWorkspace(trimmed)) return ''
  return trimmed
}
