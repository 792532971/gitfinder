/**
 * 仓库中文画像。
 *
 * 榜单里的仓库只有英文简介，用户看不出「这东西到底能干什么、我能不能装上」。
 * 这里做两层：
 *   1. AI 生成（主路径）：批量把仓库元数据交给模型，产出中文用途 / 分类 / 安装方式 / 上手难度。
 *      结果按 full_name + pushed_at 落盘缓存 14 天，换榜单复用，不会重复烧 token。
 *   2. 元数据推测（降级路径）：没配 AI 或调用失败时，从 topics / 语言 / 简介里猜安装方式，
 *      并明确标记 source=heuristic，界面会写「推测」——此时用途一栏仍是英文原简介，
 *      用户可以在榜单上点「译成中文」单条补翻。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { chatJson } from './llm'
import { loadSettings } from './settings'
import type {
  BoardItem,
  InstallOption,
  ProfileInput,
  ProfileUpdateEvent,
  RepoItem,
  RepoProfile
} from '../../shared/types'

interface Entry {
  at: number
  pushedAt: string
  profile: RepoProfile
}

const TTL = 14 * 86400000
const BATCH = 8
/** 同时只跑两个请求：再快模型也扛不住，还容易触发限流 */
const CONCURRENCY = 2
/** 一次最多补齐 60 条：榜单最长 50 条，留点余量，避免排在后面的永远拿不到中文 */
const MAX_ITEMS = 60

let mem: Record<string, Entry> | null = null
let persistTimer: NodeJS.Timeout | null = null
const inflight = new Set<string>()

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'repo-profiles.json')
}

function loadDisk(): Record<string, Entry> {
  if (mem) return mem
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'))
    const now = Date.now()
    const out: Record<string, Entry> = {}
    for (const [k, v] of Object.entries(raw || {})) {
      const e = v as Entry
      if (e?.at && now - e.at < TTL && e.profile?.purpose) out[k] = e
    }
    mem = out
  } catch {
    mem = {}
  }
  return mem!
}

function persist(): void {
  if (!mem) return
  try {
    const dir = path.dirname(cacheFile())
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify(mem), 'utf-8')
  } catch (err) {
    console.error('[profile] 缓存写入失败', err)
  }
}

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist()
  }, 1200)
  persistTimer.unref?.()
}

function keyOf(fullName: string): string {
  return fullName.toLowerCase()
}

function read(fullName: string, pushedAt: string): RepoProfile | null {
  const e = loadDisk()[keyOf(fullName)]
  if (!e) return null
  if (Date.now() - e.at > TTL) return null
  // 仓库有新的提交，说明描述/构建方式可能变了，让 AI 重新看一遍
  if (pushedAt && e.pushedAt && pushedAt !== e.pushedAt) return null
  return e.profile
}

function write(input: ProfileInput, profile: RepoProfile): void {
  const d = loadDisk()
  d[keyOf(input.full_name)] = { at: Date.now(), pushedAt: input.pushed_at || '', profile }
  // 控制体积：超过 1500 个仓库按时间淘汰
  const keys = Object.keys(d)
  if (keys.length > 1500) {
    keys
      .sort((a, b) => (d[a]?.at || 0) - (d[b]?.at || 0))
      .slice(0, keys.length - 1500)
      .forEach((k) => delete d[k])
  }
  schedulePersist()
}

// ---------------------------------------------------------------- 元数据推测

/** 常见 topic → 中文分类。够用就行，命中不了的交给 AI */
const TOPIC_CN: Record<string, string> = {
  rss: 'RSS 阅读',
  feed: '订阅阅读',
  'rss-reader': 'RSS 阅读器',
  cli: '命令行工具',
  'command-line': '命令行工具',
  terminal: '终端工具',
  tui: '终端界面',
  docker: '容器服务',
  compose: '容器服务',
  'self-hosted': '自托管服务',
  selfhosted: '自托管服务',
  homelab: '自托管服务',
  llm: '大模型',
  ai: 'AI 应用',
  agent: 'AI Agent',
  'ai-agents': 'AI Agent',
  chatbot: '聊天机器人',
  rag: '知识库问答',
  mcp: 'MCP 服务',
  proxy: '网络代理',
  vpn: '网络代理',
  database: '数据库',
  db: '数据库',
  sql: '数据库',
  monitoring: '监控告警',
  observability: '可观测性',
  automation: '自动化',
  workflow: '工作流',
  editor: '编辑器',
  ide: '开发工具',
  'vscode-extension': 'VSCode 插件',
  obsidian: 'Obsidian 插件',
  plugin: '插件',
  framework: '开发框架',
  library: '开发库',
  sdk: '开发库',
  boilerplate: '项目模板',
  template: '项目模板',
  awesome: '资源合集',
  'awesome-list': '资源合集',
  security: '安全工具',
  scraper: '爬虫工具',
  crawler: '爬虫工具',
  crawlee: '爬虫工具',
  game: '游戏',
  'video': '音视频',
  audio: '音频处理',
  music: '音乐播放',
  note: '笔记工具',
  notes: '笔记工具',
  'note-taking': '笔记工具',
  wiki: '知识库',
  blog: '博客系统',
  cms: '内容管理',
  chat: '即时通讯',
  'file-sharing': '文件传输',
  storage: '存储服务',
  backup: '备份工具',
  dashboard: '数据看板',
  visualization: '数据可视化',
  chart: '图表库',
  'machine-learning': '机器学习',
  ml: '机器学习',
  cv: '计算机视觉',
  nlp: '自然语言处理',
  'deep-learning': '深度学习',
  inference: '模型推理',
  quantization: '模型量化',
  'web-framework': 'Web 框架',
  'css': '样式工具',
  ui: 'UI 组件库',
  'ui-components': 'UI 组件库',
  mobile: '移动端',
  android: '安卓',
  ios: 'iOS',
  desktop: '桌面应用',
  electron: '桌面应用',
  tauri: '桌面应用'
}

