/**
 * http.ts 单元测试（U11）
 *
 * 覆盖：
 *   GET / POST 基本请求
 *   header interpolate
 *   超时（模拟 AbortError）
 *   parseJson=true 解析 / 失败 fallback
 *   >5MB 响应体截断（抛 Error）
 *   HTTP 错误状态码（4xx/5xx）抛 Error
 *   非法 URL 抛 Error
 *   GET/DELETE 不发 body
 *
 * 使用 vitest vi.stubGlobal('fetch', ...) mock 全局 fetch。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeHttpRequest } from './http.js'
import type { WorkflowPayload } from '../runtime/interp.js'

const p = (json: unknown, text = ''): WorkflowPayload => ({ json, text })
const scope = {}

// ── mock fetch 工厂 ──────────────────────────────────────────────────────────

/**
 * 创建一个 mock fetch 函数，返回指定的响应。
 * body 以 ReadableStream 形式返回，模拟真实 fetch 行为。
 */
function mockFetch(
  status: number,
  bodyText: string,
  contentType = 'application/json',
  ok = true
) {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(bodyText)

  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    text: () => Promise.resolve(bodyText),
    headers: new Headers({ 'content-type': contentType }),
  })
}

/**
 * 创建一个 mock fetch 函数，模拟超时（AbortError）。
 */
function mockAbortFetch() {
  return vi.fn().mockRejectedValue(
    Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── 基本请求 ──────────────────────────────────────────────────────────────────

describe('executeHttpRequest - GET', () => {
  it('GET 请求成功，parseJson=false → { status, body }', async () => {
    vi.stubGlobal('fetch', mockFetch(200, 'hello world', 'text/plain'))

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    const result = await executeHttpRequest(config, p({}), scope)
    const json = result.payload.json as { status: number; body: string }
    expect(json.status).toBe(200)
    expect(json.body).toBe('hello world')
    expect(result.payload.text).toBe('hello world')
  })

  it('GET 请求，parseJson=true，合法 JSON → 解析结果', async () => {
    vi.stubGlobal('fetch', mockFetch(200, '{"data":[1,2,3]}'))

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: true,
    }

    const result = await executeHttpRequest(config, p({}), scope)
    expect(result.payload.json).toEqual({ data: [1, 2, 3] })
  })

  it('GET 请求，parseJson=true，非法 JSON → fallback { status, body }', async () => {
    vi.stubGlobal('fetch', mockFetch(200, 'not json at all'))

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: true,
    }

    const result = await executeHttpRequest(config, p({}), scope)
    const json = result.payload.json as { status: number; body: string }
    expect(json.status).toBe(200)
    expect(json.body).toBe('not json at all')
  })
})

describe('executeHttpRequest - POST', () => {
  it('POST 发送 body', async () => {
    const fetchMock = mockFetch(201, '{"id":1}')
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      method: 'POST' as const,
      url: 'https://example.com/api',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: '{"name":"test"}',
      timeoutMs: 5000,
      parseJson: true,
    }

    const result = await executeHttpRequest(config, p({}), scope)
    expect(result.payload.json).toEqual({ id: 1 })

    // 验证确实传了 body
    const callInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(callInit.body).toBe('{"name":"test"}')
  })

  it('GET 不发 body（即使配置了 body）', async () => {
    const fetchMock = mockFetch(200, '{}')
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [],
      body: 'should be ignored',
      timeoutMs: 5000,
      parseJson: false,
    }

    await executeHttpRequest(config, p({}), scope)
    const callInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(callInit.body).toBeUndefined()
  })

  it('DELETE 不发 body', async () => {
    const fetchMock = mockFetch(204, '')
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      method: 'DELETE' as const,
      url: 'https://example.com/api/1',
      headers: [],
      body: 'should be ignored',
      timeoutMs: 5000,
      parseJson: false,
    }

    await executeHttpRequest(config, p({}), scope)
    const callInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(callInit.body).toBeUndefined()
  })
})

// ── header interpolate ───────────────────────────────────────────────────────

