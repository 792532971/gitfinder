/**
 * 榜单注册表 —— 主进程与渲染层共用。
 *
 * 榜单分三类数据来源：
 *  1. trending：抓 GitHub 官方 trending 页面，带「今日/本周/本月 +N stars」真实涨星数
 *  2. search：GitHub Search API，用限定词组合出各类榜单（总星、新星、活跃、领域…）
 *  3. tracked：本地关注列表，用本机采样到的星标历史算真实涨星
 */

export type BoardGroupId = 'velocity' | 'stars' | 'fresh' | 'active' | 'niche' | 'mine'

export interface BoardGroup {
  id: BoardGroupId
  name: string
  desc: string
}

export const BOARD_GROUPS: BoardGroup[] = [
  { id: 'velocity', name: '涨星速度', desc: '单位时间内新增星标最多' },
  { id: 'stars', name: '累计高星', desc: '历史沉淀下来的头部项目' },
  { id: 'fresh', name: '新星崛起', desc: '新创建、涨得快、还没被大众发现' },
  { id: 'active', name: '活跃维护', desc: '最近仍在提交代码' },
  { id: 'niche', name: '领域精选', desc: '按主题圈出的垂直榜单' },
  { id: 'mine', name: '我的榜', desc: '基于本地采样的自选追踪' }
]

export type BoardKind = 'trending' | 'search' | 'tracked'

export type SearchSort = 'stars' | 'forks' | 'updated' | 'help-wanted-issues'

export interface BoardDef {
  id: string
  name: string
  desc: string
  group: BoardGroupId
  kind: BoardKind
  /** trending 榜的时间窗口 */
  since?: 'daily' | 'weekly' | 'monthly'
  /** trending 榜的语言圈（zh = 中文项目） */
  spoken?: string
  /** search 榜的查询模板，支持 {D7}/{D30}/{D365} 这类「N 天前」占位符 */
  q?: string
  sort?: SearchSort
  /** 是否跟随界面上的语言筛选 */
  followLanguage?: boolean
  /** 取回后在前端按派生指标重排 */
  clientSort?: 'starPerDay'
  /** 本地采样涨星的时间窗口（天），用于补算 GitHub 未提供的涨星 */
  windowDays?: number
  /** 缓存有效期（分钟） */
  ttl?: number
  /** 数据口径说明，展示在榜单头部 */
  note?: string
}

