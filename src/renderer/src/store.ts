import { reactive } from 'vue'
import type {
  Settings,
  RepoItem,
  AiPolishResult,
  ProfileInput,
  ProfileUpdateEvent
} from '../../shared/types'
import { toCloneable } from './cloneable'

export interface Toast {
  id: number
  text: string
  type: 'info' | 'ok' | 'warn' | 'error'
}

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

let toastSeq = 0

export const state = reactive({
  ready: false,
  settings: { ...DEFAULT_SETTINGS } as Settings,

  // 搜索条件
  query: '',
  effectiveQuery: '',
  aiEnabled: true,
  language: 'any',
  sort: 'best-match' as 'stars' | 'forks' | 'updated' | 'best-match',
  perPage: 30,

  // 结果
  searching: false,
  polishing: false,
  results: [] as RepoItem[],
  total: 0,
  page: 1,
  rawQuery: '',
  aiResult: null as AiPolishResult | null,
  error: '',
  rateRemaining: null as number | null,
  rateReset: null as number | null,
  searched: false,

  /** 结果里显示中文简介（关闭后只看英文原文，也不再花 token） */
  zhDesc: localStorage.getItem('gitfinder.zhDesc') !== '0',

  toasts: [] as Toast[]
})

/** 搜索结果的简介翻译进度 */
export const searchZh = reactive({
  running: false,
  finished: 0,
  total: 0,
  error: ''
})

export const SEARCH_SCOPE = 'search'

export function toast(text: string, type: Toast['type'] = 'info', ms = 3600): void {
  const id = ++toastSeq
  state.toasts.push({ id, text, type })
  setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === id)
    if (i >= 0) state.toasts.splice(i, 1)
  }, ms)
}

