/**
 * 工作流 Webhook 本地 HTTP server（仅监听 127.0.0.1）。
 *
 * 安全设计（zh-Hans 注释）：
 * ──────────────────────────────────────────────────────────────────────────────
 * 1. 仅绑定 127.0.0.1（loopback），不对外网开放；局域网其他机器无法直接触发。
 * 2. 每个 webhook-trigger 工作流在 config.webhookToken 存一个随机令牌；
 *    POST 请求的 URL 路径必须包含匹配的 token（`/webhook/<token>/<path>`），
 *    或在 Authorization 头中以 Bearer 形式传入。
 *    Token 校验失败 → 401，防止同机其他进程随意触发任意工作流。
 * 3. 路径不匹配任何已启用 webhook-trigger → 404（不泄露 token 信息）。
 * 4. 仅 POST（及 webhookMethod 字段匹配）请求触发执行；其余方法 → 405。
 *
 * 路径约定：
 *   POST /webhook/<token>/<path>
 *       <token> = workflow.nodes[webhookTrigger].config.webhookToken
 *       <path>  = workflow.nodes[webhookTrigger].config.path（不含前导 /）
 *   POST /hook-run（Kun 兼容端点；stub，未来可接工作流内部回调）
 *
 * Body：JSON 解析（解析失败时以 text 字段包装原始文本）。
 * Body 大小上限：1MB（防止大 payload 压垮主进程）。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import type { WorkflowDef } from './types'
import { loadWorkflows } from './store'

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** webhook body 大小上限（1 MB）。 */
const MAX_BODY_SIZE = 1_048_576

/** runWorkflowInternal 的类型签名（注入以避免循环 import）。
 * 返回类型对齐 runWorkflowInternal：{ ok, run }；webhook server 从 run.id 取 runId。
 */
type RunFn = (
  workflowId: string,
  trigger: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; run?: { id: string } | null }>

// ── 内部状态 ──────────────────────────────────────────────────────────────────

let server: Server | null = null
let _port = 18765
let _runFn: RunFn | null = null

// ── body 读取 ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        reject(new Error('body 超过 1MB 限制'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 解析 body：JSON 优先，解析失败则包装为 { text }。 */
async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const buf = await readBody(req)
    const text = buf.toString('utf8')
    if (!text) return {}
    try {
      const parsed = JSON.parse(text) as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { json: parsed }
    } catch {
      return { text }
    }
  } catch {
    return {}
  }
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function ok(res: ServerResponse, data: unknown): void {
  send(res, 200, JSON.stringify(data))
}

function err(res: ServerResponse, status: number, message: string): void {
  send(res, status, JSON.stringify({ error: message }))
}

// ── 请求处理 ──────────────────────────────────────────────────────────────────

/**
 * 从 /webhook/ 后面提取候选路径段列表（去掉 query string 和前缀 /webhook/）。
 * 返回 null 如果不是 /webhook/ 路径。
 */
function getWebhookSegments(urlPath: string): string[] | null {
  // 去掉 query string。
  const [pathname] = urlPath.split('?')
  const parts = (pathname ?? '').split('/').filter(Boolean)
  if (parts[0] !== 'webhook') return null
  return parts.slice(1) // 去掉 'webhook' 前缀，剩余段供路径/token 解析
}

/**
 * 在当前 enabled 工作流中查找匹配该 webhook 请求的 workflow。
 *
 * 路径匹配策略（防止 URL 结构歧义）：
 * 采用「贪婪路径匹配」：对 /webhook/ 后的所有段，从两种视角尝试匹配：
 *   A. 所有段作为 webhookPath（无 URL token，token 由 Authorization header 提供）
 *   B. 第一段作为 token，其余段作为 webhookPath（URL token 模式）
 * 优先检查 A 模式（纯路径匹配），命中后再检验 token；
 * 若 A 模式路径不匹配，再尝试 B 模式（segments[0]=token，rest=path）。
 *
 * 鉴权规则：
 * - 工作流 config.webhookToken 存在 → 必须提供匹配 token（URL 或 header）。
 * - 工作流无 webhookToken → 无需 token，任意请求可触发。
 *
 * 返回 { workflow, config } 或 { notFound } 或 { unauthorized }。
 */