function guessCategory(input: ProfileInput): string {
  for (const t of input.topics || []) {
    const hit = TOPIC_CN[String(t).toLowerCase()]
    if (hit) return hit
  }
  const blob = `${input.full_name} ${input.description}`.toLowerCase()
  if (/\b(plugin|extension|addon)\b/.test(blob)) return '插件'
  if (/\b(cli|command[- ]line|terminal)\b/.test(blob)) return '命令行工具'
  if (/\b(web ?app|dashboard|self[- ]hosted|server)\b/.test(blob)) return '自托管服务'
  if (/\b(library|sdk|framework|binding|client)\b/.test(blob)) return '开发库'
  return ''
}

function guessInstalls(input: ProfileInput): InstallOption[] {
  const blob = `${input.full_name} ${input.description} ${(input.topics || []).join(' ')}`.toLowerCase()
  const out: InstallOption[] = []
  const push = (o: InstallOption): void => {
    if (!out.some((x) => x.kind === o.kind || x.label === o.label)) out.push(o)
  }

  if (/\bdocker\b|\bcontainer/.test(blob)) push({ kind: 'docker', label: 'Docker' })
  if (/docker[- ]compose|compose\.ya?ml|\bcompose\b/.test(blob))
    push({ kind: 'compose', label: 'Compose' })
  if (/\bplugin\b|\bextension\b|\baddon\b|obsidian|vscode/.test(blob))
    push({ kind: 'plugin', label: '插件' })
  if (/\bwindows\b|\.exe\b|\binstaller\b|\bdesktop\b/.test(blob))
    push({ kind: 'installer', label: '安装包' })

  const lang = (input.language || '').toLowerCase()
  if (lang === 'typescript' || lang === 'javascript') push({ kind: 'package', label: 'npm' })
  else if (lang === 'python') push({ kind: 'package', label: 'pip' })
  else if (lang === 'go') push({ kind: 'package', label: 'go install' })
  else if (lang === 'rust') push({ kind: 'package', label: 'cargo' })
  else if (lang === 'ruby') push({ kind: 'package', label: 'gem' })
  else if (lang === 'php') push({ kind: 'package', label: 'composer' })

  if (/\blibrary\b|\bsdk\b|\bframework\b|\bbinding\b/.test(blob))
    push({ kind: 'library', label: '开发库' })

  // 兜底的「源码运行」只在简介明确提到编译时才给，否则宁可不写
  if (!out.length && /\bbuild\b|\bcompile\b|\bcmake\b|\bmake install\b|from source/.test(blob))
    push({ kind: 'source', label: '源码运行' })

  return out.slice(0, 3)
}

function heuristic(input: ProfileInput): RepoProfile | null {
  const installs = guessInstalls(input)
  const category = guessCategory(input)
  if (!installs.length && !category) return null
  return {
    purpose: '',
    category,
    platforms: [],
    installs,
    level: '',
    deployable: installs.some((i) => i.kind === 'docker' || i.kind === 'compose'),
    source: 'heuristic',
    at: 0
  }
}

// ---------------------------------------------------------------- 给榜单挂画像

function toInput(item: RepoItem): ProfileInput {
  return {
    full_name: item.full_name,
    description: item.description || '',
    language: item.language || '',
    topics: Array.isArray(item.topics) ? item.topics.slice(0, 10) : [],
    stars: item.stars || 0,
    archived: !!item.archived,
    pushed_at: item.pushed_at || ''
  }
}

