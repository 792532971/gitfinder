export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n < 1000) return String(n)
  if (n < 1000000) {
    const v = n / 1000
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}k`
  }
  const v = n / 1000000
  return `${v.toFixed(1).replace(/\.0$/, '')}M`
}

/** 涨星这类需要精确感的数字：一万以内不缩写 */
export function formatDelta(n: number): string {
  const abs = Math.abs(n)
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  if (abs < 10000) return `${sign}${abs.toLocaleString('en-US')}`
  return `${sign}${formatNumber(abs)}`
}

export function timeAgo(iso: string): string {
  if (!iso) return '未知'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '未知'
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export interface LanguageOption {
  value: string
  label: string
}

export const LANGUAGES: LanguageOption[] = [
  { value: 'any', label: '不限语言' },
  { value: 'python', label: 'Python' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'rust', label: 'Rust' },
  { value: 'go', label: 'Go' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'cpp', label: 'C++' },
  { value: 'c', label: 'C' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'shell', label: 'Shell' },
  { value: 'vue', label: 'Vue' },
  { value: 'html', label: 'HTML' },
  { value: 'jupyter notebook', label: 'Jupyter' }
]

export const SORT_OPTIONS = [
  { value: 'best-match', label: '最佳匹配' },
  { value: 'stars', label: '星标最多' },
  { value: 'forks', label: 'Fork 最多' },
  { value: 'updated', label: '最近更新' }
]

/** GitHub 语言色 */
const LANG_COLORS: Record<string, string> = {
  Python: '#3572A5',
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  'C#': '#178600',
  'C++': '#f34b7d',
  C: '#555555',
  PHP: '#4F5D95',
  Ruby: '#701516',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Shell: '#89e051',
  Vue: '#41b883',
  HTML: '#e34c26',
  'Jupyter Notebook': '#DA5B0B'
}

export function langColor(lang: string): string {
  return LANG_COLORS[lang] || '#8b949e'
}