export const BOARDS: BoardDef[] = [
  // ---------- 涨星速度（GitHub 官方口径） ----------
  {
    id: 'v-daily',
    name: '今日涨星榜',
    desc: '过去 24 小时新增星标最多的项目',
    group: 'velocity',
    kind: 'trending',
    since: 'daily',
    followLanguage: true,
    windowDays: 1,
    ttl: 15,
    note: '涨星数为 GitHub Trending 官方统计，非估算'
  },
  {
    id: 'v-weekly',
    name: '本周涨星榜',
    desc: '最近一周新增星标最多的项目',
    group: 'velocity',
    kind: 'trending',
    since: 'weekly',
    followLanguage: true,
    windowDays: 7,
    ttl: 60
  },
  {
    id: 'v-monthly',
    name: '本月涨星榜',
    desc: '最近一个月新增星标最多的项目',
    group: 'velocity',
    kind: 'trending',
    since: 'monthly',
    followLanguage: true,
    windowDays: 30,
    ttl: 180
  },
  {
    id: 'v-zh-daily',
    name: '中文项目今日涨星',
    desc: '中文技术圈今日最热的项目',
    group: 'velocity',
    kind: 'trending',
    since: 'daily',
    spoken: 'zh',
    windowDays: 1,
    ttl: 20
  },
  {
    id: 'v-zh-weekly',
    name: '中文项目本周涨星',
    desc: '中文技术圈一周内涨星最多的项目',
    group: 'velocity',
    kind: 'trending',
    since: 'weekly',
    spoken: 'zh',
    windowDays: 7,
    ttl: 90
  },

  // ---------- 累计高星 ----------
  {
    id: 's-all',
    name: '历史总星榜',
    desc: '有史以来星标最多的仓库',
    group: 'stars',
    kind: 'search',
    q: 'stars:>10000',
    sort: 'stars',
    ttl: 120
  },
  {
    id: 's-lang',
    name: '语言总星榜',
    desc: '某个语言里星标最多的项目，切换语言看各生态头部',
    group: 'stars',
    kind: 'search',
    q: 'stars:>3000',
    sort: 'stars',
    followLanguage: true,
    ttl: 120
  },
  {
    id: 's-fork',
    name: 'Fork 总榜',
    desc: '被 fork 最多的项目，通常是模板、教程和基础设施',
    group: 'stars',
    kind: 'search',
    q: 'forks:>2000',
    sort: 'forks',
    ttl: 120
  },
  {
    id: 's-help',
    name: '最缺人手榜',
    desc: '挂着最多 help-wanted 议题的项目，想参与开源从这里挑',
    group: 'stars',
    kind: 'search',
    q: 'stars:>1000',
    sort: 'help-wanted-issues',
    ttl: 120,
    note: '按 GitHub 的 help-wanted 议题数排序'
  },
  {
    id: 's-veteran',
    name: '十年常青榜',
    desc: '2014 年前就存在、至今仍是头部的老牌项目',
    group: 'stars',
    kind: 'search',
    q: 'created:<2014-06-01 stars:>15000',
    sort: 'stars',
    ttl: 240
  },
  {
    id: 's-evergreen',
    name: '老而弥坚榜',
    desc: '2019 年前创建、最近一个月还在提交的高星项目',
    group: 'stars',
    kind: 'search',
    q: 'created:<2019-01-01 stars:>10000 pushed:>{D30}',
    sort: 'stars',
    ttl: 120
  },

  // ---------- 新星崛起 ----------
  {
    id: 'f-7',
    name: '七日内新星',
    desc: '最近 7 天创建且已经开始涨星的项目',
    group: 'fresh',
    kind: 'search',
    q: 'created:>{D7} stars:>20',
    sort: 'stars',
    windowDays: 1,
    ttl: 20
  },
  {
    id: 'f-30',
    name: '本月新星',
    desc: '最近 30 天创建、星标破百的项目',
    group: 'fresh',
    kind: 'search',
    q: 'created:>{D30} stars:>100',
    sort: 'stars',
    ttl: 45
  },
  {
    id: 'f-90',
    name: '季度新星',
    desc: '最近 90 天创建、星标破 300 的项目',
    group: 'fresh',
    kind: 'search',
    q: 'created:>{D90} stars:>300',
    sort: 'stars',
    ttl: 60
  },
  {
    id: 'f-365',
    name: '年度新星',
    desc: '一年内创建就冲上两千星的项目',
    group: 'fresh',
    kind: 'search',
    q: 'created:>{D365} stars:>2000',
    sort: 'stars',
    ttl: 120
  },
  {
    id: 'f-gem',
    name: '隐藏宝石榜',
    desc: '百到千星之间、两周内还有提交的小而美项目',
    group: 'fresh',
    kind: 'search',
    q: 'stars:100..1500 created:>{D180} pushed:>{D14}',
    sort: 'stars',
    ttl: 90
  },
  {
    id: 'f-potential',
    name: '潜力股榜',
    desc: '一年内创建的项目，按「平均每天涨多少星」排序',
    group: 'fresh',
    kind: 'search',
    q: 'stars:300..8000 created:>{D365}',
    sort: 'stars',
    clientSort: 'starPerDay',
    ttl: 90,
    note: '平均涨星 = 当前星标 ÷ 创建天数，反映长期爬坡速度'
  },

  // ---------- 活跃维护 ----------
  {
    id: 'a-today',
    name: '今日仍在提交',
    desc: '今天有推送、星标过两千的项目',
    group: 'active',
    kind: 'search',
    q: 'pushed:>{D1} stars:>2000',
    sort: 'updated',
    windowDays: 1,
    ttl: 20
  },
  {
    id: 'a-week',
    name: '本周活跃榜',
    desc: '一周内有推送的高星项目',
    group: 'active',
    kind: 'search',
    q: 'pushed:>{D7} stars:>5000',
    sort: 'updated',
    windowDays: 7,
    ttl: 45
  },

  // ---------- 领域精选 ----------
  {
    id: 'n-llm',
    name: '大模型 / LLM',
    desc: 'LLM 相关高星项目',
    group: 'niche',
    kind: 'search',
    q: 'topic:llm stars:>2000',
    sort: 'stars',
    ttl: 120
  },
  {
    id: 'n-agent',
    name: 'AI Agent',
    desc: '智能体框架、工具调用与编排',
    group: 'niche',
    kind: 'search',
    q: 'topic:agent stars:>500',
    sort: 'stars',
    ttl: 120
  },
  {
    id: 'n-selfhosted',
    name: '自托管神器',
    desc: '自己部署一套，替代 SaaS',
    group: 'niche',
    kind: 'search',
    q: 'topic:self-hosted stars:>3000',
    sort: 'stars',
    ttl: 120
  },
  {
    id: 'n-cli',
    name: '终端工具',
    desc: '命令行里最好用的那些',
    group: 'niche',
    kind: 'search',
    q: 'topic:cli stars:>3000',
    sort: 'stars',
    ttl: 120
  },
  {
    id: 'n-awesome',
    name: 'Awesome 大全',
    desc: '各类 awesome 清单，找资源最快',
    group: 'niche',
    kind: 'search',
    q: 'topic:awesome stars:>5000',
    sort: 'stars',
    ttl: 180
  },
  {
    id: 'n-k8s',
    name: '云原生',
    desc: 'Kubernetes 生态高星项目',
    group: 'niche',
    kind: 'search',
    q: 'topic:kubernetes stars:>3000',
    sort: 'stars',
    ttl: 120
  },

  // ---------- 我的 ----------
  {
    id: 'm-tracked',
    name: '我的追踪榜',
    desc: '关注的项目按本地采样的涨星速度排序',
    group: 'mine',
    kind: 'tracked',
    windowDays: 7,
    ttl: 10,
    note: '涨星由本机历史采样计算，用得越久越准'
  }
]

export const BOARD_MAP: Record<string, BoardDef> = Object.fromEntries(
  BOARDS.map((b) => [b.id, b])
)

/** 榜单语言筛选选项（trending 榜与跟随语言的搜索榜共用） */
export const BOARD_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'any', label: '全部语言' },
  { value: 'rust', label: 'Rust' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'java', label: 'Java' },
  { value: 'cpp', label: 'C++' },
  { value: 'c', label: 'C' },
  { value: 'csharp', label: 'C#' },
  { value: 'php', label: 'PHP' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'vue', label: 'Vue' },
  { value: 'shell', label: 'Shell' },
  { value: 'zig', label: 'Zig' }
]

/** 把 {D7} 这类占位转成具体日期 */
export function resolveQuery(q: string, now = Date.now()): string {
  return q.replace(/\{D(\d+)\}/g, (_m, d: string) => {
    const t = now - Number(d) * 86400000
    return new Date(t).toISOString().slice(0, 10)
  })
}

/** 语言值转 GitHub trending 的路径段 */
export function languageSlug(lang: string): string {
  return lang.trim().toLowerCase().replace(/\s+/g, '-')
}
