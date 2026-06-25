/**
 * webhook-server.ts 单元测试。
 *
 * 测试场景：
 * 1. POST 正确 token（URL 路径）→ 200 accepted，触发 runFn
 * 2. POST 正确 token（Authorization header）→ 200 accepted
 * 3. POST 错误 token → 401
 * 4. POST 不存在路径 → 404
 * 5. 错误 HTTP 方法（GET when POST expected）→ 405
 * 6. 无 token 的工作流 → 无需 token 也可触发
 * 7. /hook-run 端点 stub → 200
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'http'

// ── mock loadWorkflows ─────────────────────────────────────────────────────────
vi.mock('./store', () => ({
  loadWorkflows: vi.fn(),
}))

import { loadWorkflows } from './store'
import type { WorkflowDef, WorkflowWebhookTriggerConfig } from './types'
import {
  startWebhookServer,
  stopWebhookServer,
  isWebhookServerListening,
} from './webhook-server'

// ── 测试数据 ──────────────────────────────────────────────────────────────────

const TEST_PORT = 18999

function makeWebhookWorkflow(opts: {
  path: string
  method?: string
  webhookToken?: string
  enabled?: boolean
}): WorkflowDef {
  return {
    id: `wf-webhook-${opts.path.replace(/\//g, '-')}`,
    name: `webhook-${opts.path}`,
    enabled: opts.enabled ?? true,
    callableByAgent: false,
    env: [],
    nodes: [
      {
        id: 'trig-1',
        type: 'webhook-trigger',
        name: 'webhook',
        position: { x: 0, y: 0 },
        disabled: false,
        config: {
          path: opts.path,
          method: (opts.method ?? 'ANY') as WorkflowWebhookTriggerConfig['method'],
          ...(opts.webhookToken ? { webhookToken: opts.webhookToken } : {}),
        } as WorkflowWebhookTriggerConfig & { webhookToken?: string },
      },
    ],
    connections: [],
    createdAt: '',
    updatedAt: '',
    lastRunAt: '',
    nextRunAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    runs: [],
  }
}

// ── HTTP 工具 ──────────────────────────────────────────────────────────────────

function request(opts: {
  method: string
  path: string
  body?: string
  headers?: Record<string, string>
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path: opts.path, method: opts.method,
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('webhook-server', () => {
  // P1 Fix-4：runFn 返回类型对齐 runWorkflowInternal → { ok, run }，webhook-server 用 run?.id 取 runId
  const runFn = vi.fn(async () => ({ ok: true, run: { id: 'run-test' } }))

  beforeAll(async () => {
    vi.mocked(loadWorkflows).mockResolvedValue([
      makeWebhookWorkflow({ path: 'test/path', method: 'ANY', webhookToken: 'secret-token-123' }),
      makeWebhookWorkflow({ path: 'post-only', method: 'POST', webhookToken: 'post-token' }),
      makeWebhookWorkflow({ path: 'no-auth', method: 'ANY' }), // 无 token
      makeWebhookWorkflow({ path: 'disabled', method: 'ANY', webhookToken: 'x', enabled: false }),
    ])
    await startWebhookServer(TEST_PORT, runFn)
  })

  afterAll(() => {
    stopWebhookServer()
  })

  it('服务器已在监听', () => {
    expect(isWebhookServerListening()).toBe(true)
  })

  it('POST 正确 URL token → 200 accepted', async () => {
    runFn.mockClear()
    const res = await request({
      method: 'POST',
      path: `/webhook/secret-token-123/test/path`,
      body: JSON.stringify({ key: 'value' }),
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { status: string; runId: string }
    expect(body.status).toBe('accepted')
    expect(body.runId).toBe('run-test')
    expect(runFn).toHaveBeenCalledOnce()
    const firstCall = runFn.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
    expect(firstCall[0]).toMatch(/wf-webhook-/)
    expect(firstCall[1]).toBe('webhook')
    expect(firstCall[2]).toEqual({ key: 'value' })
  })

  it('POST 正确 Authorization Bearer token → 200 accepted', async () => {
    runFn.mockClear()
    const res = await request({
      method: 'POST',
      path: `/webhook/test/path`, // 路径不带 token
      body: '{}',
      headers: { Authorization: 'Bearer secret-token-123' },
    })
    expect(res.status).toBe(200)
    expect(runFn).toHaveBeenCalledOnce()
  })

  it('POST 错误 token → 401', async () => {
    runFn.mockClear()
    const res = await request({
      method: 'POST',
      path: `/webhook/wrong-token/test/path`,
    })
    expect(res.status).toBe(401)
    expect(runFn).not.toHaveBeenCalled()
  })

  it('POST 不存在路径 → 404', async () => {
    runFn.mockClear()
    const res = await request({
      method: 'POST',
      path: `/webhook/any-token/nonexistent`,
    })
    expect(res.status).toBe(404)
    expect(runFn).not.toHaveBeenCalled()
  })

  it('错误 HTTP 方法（GET on POST-only webhook）→ 405', async () => {
    runFn.mockClear()
    const res = await request({
      method: 'GET',
      path: `/webhook/post-token/post-only`,
    })
    expect(res.status).toBe(405)
    expect(runFn).not.toHaveBeenCalled()
  })

  it('disabled 工作流不触发 → 404', async () => {
    runFn.mockClear()
    const res = await request({
      method: 'POST',
      path: `/webhook/x/disabled`,
    })
    // disabled 工作流不在匹配列表，path 找不到 → 404
    expect(res.status).toBe(404)
    expect(runFn).not.toHaveBeenCalled()
  })

  it('无 token 的工作流无需 token → 200', async () => {
    runFn.mockClear()
    const res = await request({
      method: 'POST',
      path: `/webhook/no-auth`,
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(runFn).toHaveBeenCalledOnce()
  })

  it('/hook-run stub → 501（P2 Fix-12：未实现端点返回 501 Not Implemented）', async () => {
    const res = await request({
      method: 'POST',
      path: '/hook-run',
    })
    // P2 Fix-12：/hook-run 是预留端点，暂不实现，应返回 501 而非 200，
    // 防止 agent 误以为调用成功。
    expect(res.status).toBe(501)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('未实现')
  })
})
