/**
 * 榜单抓取。
 *
 * - trending 榜：抓 https://github.com/trending 页面，解析出 GitHub 官方的「今日/本周/本月 +N stars」
 * - search 榜：GitHub Search API，用 stars:/created:/pushed:/topic: 等限定词组合
 * - tracked 榜：拉关注仓库最新数据，用本地星标采样算真实涨星
 *
 * 所有结果带磁盘缓存，避免切榜单时把 GitHub 的速率配额打光。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { request, ghJson, HttpError } from '../lib/http'
import { loadSettings } from '../lib/settings'
import {
  BOARD_MAP,
  resolveQuery,
  languageSlug
} from '../../shared/boards'
import type { BoardDef } from '../../shared/boards'
import type { BoardItem, BoardQuery, BoardResult, RepoItem } from '../../shared/types'
import { mapRepo } from './github'
import * as history from '../lib/starhistory'
import * as tracked from '../lib/tracked'
import * as profile from '../lib/profile'

const API = 'https://api.github.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// ---------------------------------------------------------------- 缓存

interface CacheEntry {
  at: number
  result: BoardResult
}

const mem = new Map<string, CacheEntry>()
let disk: Record<string, CacheEntry> | null = null
let diskTimer: NodeJS.Timeout | null = null
let diskDirty = false

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'board-cache.json')
}

function loadDisk(): Record<string, CacheEntry> {
  if (disk) return disk
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'))
    const now = Date.now()
    const out: Record<string, CacheEntry> = {}
    for (const [k, v] of Object.entries(raw || {})) {
      const e = v as CacheEntry
      // 超过 3 天的缓存没意义，直接丢
      if (e?.at && now - e.at < 3 * 86400000) out[k] = e
    }
    disk = out
  } catch {
    disk = {}
  }
  return disk!
}

function persistDisk(): void {
  if (!diskDirty || !disk) return
  diskDirty = false
  try {
    const dir = path.dirname(cacheFile())
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify(disk), 'utf-8')
  } catch (err) {
    console.error('[board] 缓存写入失败', err)
  }
}

function schedulePersist(): void {
  diskDirty = true
  if (diskTimer) return
  diskTimer = setTimeout(() => {
    diskTimer = null
    persistDisk()
  }, 1500)
  diskTimer.unref?.()
}

function ttlMs(def: BoardDef): number {
  return (def.ttl ?? 60) * 60000
}

function cacheKey(def: BoardDef, language: string): string {
  const lang = def.followLanguage ? language : ''
  return `${def.id}|${lang}`
}

function readCache(def: BoardDef, language: string): BoardResult | null {
  const key = cacheKey(def, language)
  const now = Date.now()
  const hit = mem.get(key)
  if (hit && now - hit.at < ttlMs(def)) return { ...hit.result, cached: true }
  const d = loadDisk()[key]
  if (d && now - d.at < ttlMs(def)) {
    mem.set(key, d)
    return { ...d.result, cached: true }
  }
  return null
}

function writeCache(def: BoardDef, language: string, result: BoardResult): void {
  const key = cacheKey(def, language)
  const entry: CacheEntry = { at: result.fetchedAt, result: { ...result, cached: false } }
  mem.set(key, entry)
  const d = loadDisk()
  d[key] = entry
  // 榜单 × 语言的组合可能很多，控制在 120 条以内，超了按时间淘汰
  const keys = Object.keys(d)
  if (keys.length > 120) {
    keys
      .sort((a, b) => (d[a]?.at || 0) - (d[b]?.at || 0))
      .slice(0, keys.length - 120)
      .forEach((k) => {
        if (k !== key) delete d[k]
      })
  }
  schedulePersist()
}

export function clearCache(): number {
  const n = mem.size + Object.keys(loadDisk()).length
  mem.clear()
  disk = {}
  try {
    fs.rmSync(cacheFile(), { force: true })
  } catch {
    /* ignore */
  }
  return n
}

// ---------------------------------------------------------------- 工具

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function decodeEntities(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
}

