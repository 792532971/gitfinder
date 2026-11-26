import { reactive } from 'vue'

/**
 * 搜索历史
 * 只存在本机 localStorage，不上传；同一句话只留一条，重复搜索把次数 +1 并顶到最前。
 */

export interface SearchHistoryItem {
  /** 用户原话（保留原始大小写与措辞） */
  q: string
  /** 最后一次搜索时间戳 */
  at: number
  /** 搜过几次 */
  count: number
  /** 最后一次命中的仓库数 */
  total: number
}

const KEY = 'gitfinder.searchHistory'
const MAX = 20
/** 收起状态下展示几条 */
export const HISTORY_VISIBLE = 7

/** 归一化后用来判重：多余空白压掉、大小写不敏感 */
function keyOf(q: string): string {
  return q.trim().replace(/\s+/g, ' ').toLowerCase()
}

function read(): SearchHistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((i: any) => i && typeof i.q === 'string' && i.q.trim())
      .map((i: any) => ({
        q: String(i.q).trim(),
        at: Number(i.at) || 0,
        count: Math.max(1, Number(i.count) || 1),
        total: Number(i.total) || 0
      }))
      .slice(0, MAX)
  } catch {
    return []
  }
}

export const searchHistory = reactive({
  list: read() as SearchHistoryItem[],
  expanded: false
})

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(searchHistory.list))
  } catch {
    /* 配额满等情况忽略，历史只是便利功能 */
  }
}

/** 搜索成功（非报错）后记一条 */
export function recordSearch(q: string, total = 0): void {
  const text = q.trim()
  if (!text) return
  const k = keyOf(text)
  const old = searchHistory.list.find((i) => keyOf(i.q) === k)
  const rest = searchHistory.list.filter((i) => keyOf(i.q) !== k)
  searchHistory.list = [
    {
      q: text,
      at: Date.now(),
      count: (old?.count || 0) + 1,
      total: Math.max(0, total)
    },
    ...rest
  ].slice(0, MAX)
  persist()
}

export function removeSearch(q: string): void {
  const k = keyOf(q)
  searchHistory.list = searchHistory.list.filter((i) => keyOf(i.q) !== k)
  persist()
}

export function clearSearchHistory(): void {
  searchHistory.list = []
  searchHistory.expanded = false
  persist()
}

/** 最近一次搜的词，输入框为空时按 ↑ 直接带出来 */
export function lastQuery(): string {
  return searchHistory.list[0]?.q || ''
}

/** 只有一条很长的话时截断显示，完整内容放 title */
export function shortLabel(q: string): string {
  const one = q.replace(/\s+/g, ' ')
  return one.length > 26 ? `${one.slice(0, 26)}…` : one
}

export function formatHistTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return `今天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}
