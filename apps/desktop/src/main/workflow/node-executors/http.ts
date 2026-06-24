/**
 * HTTP 请求节点执行器（U11）。
 *
 * http-request 节点：
 *   - 支持 GET / POST / PUT / PATCH / DELETE
 *   - url / headers.value / body 均经 interpolate 展开模板变量
 *   - 使用全局 fetch + AbortSignal.timeout（或手动 AbortController）实现超时
 *   - 响应体限制 5MB（超出抛 Error，对齐 Kun HTTP_MAX_RESPONSE_BYTES）
 *   - parseJson=false → { status, body }；parseJson=true → 尝试 JSON.parse，失败 fallback
 *   - HTTP 4xx/5xx → 抛 Error（图引擎 onError 处理）
 *   - 仅允许 http / https 协议
 */

import type { WorkflowHttpRequestConfig } from '../types.js'
import type { WorkflowPayload, InterpScope } from '../runtime/interp.js'
import { interpolate } from '../runtime/interp.js'
import type { NodeOutcome } from './index.js'

// 响应体上限 5 MB（与 Kun HTTP_MAX_RESPONSE_BYTES 对齐）
const HTTP_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/**
 * 读取响应体，超过 limit 字节时抛 Error。
 * 使用 ReadableStream reader 逐块累积，避免一次性将大响应体载入内存后再截断。
 */
async function readBodyCapped(response: Response, limit: number): Promise<string> {
  const body = response.body
  if (!body) return response.text()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      size += value.length
      if (size > limit) {
        await reader.cancel()
        throw new Error('Response body exceeds the 5MB limit.')
      }
      chunks.push(value)
    }
  }

  // 合并所有块为 UTF-8 字符串
  const total = chunks.reduce((acc, c) => acc + c.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder('utf-8').decode(merged)
}

/**
 * http-request 节点执行器。
 *
 * 实现细节：
 *   - 使用 AbortController + setTimeout 实现超时（而非 AbortSignal.timeout，
 *     因为 AbortSignal.timeout 在 Electron 主进程部分版本不可用）
 *   - GET / DELETE 不发送 body（即使配置了 body 字段也忽略，对齐 HTTP 规范）
 *   - headers 上限 50 条（normalize 已截断，此处直接遍历）
 *   - HTTP 错误（4xx/5xx）抛 Error，由 graph-executor onError 处理
 *   - parseJson 失败时 fallback 为 { status, body }（对齐 Kun：不中断流程）
 */
export async function executeHttpRequest(
  config: WorkflowHttpRequestConfig,
  payload: WorkflowPayload,
  scope: InterpScope
): Promise<NodeOutcome> {
  // 展开 URL 中的模板变量
  const url = interpolate(config.url, payload, scope).trim()

  // 校验 URL 合法性和协议
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url || '(empty)'}`)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed.')
  }

  // 展开 headers
  const headers: Record<string, string> = {}
  for (const header of config.headers) {
    const key = header.key.trim()
    if (key) headers[key] = interpolate(header.value, payload, scope)
  }

  // 超时控制（AbortController）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const init: RequestInit = {
      method: config.method,
      headers,
      signal: controller.signal,
    }

    // GET / DELETE 不发 body（对齐 HTTP 规范，Kun 同此判断）
    if (
      config.method !== 'GET' &&
      config.method !== 'DELETE' &&
      config.body.trim()
    ) {
      init.body = interpolate(config.body, payload, scope)
    }

    const response = await fetch(url, init)
    const raw = await readBodyCapped(response, HTTP_MAX_RESPONSE_BYTES)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`)
    }

    // parseJson=false → 固定结构 { status, body }
    // parseJson=true  → 尝试解析，失败 fallback 同 false（不抛错）
    let json: unknown = { status: response.status, body: raw }
    if (config.parseJson) {
      try {
        json = JSON.parse(raw)
      } catch {
        // parseJson=true 但响应非 JSON：fallback 为默认结构，不中断流程
        json = { status: response.status, body: raw }
      }
    }

    return {
      payload: { json, text: raw },
      message: `${response.status} ${response.statusText}`.trim(),
    }
  } catch (error) {
    // AbortError → 超时
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${config.timeoutMs}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
