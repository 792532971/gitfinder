import { net } from 'electron'
import { loadSettings } from './settings'

export class HttpError extends Error {
  status: number
  hint: string
  body: string
  constructor(message: string, status = 0, body = '', hint = '') {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.hint = hint
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

function baseHeaders(): Record<string, string> {
  const { githubToken } = loadSettings()
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (githubToken && githubToken.trim()) {
    h.Authorization = `Bearer ${githubToken.trim()}`
  }
  return h
}

/** 所有出网请求统一入口：走 Electron net（自动套用 session 代理） */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const timeout = opts.timeoutMs ?? 20000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await net.fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
      redirect: 'follow'
    })
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new HttpError(`请求超时（${timeout}ms）：${url}`, 0, '', '检查网络或代理设置')
    }
    throw new HttpError(
      `网络请求失败：${err?.message || err}`,
      0,
      '',
      '如果开启了代理，请到设置里确认代理端口是否正确'
    )
  } finally {
    clearTimeout(timer)
  }
}

async function toError(res: Response): Promise<HttpError> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* ignore */
  }
  let msg = `HTTP ${res.status}`
  let hint = ''
  if (res.status === 401) {
    hint = 'Token 无效或已过期，请到设置里更换 GitHub Personal Access Token'
  } else if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000
      const when = reset ? new Date(reset).toLocaleTimeString() : '稍后'
      hint = `触发 GitHub 速率限制（未登录 10 次/分钟，登录后 30 次/分钟）。重置时间：${when}`
    } else {
      hint = '可能触发了 GitHub 限流或权限不足，建议配置 Token'
    }
    msg = `HTTP 403 访问受限`
  } else if (res.status === 404) {
    hint = '资源不存在，可能是仓库已删除或私有'
  } else if (res.status >= 500) {
    hint = 'GitHub 服务端异常，请稍后重试'
  }
  try {
    const j = JSON.parse(body)
    if (j?.message) msg += `：${j.message}`
  } catch {
    if (body) msg += `：${body.slice(0, 200)}`
  }
  return new HttpError(msg, res.status, body, hint)
}

/** GitHub API 请求，返回 JSON */
export async function ghJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, {
    ...opts,
    headers: { ...baseHeaders(), ...(opts.headers || {}) }
  })
  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}

/** GitHub API 请求，返回纯文本（用于 README 等） */
export async function ghText(url: string, accept = 'application/vnd.github.raw'): Promise<string> {
  const res = await request(url, {
    headers: { ...baseHeaders(), Accept: accept }
  })
  if (!res.ok) throw await toError(res)
  return await res.text()
}

/** 通用 JSON POST（AI 接口用） */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 60000
): Promise<T> {
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    timeoutMs
  })
  if (!res.ok) throw await toError(res)
  return (await res.json()) as T
}

/** 探测一个 URL 是否存在（HEAD） */
export async function exists(url: string): Promise<boolean> {
  try {
    const res = await request(url, { method: 'GET', timeoutMs: 12000 })
    return res.ok
  } catch {
    return false
  }
}
