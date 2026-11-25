import { app, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '../../shared/types'

const DEFAULT_SETTINGS: Settings = {
  githubToken: '',
  proxy: '',
  ai: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    enabled: true,
    enrich: true
  },
  wslDistro: '',
  wslWorkDir: '',
  installDir: '',
  installMode: 'manual',
  perPage: 30,
  githubFallback: true
}

let cache: Settings | null = null

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function deepMerge<T>(base: T, patch: any): T {
  if (patch === null || patch === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  const out: any = { ...base }
  for (const key of Object.keys(patch)) {
    const bv = (base as any)[key]
    const pv = patch[key]
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object') {
      out[key] = deepMerge(bv, pv)
    } else {
      out[key] = pv
    }
  }
  return out as T
}

export function loadSettings(): Settings {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf-8')
    cache = deepMerge(DEFAULT_SETTINGS, JSON.parse(raw))
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache!
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = deepMerge(loadSettings(), patch)
  cache = next
  try {
    const dir = path.dirname(settingsFile())
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.error('[settings] 写入失败', err)
  }
  return next
}

/**
 * 把用户填写的代理转成 Electron 的 proxyRules 字符串。
 * 支持：127.0.0.1:7890 / http://127.0.0.1:7890 / socks5://127.0.0.1:7891
 */
export function toProxyRules(raw: string): string {
  const v = (raw || '').trim()
  if (!v) return ''
  if (/^socks5?:\/\//i.test(v)) return v
  if (/^https?:\/\//i.test(v)) {
    const hostPort = v.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    return `http=${hostPort};https=${hostPort}`
  }
  return `http=${v};https=${v}`
}

/** 应用代理到默认 session，net.fetch 的请求都会走这里 */
export async function applyProxy(rawProxy?: string): Promise<{ ok: boolean; message: string }> {
  const rules = toProxyRules(rawProxy ?? loadSettings().proxy)
  try {
    if (!rules) {
      await session.defaultSession.setProxy({ mode: 'system' })
      return { ok: true, message: '已使用系统代理设置' }
    }
    await session.defaultSession.setProxy({ proxyRules: rules })
    // 触发一次解析，尽早暴露配置错误
    await session.defaultSession.forceReloadProxyConfig?.()
    return { ok: true, message: `代理已生效：${rules}` }
  } catch (err: any) {
    return { ok: false, message: `代理设置失败：${err?.message || err}` }
  }
}

/** 从代理设置里抽出 git 能用的 scheme + host:port */
export function gitProxyTarget(): { scheme: string; addr: string } | null {
  const rules = toProxyRules(loadSettings().proxy)
  if (!rules) return null
  // 从 rules 里抽一个可用地址
  const m = rules.match(/(?:http|https|socks5?)=\/?\/?([^;]+)/)
  const addr = m ? m[1] : rules.replace(/^socks5?:\/\//i, '')
  if (!addr) return null
  const scheme = /^socks5?:\/\//i.test(rules) ? 'socks5h' : 'http'
  return { scheme, addr }
}

/** 给 git 用的代理参数，未配置则返回空数组 */
export function gitProxyArgs(): string[] {
  const t = gitProxyTarget()
  if (!t) return []
  return ['-c', `http.proxy=${t.scheme}://${t.addr}`, '-c', `https.proxy=${t.scheme}://${t.addr}`]
}

export function userDataDir(): string {
  return app.getPath('userData')
}