/** 同步挂载：优先用 AI 缓存，没有就退回元数据推测 */
export function attach<T extends RepoItem>(items: T[]): (T & { profile?: RepoProfile })[] {
  return items.map((it) => {
    const cached = read(it.full_name, it.pushed_at)
    if (cached) return { ...it, profile: cached }
    const guessed = heuristic(toInput(it))
    return guessed ? { ...it, profile: guessed } : it
  })
}

/** 从榜单条目取最小输入，供渲染层反复请求时复用 */
export function pickInputs(items: BoardItem[]): ProfileInput[] {
  return items.slice(0, MAX_ITEMS).map(toInput)
}

// ---------------------------------------------------------------- AI 批量生成

const SYSTEM_PROMPT = `你是开源项目选型顾问，读者是中文开发者。他扫一眼榜单就要判断三件事：这东西是干什么的、能不能装到自己机器上、装起来麻不麻烦。

你会收到一批 GitHub 仓库的元数据（full_name / description / language / topics / stars / archived），为每个仓库输出一份中文画像。

【purpose】一句话中文，25~50 字，要讲清三层：它是什么类型的工具 → 具体解决什么问题 → 谁在什么场景下会用。
- 好例子：「自托管的 RSS 阅读器，把多个站点订阅聚合到一个网页里读，支持多用户和全文抓取，适合替代 Feedly。」
- 坏例子：「一个开源项目」「用 Rust 写的高性能工具」「功能强大的框架」——读者看完仍然不知道能干什么。
- 不要逐字翻译英文简介，要提炼。可以依据仓库名、topics、语言合理推断，但严禁编造具体细节（支持多少种格式、快多少倍、兼容哪些版本）。
- 元数据太少（连简介都没有）时，就说清它是哪个方向、哪一类项目，并注明「资料较少」，不要硬编。

【category】2~6 个汉字的中文领域标签，如：终端工具 / 自托管服务 / RSS 阅读器 / 大模型推理 / 前端框架 / 数据库 / 运维监控 / AI Agent。

【installs】按推荐顺序列出真实可行的安装或使用方式，最多 4 个，宁缺毋滥。kind 只能是：
- docker：官方提供容器镜像，detail 写 docker run 命令（端口不确定就省掉 -p）
- compose：仓库里有 docker-compose.yml / compose.yaml，detail 写「下载 compose 文件后 docker compose up -d」
- installer：有图形安装包（.exe / .msi / .dmg），detail 写「从 Releases 下载安装包」
- portable：提供免安装的单个可执行文件（绿色版、单文件二进制）
- package：通过包管理器安装。label 写包管理器名（npm / pnpm / pip / uv / go / cargo / brew / winget / gem / composer），detail 写完整安装命令
- hosted：官方有在线服务，打开网页就能用，detail 写官网地址
- source：只能 clone 源码自己编译运行
- plugin：是别的软件的插件（VSCode / Obsidian / 浏览器扩展），detail 写「在插件市场搜索 xxx」
- library：是给开发者引用的库或 SDK，不能直接运行
判断优先级：description 明确提到 > topics > language > 仓库名。拿不准就不要列。库类项目不要出现 installer / portable。

【level】上手难度，只能是「简单」「中等」「较难」。有 Docker 一键起或图形安装包 → 简单；要自己配环境编译 → 较难。

【platforms】从 ["Windows","macOS","Linux","Web","Docker","Android","iOS"] 里选，最多 4 个。

输出严格 JSON，不要 Markdown 代码块，不要任何解释：
{"items":[{"full_name":"owner/name","purpose":"...","category":"...","installs":[{"kind":"docker","label":"Docker","detail":"docker run -d -p 8080:8080 ghcr.io/owner/name"}],"level":"简单","platforms":["Linux","Docker"]}]}

输入里的每个 full_name 都必须出现且只出现一次，顺序保持一致。`

const VALID_KINDS = new Set([
  'docker',
  'compose',
  'installer',
  'portable',
  'package',
  'hosted',
  'source',
  'plugin',
  'library'
])