function toNum(s: string | undefined): number {
  if (!s) return 0
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

async function mapLimit<T, R>(
  arr: T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(arr.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (idx < arr.length) {
      const i = idx++
      out[i] = await fn(arr[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

function apiHeaders(): Record<string, string> {
  const token = loadSettings().githubToken?.trim()
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GitFinder'
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function raiseForStatus(res: Response, url: string): Promise<never> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* ignore */
  }
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000
  let hint = ''
  if (res.status === 403 || res.status === 429) {
    hint =
      remaining === '0'
        ? `触发 GitHub 速率限制，${reset ? new Date(reset).toLocaleTimeString() : '稍后'} 后重置。建议在设置里配置 Token 提升配额`
        : '可能触发风控或权限不足，建议配置 GitHub Token'
  } else if (res.status === 422) {
    hint = '查询语法被 GitHub 拒绝，可以换个榜单试试'
  } else if (res.status === 401) {
    hint = 'GitHub Token 无效，请到设置里更新'
  } else if (res.status === 404) {
    hint = '资源不存在'
  } else if (res.status >= 500) {
    hint = 'GitHub 服务端异常，稍后重试'
  }
  throw new HttpError(`榜单请求失败 HTTP ${res.status}`, res.status, body.slice(0, 300), hint)
}

// ---------------------------------------------------------------- trending 解析

const WINDOW_LABEL: Record<string, string> = {
  daily: '今日',
  weekly: '本周',
  monthly: '本月'
}

function parseTrending(html: string, since: string): BoardItem[] {
  const chunks = html.split(/<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>/i).slice(1)
  const items: BoardItem[] = []
  const windowDays = since === 'daily' ? 1 : since === 'weekly' ? 7 : 30

  for (const chunk of chunks) {
    const h2 = chunk.match(/<h2[\s\S]*?<\/h2>/i)
    if (!h2) continue
    const link = h2[0].match(/href="\/([^/"?#]+)\/([^/"?#]+)"/)
    if (!link) continue
    const owner = link[1]
    const name = link[2]
    const fullName = `${owner}/${name}`

    const descMatch = chunk.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/i)
    const langMatch = chunk.match(/itemprop="programmingLanguage"[^>]*>([^<]+)</i)
    const starsMatch = chunk.match(
      /href="[^"]*\/stargazers"[\s\S]{0,1600}?<\/svg>\s*([\d,]+)\s*<\/a>/i
    )
    const forksMatch = chunk.match(/href="[^"]*\/forks"[\s\S]{0,1600}?<\/svg>\s*([\d,]+)\s*<\/a>/i)
    const deltaMatch = chunk.match(/([\d,]+)\s+stars?\s+(today|this week|this month)/i)

    const stars = toNum(starsMatch?.[1])
    if (!stars) continue

    items.push({
      id: hash(fullName),
      full_name: fullName,
      owner,
      name,
      html_url: `https://github.com/${fullName}`,
      description: descMatch ? decodeEntities(descMatch[1]) : '',
      language: langMatch ? decodeEntities(langMatch[1]) : '',
      stars,
      forks: toNum(forksMatch?.[1]),
      open_issues: 0,
      updated_at: '',
      pushed_at: '',
      created_at: '',
      topics: [],
      license: '',
      archived: false,
      default_branch: 'main',
      homepage: '',
      rank: items.length + 1,
      starDelta: deltaMatch ? toNum(deltaMatch[1]) : undefined,
      deltaSource: deltaMatch ? 'github' : undefined,
      deltaWindow: windowDays
    })
  }
  return items
}

async function fetchTrending(def: BoardDef, language: string): Promise<BoardResult> {
  let url = 'https://github.com/trending'
  const lang = def.followLanguage ? language : 'any'
  if (lang && lang !== 'any') url += `/${encodeURIComponent(languageSlug(lang))}`
  const params = new URLSearchParams()
  if (def.since) params.set('since', def.since)
  if (def.spoken) params.set('spoken_language_code', def.spoken)
  if ([...params.keys()].length) url += `?${params.toString()}`

  const res = await request(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      'User-Agent': UA,
      'Cache-Control': 'no-cache'
    },
    timeoutMs: 25000
  })
  if (!res.ok) await raiseForStatus(res, url)
  const html = await res.text()
  const items = parseTrending(html, def.since || 'daily')
  if (!items.length) {
    throw new HttpError(
      'GitHub Trending 页面结构异常',
      0,
      html.slice(0, 200),
      '可能是网络被劫持或 GitHub 改版；配置代理后重试'
    )
  }
  history.recordMany(items)
  return {
    boardId: def.id,
    items,
    fetchedAt: Date.now(),
    cached: false,
    source: 'github-trending',
    note: `涨星数为 GitHub 官方统计（${WINDOW_LABEL[def.since || 'daily']}）`,
    rawQuery: url,
    rateRemaining: null
  }
}

// ---------------------------------------------------------------- search 榜

async function fetchSearch(def: BoardDef, language: string): Promise<BoardResult> {
  const parts: string[] = []
  if (def.q) parts.push(resolveQuery(def.q))
  const lang = def.followLanguage ? language : 'any'
  if (lang && lang !== 'any') parts.push(`language:${lang}`)
  const q = parts.join(' ').trim()
  if (!q) throw new Error('榜单查询为空')

  const url = new URL(`${API}/search/repositories`)
  url.searchParams.set('q', q)
  url.searchParams.set('sort', def.sort || 'stars')
  url.searchParams.set('order', 'desc')
  url.searchParams.set('per_page', '40')

  const res = await request(url.toString(), { headers: apiHeaders(), timeoutMs: 25000 })
  if (!res.ok) await raiseForStatus(res, url.toString())
  const data: any = await res.json()
  const items: BoardItem[] = (data.items || []).map((raw: any, i: number) => {
    const base: RepoItem = mapRepo(raw)
    const created = base.created_at ? new Date(base.created_at).getTime() : 0
    const ageDays = created ? Math.max(1, Math.round((Date.now() - created) / 86400000)) : undefined
    return { ...base, rank: i + 1, ageDays }
  })
  history.recordMany(items)
  const note =
    def.note ||
    `GitHub 搜索快照：${q}${def.sort === 'updated' ? '（按最近推送排序）' : ''}`
  return {
    boardId: def.id,
    items,
    fetchedAt: Date.now(),
    cached: false,
    source: 'github-search',
    note,
    rawQuery: q,
    rateRemaining: Number(res.headers.get('x-ratelimit-remaining') ?? '') || null
  }
}

// ---------------------------------------------------------------- tracked 榜

/**
 * 取单个仓库详情。
 * `/repos/{owner}/{name}` 走 core 配额（未登录 60 次/小时），很容易被用光；
 * 一旦 403 就退到搜索接口的 `repo:` 限定（搜索配额是独立的、按分钟重置），
 * 这样追踪榜在未登录状态下也不至于彻底不可用。
 */
async function repoDetail(name: string): Promise<any | null> {
  try {
    return await ghJson<any>(`${API}/repos/${name}`, { timeoutMs: 20000 })
  } catch (err: any) {
    if (err?.status !== 403 && err?.status !== 429) throw err
    // 设置里可以关掉降级：有些人宁可看到真实报错，也不想让搜索配额被悄悄消耗
    if (loadSettings().githubFallback === false) {
      err.hint =
        'core 接口配额用尽，且设置里关闭了「配额不足时改用搜索接口」。填一个 GitHub Token，或重新打开这个开关'
      throw err
    }
    const url = new URL(`${API}/search/repositories`)
    url.searchParams.set('q', `repo:${name}`)
    url.searchParams.set('per_page', '1')
    const res = await request(url.toString(), { headers: apiHeaders(), timeoutMs: 20000 })
    if (!res.ok) throw err
    const data: any = await res.json()
    return Array.isArray(data.items) && data.items.length ? data.items[0] : null
  }
}

async function fetchTracked(def: BoardDef): Promise<BoardResult> {
  const names = tracked.list()
  if (!names.length) {
    return {
      boardId: def.id,
      items: [],
      fetchedAt: Date.now(),
      cached: false,
      source: 'local',
      note: def.note || '还没有关注任何仓库',
      rawQuery: '',
      rateRemaining: null
    }
  }

  let firstError: any = null
  let forbidden = 0
  const raw = await mapLimit(names, 3, async (n) => {
    try {
      return await repoDetail(n)
    } catch (err: any) {
      if (!firstError) firstError = err
      if (err?.status === 403 || err?.status === 429) forbidden++
      return null
    }
  })

  const items: BoardItem[] = []
  for (const r of raw) {
    if (!r) continue
    const base = mapRepo(r)
    const created = base.created_at ? new Date(base.created_at).getTime() : 0
    items.push({
      ...base,
      rank: 0,
      ageDays: created ? Math.max(1, Math.round((Date.now() - created) / 86400000)) : undefined
    })
  }

  const failed = names.length - items.length
  // 全部失败时不要假装「没有关注」，把真实原因抛出去
  if (!items.length) {
    const hint = forbidden
      ? 'GitHub 仓库接口的未登录配额是每小时 60 次，追踪榜每个仓库要占 1 次。到设置里填一个 GitHub Token 可以提到 5000 次/小时'
      : firstError?.hint || '检查网络或代理设置后重试'
    console.log('[board] 追踪榜全部失败:', firstError?.message)
    throw new HttpError(
      `关注的 ${names.length} 个仓库都没能取到数据`,
      Number(firstError?.status) || 0,
      '',
      hint
    )
  }

  history.recordMany(items)
  return {
    boardId: def.id,
    items,
    fetchedAt: Date.now(),
    cached: false,
    source: 'local',
    note: failed
      ? `${failed} 个仓库拉取失败（可能已删除、私有，或接口配额用尽）`
      : def.note || '涨星由本机历史采样计算，采样越久越准',
    rawQuery: '',
    rateRemaining: null
  }
}

// ---------------------------------------------------------------- 统一后处理

/** 给搜索类榜单补上本地采样涨星、派生指标与名次 */
function enrich(def: BoardDef, items: BoardItem[]): BoardItem[] {
  const windowDays = def.windowDays ?? 7
  const out = items.map((it) => {
    const next: BoardItem = { ...it }
    if (!next.starDelta) {
      const local = history.deltaWithin(next.full_name, windowDays)
      if (local && local.delta !== 0) {
        next.starDelta = local.delta
        next.deltaSource = 'local'
        next.deltaWindow = Math.max(1, Math.round(local.spanDays))
      }
    }
    if (def.clientSort === 'starPerDay' && next.ageDays) {
      const perDay = next.stars / next.ageDays
      next.extra = `≈ +${perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1)} 星/天`
    }
    return next
  })

  if (def.clientSort === 'starPerDay') {
    out.sort((a, b) => {
      const pa = a.ageDays ? a.stars / a.ageDays : 0
      const pb = b.ageDays ? b.stars / b.ageDays : 0
      return pb - pa
    })
  } else if (def.kind === 'tracked') {
    out.sort((a, b) => {
      const da = a.starDelta ?? -1
      const db = b.starDelta ?? -1
      if (db !== da) return db - da
      return b.stars - a.stars
    })
  }

  return out.map((it, i) => ({ ...it, rank: i + 1 }))
}

// ---------------------------------------------------------------- 对外接口

export async function fetchBoard(query: BoardQuery): Promise<BoardResult> {
  const def = BOARD_MAP[query.boardId]
  if (!def) throw new Error(`未知榜单：${query.boardId}`)
  const language = (query.language || 'any').toLowerCase()

  if (!query.refresh) {
    const hit = readCache(def, language)
    if (hit) {
      // 缓存里也顺手补一次本地涨星（历史采样可能已经更新）与最新画像
      const items = profile.attach(enrich(def, hit.items))
      return { ...hit, items }
    }
  }

  let result: BoardResult
  if (def.kind === 'trending') {
    result = await fetchTrending(def, language)
  } else if (def.kind === 'search') {
    result = await fetchSearch(def, language)
  } else {
    result = await fetchTracked(def)
  }

  result.items = profile.attach(enrich(def, result.items))
  writeCache(def, language, result)
  return result
}

export function trackedList(): string[] {
  return tracked.list()
}

export function toggleTrack(fullName: string, stars?: number): string[] {
  const next = tracked.toggle(fullName)
  // 关注时就记一个采样点，让涨星从「加入那一刻」开始算
  if (next.includes(fullName) && Number.isFinite(Number(stars))) {
    history.record(fullName, Number(stars))
  }
  // 关注变化后让追踪榜缓存失效（内存 + 磁盘）
  for (const k of [...mem.keys()]) if (k.startsWith('m-tracked')) mem.delete(k)
  const d = loadDisk()
  let changed = false
  for (const k of Object.keys(d)) {
    if (k.startsWith('m-tracked')) {
      delete d[k]
      changed = true
    }
  }
  if (changed) schedulePersist()
  return next
}
