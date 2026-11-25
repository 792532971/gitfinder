/**
 * 本地星标采样库。
 *
 * GitHub 没有提供「某仓库最近涨了多少星」的接口，只有 trending 页面会给 Top 25 的涨星数。
 * 为了给其它榜单也补上涨星，这里把每次抓到的 (仓库, 星标数, 时间) 落盘，
 * 之后用「现在 - 窗口内最早一次采样」算出真实差值。用得越久数据越准。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

interface RepoHistory {
  /** [时间戳, 星标数]，按时间升序 */
  pts: Array<[number, number]>
  /** 最后一次记录时间 */
  seen: number
}

type Store = Record<string, RepoHistory>

const MAX_POINTS = 96
const RETENTION_MS = 150 * 86400000
/** 同一仓库两次采样间隔小于这个值就不重复记点，避免频繁刷新把库写爆 */
const MIN_GAP_MS = 2 * 3600000
const MAX_REPOS = 4000

let store: Store | null = null
let dirty = false
let timer: NodeJS.Timeout | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'star-history.json')
}

function load(): Store {
  if (store) return store
  try {
    const raw = fs.readFileSync(file(), 'utf-8')
    const parsed = JSON.parse(raw)
    store = parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    store = {}
  }
  return store!
}

function scheduleFlush(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    flush()
  }, 2500)
  timer.unref?.()
}

export function flush(): void {
  if (!dirty || !store) return
  dirty = false
  try {
    const dir = path.dirname(file())
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(store), 'utf-8')
  } catch (err) {
    console.error('[star-history] 写入失败', err)
  }
}

function prune(now: number): void {
  if (!store) return
  const keys = Object.keys(store)
  if (keys.length <= MAX_REPOS) {
    for (const k of keys) {
      const h = store[k]
      h.pts = h.pts.filter((p) => now - p[0] <= RETENTION_MS)
      if (!h.pts.length && now - h.seen > RETENTION_MS) delete store[k]
    }
    return
  }
  // 超量时按最后出现时间淘汰最久没见的仓库
  keys
    .sort((a, b) => (store![a].seen || 0) - (store![b].seen || 0))
    .slice(0, keys.length - MAX_REPOS)
    .forEach((k) => delete store![k])
}

/** 记录一个仓库当前的星标数 */
export function record(fullName: string, stars: number, now = Date.now()): void {
  if (!fullName || !Number.isFinite(stars) || stars < 0) return
  const s = load()
  const h = s[fullName] || { pts: [], seen: 0 }
  const last = h.pts[h.pts.length - 1]
  if (!last || now - last[0] >= MIN_GAP_MS) {
    h.pts.push([now, Math.round(stars)])
    if (h.pts.length > MAX_POINTS) h.pts = h.pts.slice(-MAX_POINTS)
    dirty = true
  } else if (last[1] !== Math.round(stars)) {
    // 间隔太近但数值有变化，直接更新最后一点（保留最新值）
    last[1] = Math.round(stars)
    dirty = true
  }
  h.seen = now
  s[fullName] = h
  prune(now)
  scheduleFlush()
}

export function recordMany(items: Array<{ full_name: string; stars: number }>): void {
  const now = Date.now()
  for (const it of items) record(it.full_name, it.stars, now)
}

export interface LocalDelta {
  delta: number
  /** 实际覆盖的天数 */
  spanDays: number
}

/**
 * 用本地采样算窗口内的涨星。
 * 采样跨度不足窗口的 20%（且至少 4 小时）时返回 null，避免把几分钟的抖动当涨星。
 */
export function deltaWithin(fullName: string, windowDays: number): LocalDelta | null {
  const s = load()
  const h = s[fullName]
  if (!h || h.pts.length < 2) return null
  const now = Date.now()
  const windowMs = Math.max(windowDays, 0.05) * 86400000
  const from = now - windowMs
  const inside = h.pts.filter((p) => p[0] >= from)
  if (inside.length < 2) return null
  const oldest = inside[0]
  const latest = inside[inside.length - 1]
  if (latest[0] - oldest[0] < 2 * 3600000) return null
  const spanDays = (now - oldest[0]) / 86400000
  const needSpan = Math.min(windowMs * 0.2, 86400000)
  if (now - oldest[0] < needSpan) return null
  const delta = latest[1] - oldest[1]
  return { delta, spanDays: Math.max(spanDays, 0.01) }
}

/** 采样覆盖情况，用于界面上提示「本地数据还太少」 */
export function coverage(): { repos: number; points: number } {
  const s = load()
  let points = 0
  for (const k of Object.keys(s)) points += s[k].pts.length
  return { repos: Object.keys(s).length, points }
}