function matchWebhook(
  workflows: WorkflowDef[],
  segments: string[],
  headerToken: string | undefined,
): { workflow: WorkflowDef; config: Record<string, unknown> } | { notFound: true } | { unauthorized: true } {
  // 规范化 config.path（去除前导/后缀 /）。
  const norm = (s: string) => s.replace(/^\/|\/$/g, '')

  // 候选 A：所有段作为 webhookPath（header-only token 场景）。
  const pathA = norm(segments.join('/'))
  // 候选 B：segments[0] 作为 URL token，segments[1:] 作为 webhookPath。
  const urlTokenB = segments.length >= 2 ? segments[0] : undefined
  const pathB = segments.length >= 2 ? norm(segments.slice(1).join('/')) : undefined

  let firstUnauthorized = false

  for (const workflow of workflows) {
    if (!workflow.enabled) continue
    const triggerNode = workflow.nodes.find((n) => n.type === 'webhook-trigger')
    if (!triggerNode) continue
    const config = triggerNode.config as {
      path: string
      webhookToken?: string
      method?: string
    }
    const expectedToken = config.webhookToken
    const configPath = norm(config.path ?? '')

    /**
     * 时序安全 token 比较（P2 Fix-12）。
     * 防止计时侧信道攻击：标准 ===  比较会短路，攻击者可用响应时间枚举 token。
     * timingSafeEqual 要求等长 Buffer，长度不等时直接判 false（不泄露长度信息）。
     */
    const safeTokenEqual = (a: string, b: string): boolean => {
      try {
        const ba = Buffer.from(a)
        const bb = Buffer.from(b)
        return ba.length === bb.length && timingSafeEqual(ba, bb)
      } catch {
        return false
      }
    }

    // 尝试 A 模式：pathA = webhookPath，token 来自 header。
    if (configPath === pathA) {
      if (expectedToken) {
        const provided = headerToken
        if (!provided || !safeTokenEqual(provided, expectedToken)) {
          // 路径匹配但 token 不对 → 记录 unauthorized（不立即返回，还要尝试 B 模式）。
          firstUnauthorized = true
          // 继续尝试 B 模式（同 config 可能 B 模式匹配成功）。
        } else {
          return { workflow, config: config as Record<string, unknown> }
        }
      } else {
        // P2 Fix-12：normalize 已确保 webhookToken 总存在，此分支在现有存量数据中仍可能出现。
        // 保留以维持向后兼容，不应再有新工作流走到此处。
        return { workflow, config: config as Record<string, unknown> }
      }
    }

    // 尝试 B 模式：segments[0]=urlToken，rest=webhookPath。
    if (pathB !== undefined && configPath === pathB) {
      if (expectedToken) {
        const provided = urlTokenB ?? headerToken
        if (!provided || !safeTokenEqual(provided, expectedToken)) {
          firstUnauthorized = true
        } else {
          return { workflow, config: config as Record<string, unknown> }
        }
      } else {
        // 无 token 要求 → 直接匹配（向后兼容）。
        return { workflow, config: config as Record<string, unknown> }
      }
    }
  }

  if (firstUnauthorized) return { unauthorized: true }
  return { notFound: true }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? ''

  // ── Kun 兼容端点（stub）───────────────────────────────────────────────────
  if (url.startsWith('/hook-run')) {
    // P2 Fix-12：/hook-run 未实现，返回 501 Not Implemented（原返回 200 且无鉴权，会误导调用方）。
    err(res, 501, '/hook-run 端点尚未实现（Kun 兼容端点，待后续版本接线）')
    return
  }

  // ── Webhook 触发端点 ───────────────────────────────────────────────────────
  const segments = getWebhookSegments(url)
  if (segments === null || segments.length === 0) {
    // 不匹配 /webhook/* 格式（或 /webhook 后无段）
    err(res, 404, '未找到匹配的 webhook 路由')
    return
  }

  // 从 Authorization header 提取 Bearer token（备选鉴权方式）。
  const headerAuth = req.headers['authorization']
  const headerToken =
    typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')
      ? headerAuth.slice(7).trim()
      : undefined

  const workflows = await loadWorkflows()
  const match = matchWebhook(workflows, segments, headerToken)

  if ('notFound' in match) {
    err(res, 404, '未找到匹配的 webhook 工作流')
    return
  }
  if ('unauthorized' in match) {
    // 安全：token 不匹配，拒绝请求（防止任意本地进程触发工作流）。
    err(res, 401, 'webhook token 不匹配，请求被拒绝')
    return
  }

  const { workflow, config } = match

  // HTTP 方法校验（webhookMethod 字段）。
  const allowedMethod = (config.method as string | undefined) ?? 'ANY'
  if (allowedMethod !== 'ANY' && req.method?.toUpperCase() !== allowedMethod) {
    err(res, 405, `该 webhook 只接受 ${allowedMethod} 方法`)
    return
  }

  // 解析 body 作为触发器 input payload。
  const body = await parseBody(req)

  if (!_runFn) {
    err(res, 503, '工作流运行时尚未就绪')
    return
  }

  // fire-and-forget：立即返回 202 Accepted，不等待执行完成。
  const runResult = await _runFn(workflow.id, 'webhook', body)
  if (runResult.ok) {
    ok(res, { status: 'accepted', runId: runResult.run?.id, workflowId: workflow.id })
  } else {
    err(res, 500, '工作流启动失败')
  }
}

// ── 对外 API ──────────────────────────────────────────────────────────────────

/**
 * 启动 webhook HTTP server（如已在监听则先关再建，确保 port 更新生效）。
 *
 * @param port   监听端口（默认 18765，可在 settings 中配置）
 * @param runFn  工作流运行函数（注入以避免循环 import）
 */
export function startWebhookServer(port: number, runFn: RunFn): Promise<void> {
  _runFn = runFn

  // 若 port 未变且 server 已在监听，无需重建。
  if (server?.listening && _port === port) return Promise.resolve()

  // 先关旧 server。
  return new Promise((resolve) => {
    const launch = () => {
      _port = port
      server = createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          console.error('[webhook-server] 处理请求异常:', err)
          if (!res.headersSent) send(res, 500, JSON.stringify({ error: '服务器内部错误' }))
        })
      })
      server.listen(port, '127.0.0.1', () => {
        console.log(`[webhook-server] 监听 127.0.0.1:${port}`)
        resolve()
      })
      server.on('error', (err) => {
        console.error(`[webhook-server] 监听 127.0.0.1:${port} 失败:`, err)
        // 端口冲突：降级记录，不抛错（不阻断应用启动）。
        resolve()
      })
    }

    if (server) {
      server.close(launch)
    } else {
      launch()
    }
  })
}

/** 停止 webhook server（app 退出 / 无 enabled webhook 工作流时调用）。 */
export function stopWebhookServer(): void {
  if (server) {
    server.close()
    server = null
  }
}

/** 当前 webhook server 是否在监听（供测试查询）。 */
export function isWebhookServerListening(): boolean {
  return server?.listening ?? false
}

/** 当前监听端口（供测试查询）。 */
export function getWebhookServerPort(): number {
  return _port
}