function clean(v: any, max = 200): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function normalizeProfile(raw: any, input: ProfileInput): RepoProfile | null {
  const purpose = clean(raw?.purpose, 140)
  if (!purpose) return null

  const installs: InstallOption[] = []
  for (const it of Array.isArray(raw?.installs) ? raw.installs : []) {
    const kind = clean(it?.kind, 20).toLowerCase()
    const label = clean(it?.label, 16)
    if (!VALID_KINDS.has(kind) || !label) continue
    if (installs.some((x) => x.kind === kind && x.label === label)) continue
    const detail = clean(it?.detail, 160)
    installs.push(detail ? { kind, label, detail } : { kind, label })
    if (installs.length >= 4) break
  }

  const levelRaw = clean(raw?.level, 8)
  const level = ['简单', '中等', '较难'].includes(levelRaw) ? levelRaw : ''

  const platforms = (Array.isArray(raw?.platforms) ? raw.platforms : [])
    .map((p: any) => clean(p, 12))
    .filter((p: string) =>
      ['Windows', 'macOS', 'Linux', 'Web', 'Docker', 'Android', 'iOS'].includes(p)
    )
    .slice(0, 4)

  if (!installs.length) {
    // 模型判断不出来时，用元数据兜个底，至少让用户知道大概怎么装
    installs.push(...guessInstalls(input).slice(0, 2))
  }

  return {
    purpose,
    category: clean(raw?.category, 16),
    platforms,
    installs,
    level,
    deployable: installs.some((i) => i.kind === 'docker' || i.kind === 'compose'),
    source: 'ai',
    at: Date.now()
  }
}

async function askAi(batch: ProfileInput[]): Promise<Record<string, any>> {
  const payload = batch.map((b) => ({
    full_name: b.full_name,
    description: clean(b.description, 300),
    language: b.language,
    topics: b.topics.slice(0, 8),
    stars: b.stars,
    archived: b.archived
  }))
  const parsed = await chatJson(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ repos: payload }) }
    ],
    { temperature: 0.3, maxTokens: 2400, timeoutMs: 90000 }
  )
  const out: Record<string, any> = {}
  for (const it of Array.isArray(parsed?.items) ? parsed.items : []) {
    const k = clean(it?.full_name, 120).toLowerCase()
    if (k) out[k] = it
  }
  return out
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

type Sender = { isDestroyed: () => boolean; send: (channel: string, payload: any) => void }

async function runJob(todo: ProfileInput[], sender: Sender, scope: string): Promise<void> {
  const total = todo.length
  let finished = 0
  let errorMsg = ''
  const batches: ProfileInput[][] = []
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))

  const emit = (profiles: Record<string, RepoProfile>, done: boolean): void => {
    if (sender.isDestroyed()) return
    const payload: ProfileUpdateEvent = {
      scope,
      finished: Math.min(finished, total),
      total,
      profiles,
      done,
      ...(errorMsg ? { error: errorMsg } : {})
    }
    sender.send('board:profiles', payload)
  }

  try {
    await mapLimit(batches, CONCURRENCY, async (batch) => {
      try {
        const got = await askAi(batch)
        const profiles: Record<string, RepoProfile> = {}
        for (const input of batch) {
          const raw = got[keyOf(input.full_name)]
          const norm = raw ? normalizeProfile(raw, input) : null
          if (norm) {
            write(input, norm)
            profiles[input.full_name] = norm
          }
        }
        finished += batch.length
        emit(profiles, false)
      } catch (err: any) {
        // 一批失败不中断整体，界面上会提示并保留元数据推测
        errorMsg = err?.message || String(err)
        finished += batch.length
        emit({}, false)
      } finally {
        batch.forEach((b) => inflight.delete(b.full_name))
      }
    })
  } finally {
    finished = total
    emit({}, true)
  }
}

/** 对外入口：同步返回缓存命中情况，缺的后台补 */
export function enrich(
  inputs: ProfileInput[],
  sender: Sender,
  options: { scope?: string; force?: boolean } = {}
): { total: number; cached: number; pending: number; ai: boolean } {
  const list = inputs.slice(0, MAX_ITEMS)
  const aiReady = !!loadSettings().ai.apiKey
  const force = !!options.force
  let cached = 0
  const todo: ProfileInput[] = []

  for (const it of list) {
    if (!it?.full_name) continue
    if (!force) {
      const hit = read(it.full_name, it.pushed_at || '')
      if (hit && hit.source === 'ai') {
        cached++
        continue
      }
    }
    if (inflight.has(keyOf(it.full_name))) continue
    if (todo.some((t) => keyOf(t.full_name) === keyOf(it.full_name))) continue
    todo.push(it)
  }

  // 没配 AI 就不用排队了，界面会退到元数据推测
  if (!aiReady || !todo.length) {
    return { total: list.length, cached, pending: 0, ai: aiReady }
  }

  todo.forEach((t) => inflight.add(keyOf(t.full_name)))
  void runJob(todo, sender, String(options.scope || ''))
  return { total: list.length, cached, pending: todo.length, ai: true }
}

export function clearProfiles(): number {
  const n = Object.keys(loadDisk()).length
  mem = {}
  inflight.clear()
  try {
    fs.rmSync(cacheFile(), { force: true })
  } catch {
    /* ignore */
  }
  return n
}