describe('executeHttpRequest - header interpolate', () => {
  it('header value 展开模板变量', async () => {
    const fetchMock = mockFetch(200, '{}')
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [{ key: 'X-Token', value: 'Bearer {{json.token}}' }],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    await executeHttpRequest(config, p({ token: 'my-api-key-123' }), scope)
    const callInit = fetchMock.mock.calls[0][1] as RequestInit
    const headers = callInit.headers as Record<string, string>
    expect(headers['X-Token']).toBe('Bearer my-api-key-123')
  })

  it('空 key 的 header 被跳过', async () => {
    const fetchMock = mockFetch(200, '{}')
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [{ key: '', value: 'ignored' }, { key: 'X-Valid', value: 'yes' }],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    await executeHttpRequest(config, p({}), scope)
    const callInit = fetchMock.mock.calls[0][1] as RequestInit
    const headers = callInit.headers as Record<string, string>
    expect(headers['X-Valid']).toBe('yes')
    expect(headers['']).toBeUndefined()
  })
})

// ── 错误处理 ──────────────────────────────────────────────────────────────────

describe('executeHttpRequest - 错误处理', () => {
  it('超时 → 抛 "Request timed out" Error', async () => {
    vi.stubGlobal('fetch', mockAbortFetch())

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [],
      body: '',
      timeoutMs: 1000,
      parseJson: false,
    }

    await expect(executeHttpRequest(config, p({}), scope)).rejects.toThrow(
      'Request timed out'
    )
  })

  it('HTTP 4xx → 抛 Error（包含状态码）', async () => {
    vi.stubGlobal('fetch', mockFetch(404, 'Not Found', 'text/plain', false))

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    await expect(executeHttpRequest(config, p({}), scope)).rejects.toThrow('HTTP 404')
  })

  it('HTTP 5xx → 抛 Error', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'Internal Server Error', 'text/plain', false))

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/api',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    await expect(executeHttpRequest(config, p({}), scope)).rejects.toThrow('HTTP 500')
  })

  it('非法 URL → 抛 "Invalid URL" Error', async () => {
    vi.stubGlobal('fetch', mockFetch(200, '{}'))

    const config = {
      method: 'GET' as const,
      url: 'not-a-valid-url',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    await expect(executeHttpRequest(config, p({}), scope)).rejects.toThrow('Invalid URL')
  })

  it('非 http/https 协议 → 抛 Error', async () => {
    vi.stubGlobal('fetch', mockFetch(200, '{}'))

    const config = {
      method: 'GET' as const,
      url: 'ftp://example.com/file',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    await expect(executeHttpRequest(config, p({}), scope)).rejects.toThrow(
      'Only http(s) URLs are allowed'
    )
  })
})

// ── >5MB 响应体截断 ───────────────────────────────────────────────────────────

describe('executeHttpRequest - 5MB 响应体限制', () => {
  it('>5MB 响应体 → 抛 "exceeds the 5MB limit" Error', async () => {
    // 构造一个超过 5MB 的 ReadableStream
    const BIG_CHUNK_SIZE = 6 * 1024 * 1024 // 6MB
    const bigData = new Uint8Array(BIG_CHUNK_SIZE)
    bigData.fill(65) // 'A'

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bigData)
            controller.close()
          },
        }),
        text: () => Promise.resolve('A'.repeat(BIG_CHUNK_SIZE)),
      })
    )

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/big',
      headers: [],
      body: '',
      timeoutMs: 10000,
      parseJson: false,
    }

    await expect(executeHttpRequest(config, p({}), scope)).rejects.toThrow(
      'exceeds the 5MB limit'
    )
  })
})

// ── URL 模板变量展开 ──────────────────────────────────────────────────────────

describe('executeHttpRequest - URL interpolate', () => {
  it('URL 中的 {{json.id}} 展开', async () => {
    const fetchMock = mockFetch(200, '{}')
    vi.stubGlobal('fetch', fetchMock)

    const config = {
      method: 'GET' as const,
      url: 'https://example.com/users/{{json.userId}}',
      headers: [],
      body: '',
      timeoutMs: 5000,
      parseJson: false,
    }

    await executeHttpRequest(config, p({ userId: '42' }), scope)
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe('https://example.com/users/42')
  })
})