export async function loadSettings(): Promise<void> {
  try {
    state.settings = await window.api.settings.get()
    state.aiEnabled = state.settings.ai.enabled
    state.perPage = state.settings.perPage || 30
  } catch (err: any) {
    toast(`读取配置失败：${err.message}`, 'error')
  } finally {
    state.ready = true
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  // patch 一般来自 ref/reactive，是 Proxy；跨 contextBridge 传参会抛
  // "An object could not be cloned."，所以先剥一层再发
  state.settings = await window.api.settings.save(toCloneable(patch))
  state.aiEnabled = state.settings.ai.enabled
}

export async function runSearch(opts: { useAi?: boolean; page?: number } = {}): Promise<void> {
  const raw = state.query.trim()
  if (!raw) {
    toast('先描述一下你要找什么项目', 'warn')
    return
  }
  const page = opts.page ?? 1
  state.page = page
  state.error = ''
  state.searched = true

  let q = raw
  if (opts.useAi) {
    state.polishing = true
    try {
      const r = await window.api.ai.polish(raw)
      state.aiResult = r
      q = r.query
      if (r.language) state.language = r.language
      if (r.sort !== 'best-match') state.sort = r.sort
    } catch (err: any) {
      state.aiResult = null
      toast(`AI 润色失败，改用原文搜索：${err.message}`, 'warn', 5000)
    } finally {
      state.polishing = false
    }
  } else {
    state.aiResult = null
  }

  state.effectiveQuery = q
  await fetchResults()
}

export async function fetchResults(): Promise<void> {
  const q = state.effectiveQuery || state.query
  if (!q.trim()) return
  state.searching = true
  state.error = ''
  try {
    const res = await window.api.github.search({
      q,
      language: state.language,
      sort: state.sort,
      order: 'desc',
      perPage: state.perPage,
      page: state.page
    })
    state.results = res.items
    state.total = res.total
    state.rawQuery = res.rawQuery
    state.rateRemaining = res.rateRemaining
    state.rateReset = res.rateReset
    // 结果换了，中文简介重新排队（命中的缓存会由主进程直接挂上）
    searchZh.finished = 0
    searchZh.total = 0
    searchZh.error = ''
    void enrichSearchResults()
  } catch (err: any) {
    state.error = err?.message || String(err)
    state.results = []
    state.total = 0
  } finally {
    state.searching = false
  }
}

export async function changePage(delta: number): Promise<void> {
  const next = state.page + delta
  if (next < 1) return
  if (next > 34) return
  state.page = next
  await fetchResults()
}

export async function applyFilter(): Promise<void> {
  if (!state.searched) return
  state.page = 1
  await fetchResults()
}

/* ------------------------------------------------------------------
 * 搜索结果的中文简介
 * 复用榜单那套画像管线：同一份提示词、同一份缓存，搜到的仓库和榜上的是同一批，
 * 所以「榜里已经译过的」在搜索页能直接命中，不再花 token。
 * ---------------------------------------------------------------- */

/** AI 可用且允许批量生成（设置里关掉 enrich 就不自动跑） */
export function aiProfileReady(): boolean {
  return !!state.settings.ai.apiKey && state.settings.ai.enrich !== false
}

/**
 * 只发 AI 需要的最小字段。
 * 必须过 toCloneable：items 来自 reactive，topics 是 Proxy，
 * 直接跨 contextBridge 会抛 "An object could not be cloned."。
 */
function toInputs(list: RepoItem[]): ProfileInput[] {
  return toCloneable(
    list.map((i) => ({
      full_name: i.full_name,
      description: i.description || '',
      language: i.language || '',
      topics: [...(i.topics || [])],
      stars: i.stars || 0,
      archived: !!i.archived,
      pushed_at: i.pushed_at || ''
    }))
  )
}

/** 给当前页的结果批量补中文简介；已全部命中缓存时直接返回 */
export async function enrichSearchResults(force = false): Promise<void> {
  const list = state.results
  if (!list.length || !state.zhDesc || !aiProfileReady()) {
    searchZh.running = false
    return
  }
  if (!force && !list.some((i) => i.profile?.source !== 'ai')) {
    searchZh.running = false
    return
  }
  searchZh.error = ''
  searchZh.running = true
  try {
    const r = await window.api.board.enrich({
      items: toInputs(list),
      scope: SEARCH_SCOPE,
      force
    })
    searchZh.total = Math.max(searchZh.total, r.pending)
    if (r.pending === 0) searchZh.running = false
  } catch (err: any) {
    searchZh.error = err?.message || String(err)
    searchZh.running = false
  }
}

/** 单条翻译（卡片上点「译成中文」），不重跑整页 */
export async function translateSearchOne(repo: RepoItem): Promise<void> {
  if (!aiProfileReady()) {
    toast('翻译成中文需要先配置 AI', 'warn', 4000)
    return
  }
  searchZh.error = ''
  try {
    const r = await window.api.board.enrich({
      items: toInputs([repo]),
      scope: SEARCH_SCOPE,
      force: false
    })
    if (r.pending > 0) {
      searchZh.running = true
      searchZh.total = Math.max(searchZh.total, 1)
      searchZh.finished = 0
      toast('正在译成中文…', 'ok', 2400)
    } else {
      // pending=0：要么已经在队列里，要么缓存里就有（但卡片没显示说明是前者）
      toast('这条已经在翻译队列里，稍等几秒', 'info', 2600)
    }
  } catch (err: any) {
    toast(`翻译失败：${err?.message || err}`, 'error')
  }
}

/** 主进程分批回传，按 full_name 并进当前结果 */
export function applySearchProfiles(e: ProfileUpdateEvent): void {
  if (e.scope !== SEARCH_SCOPE) return
  let hit = false
  const next = state.results.map((it) => {
    const p = e.profiles[it.full_name]
    if (!p) return it
    hit = true
    return { ...it, profile: p }
  })
  if (hit) state.results = next
  searchZh.finished = e.finished
  if (e.total) searchZh.total = e.total
  if (e.error) searchZh.error = e.error
  if (e.done) searchZh.running = false
}

/** 工具栏开关：关掉后不再请求，界面回到英文原文 */
export function setZhDesc(on: boolean): void {
  state.zhDesc = on
  localStorage.setItem('gitfinder.zhDesc', on ? '1' : '0')
  if (on) void enrichSearchResults()
  else searchZh.running = false
}
