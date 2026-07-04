// window.kunGui 是 Kun 注入的全局桥接。design 树的 kunGui.* 调用已由 codemod 迁移到
// kunGuiPort;下面两处只读 leftover(platform / homeDir)未被覆盖,且 kunGuiPort 未暴露
// platform。用局部交叉类型让访问类型安全,行为与 Kun 一致(未注入时降级为默认值),
// 避免直接扩充全局 Window 类型造成跨文件冲突。
type KunGuiGlobalWindow = Window & { kunGui?: { platform?: string; homeDir?: string } }

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// 品牌升级后默认目录在 ~/.kun 下;老版本/迁移失败的机器上仍可能出现
// ~/.deepseekgui 形式,这里对两套路径都要认,并归一到同一个身份键,
// 避免同一个默认工作区在侧栏里出现两份。
function isDefaultWorkspacePath(normalized: string): boolean {
  return (
    normalized === '~/.kun/default_workspace'
    || normalized.endsWith('/.kun/default_workspace')
    || normalized === '~/.deepseekgui/default_workspace'
    || normalized.endsWith('/.deepseekgui/default_workspace')
  )
}

export function workspaceRootIdentityKey(path?: string): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  const normalized = normalizePathForMatch(trimmed)
  if (isDefaultWorkspacePath(normalized)) {
    return '~/.kun/default_workspace'
  }
  return normalized
}

export function isInternalTemporaryWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return (
    /\/deepseek-tui-updates\/tmp(?:\/|$)/.test(normalized)
    || normalized === '/tmp'
    || normalized.startsWith('/tmp/')
    || normalized === '/private/tmp'
    || normalized.startsWith('/private/tmp/')
    || /^\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /^\/private\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /\/appdata\/local\/temp(?:\/|$)/.test(normalized)
  )
}

export function isClawWorkspacePath(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return normalized.includes('/.kun/claw/') || normalized.includes('/.deepseekgui/claw/')
}

// 对话会话不绑定项目文件夹,默认在 ~/Documents/Kun(macOS/Windows)或
// ~/.local/share/Kun/conversations(Linux)下按时间戳创建工作目录。
export function defaultConversationWorkspaceRoot(): string {
  const kunGui = typeof window !== 'undefined' ? (window as KunGuiGlobalWindow).kunGui : undefined
  const platform = kunGui?.platform ? kunGui.platform : ''
  return platform === 'linux' ? '~/.local/share/Kun/conversations' : '~/Documents/Kun'
}
// 兼容旧引用;动态取值。
export const DEFAULT_CONVERSATION_WORKSPACE_ROOT = defaultConversationWorkspaceRoot()

// 判断给定路径是否落在对话工作目录根(或就是根本身)之下。
// root 可能是带 ~ 的设置值,也可能是绝对路径;两侧都按分隔符归一后比较前缀。
export function isConversationWorkspacePath(path?: string, root?: string): boolean {
  const trimmedPath = path?.trim() ?? ''
  if (!trimmedPath) return false
  const effectiveRoot = (root?.trim() ? root.trim() : defaultConversationWorkspaceRoot())
  const normalizedPath = normalizePathForMatch(expandHomeForMatch(trimmedPath))
  const normalizedRoot = normalizePathForMatch(expandHomeForMatch(effectiveRoot))
  if (!normalizedRoot) return false
  if (normalizedPath === normalizedRoot) return true
  return normalizedPath.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`)
}

// 仅供路径前缀比较:把 ~ 展开成 home(渲染层没有 node:os,这里用 window.kunGui.homeDir)。
// 与主进程的 expandHomePath 行为一致;拿不到 homeDir 时退化为不展开,仍能匹配绝对路径。
function expandHomeForMatch(value: string): string {
  if (!value.startsWith('~')) return value
  const kunGui = typeof window !== 'undefined' ? (window as KunGuiGlobalWindow).kunGui : undefined
  const home = kunGui?.homeDir ? kunGui.homeDir : ''
  if (!home) return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return `${home}/${value.slice(2).replace(/\\/g, '/')}`
  }
  return value
}

export function isInternalDeepSeekGuiWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return (
    normalized === '~/.kun/write_workspace'
    || normalized.endsWith('/.kun/write_workspace')
    || normalized === '~/.kun/design-workspace'
    || normalized.endsWith('/.kun/design-workspace')
    || normalized === '~/.deepseekgui/write_workspace'
    || normalized.endsWith('/.deepseekgui/write_workspace')
    || normalized === '~/.deepseekgui/design-workspace'
    || normalized.endsWith('/.deepseekgui/design-workspace')
  )
}

export function normalizeWorkspaceRoot(path?: string): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  if (isInternalTemporaryWorkspace(trimmed)) return ''
  return trimmed
}
