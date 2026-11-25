import { reactive } from 'vue'
import type { Settings, RepoItem, AiPolishResult } from '../../shared/types'
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

  toasts: [] as Toast[]
})

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
