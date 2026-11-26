import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { postJson, request } from '../lib/http'
import { loadSettings } from '../lib/settings'
import { buildEndpoint, chatJson, chatText } from '../lib/llm'
import type { AiPolishResult, TranslateResult } from '../../shared/types'

const SYSTEM_PROMPT = `你是 GitHub 仓库搜索专家。用户会用自然语言（多为中文）描述他想找的开源项目，你要把它转成一条高质量的 GitHub Search 查询。

硬性规则：
1. GitHub 上的仓库名和描述绝大多数是英文，所以必须把中文概念翻译成地道的英文技术词（例如"一键部署"→"one-click deploy"，"图床"→"image hosting"，"笔记"→"note taking"）。
2. query 只放 GitHub 搜索框 q 参数的内容，绝对不要包含 sort / order / page / per_page。
3. 允许使用的限定符只有这些：
   - in:name / in:description / in:readme / in:topics（可组合写 in:name,description,readme）
   - language:<英文语言名，小写>
   - stars:>N / stars:N..M / forks:>N
   - topic:<小写topic>
   - pushed:>YYYY-MM-DD / created:>YYYY-MM-DD
   - license:<mit|apache-2.0|gpl-3.0>
   - archived:false / is:public
4. 核心关键词控制在 2-5 个，空格分隔表示 AND。不要堆砌同义词，会过度收窄结果。
5. 找"可用工具/软件"时，加 in:name,description,readme 并把 stars 门槛设为 100 以上，过滤掉玩具项目。
6. 不要臆造 topic 名。拿不准就不写 topic。
7. 如果用户明确说了语言（比如"用 Rust 写的"），把该语言写进 query 的 language: 里，同时也在 language 字段返回同一个值。
8. 如果用户的描述本身已经很具体（比如直接给了库名），就保留原词，不要乱改写。

只输出一个 JSON 对象，不要 Markdown 代码块，不要任何额外文字。字段：
{
  "query": "最终 q 参数",
  "language": "英文语言名或空字符串",
  "sort": "stars" | "forks" | "updated" | "best-match",
  "order": "desc" | "asc",
  "explain": "一句中文，说明你做了哪些改写",
  "keywords": ["提炼出的英文关键词", "..."]
}`

function normalizeSort(v: any): AiPolishResult['sort'] {
  const s = String(v || '').toLowerCase()
  if (s === 'forks' || s === 'updated' || s === 'stars') return s
  return 'best-match'
}

function normalizeOrder(v: any): 'desc' | 'asc' {
  return String(v || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
}

export async function polish(text: string): Promise<AiPolishResult> {
  const desc = (text || '').trim()
  if (!desc) throw new Error('请输入你想找的项目描述')
  const { ai } = loadSettings()
  if (!ai.apiKey) {
    throw new Error('还没配置 AI API Key，请打开设置填写（支持 DeepSeek 等 OpenAI 兼容接口）')
  }

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: `我的需求：${desc}\n\n请输出 JSON。如果描述里没提语言和排序偏好，language 返回空字符串，sort 返回 "best-match"。`
    }
  ]

  const parsed = await chatJson(messages, { temperature: 0.2, maxTokens: 900, timeoutMs: 60000 })
  const query = String(parsed.query || '').trim()
  if (!query) throw new Error('AI 返回的 query 为空，换个描述再试')

  return {
    query,
    language: String(parsed.language || '').trim().toLowerCase(),
    sort: normalizeSort(parsed.sort),
    order: normalizeOrder(parsed.order),
    explain: String(parsed.explain || '').trim(),
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k: any) => String(k)).slice(0, 8)
      : []
  }
}

/* ------------------------------------------------------------------
 * README 翻译
 *
 * 只在用户点「译成中文」时触发，绝不自动跑。README 动辄几十 KB，
 * 这里按代码块边界切段、限并发、按内容哈希缓存，避免重复烧 token。
 * ------------------------------------------------------------------ */

const TRANSLATE_SYSTEM = `你是技术文档翻译。把用户给你的 Markdown 片段翻译成简体中文。

必须遵守：
1. 完整保留原有 Markdown 结构：标题层级、列表符号、表格分隔线、引用块、加粗斜体、分隔线，一律照抄。
2. 代码块（三反引号包裹的内容）和行内代码（单反引号里的内容）原样保留，一个字都不要改，也不要翻译。
3. 链接语法 [文字](URL)：URL 绝对不动，只翻译方括号里的文字。图片 ![](URL) 同理。
4. 徽章地址（shields.io、badge 之类）和 HTML 标签的属性值不动。
5. 专有名词保留英文：项目名、库名、命令、API 名、文件路径、许可证名、公司名、人名。
6. 已经是中文的部分不要重译，术语前后保持一致。
7. 不要加任何解释、前言、结语，也不要用代码块包裹整段输出。
8. 只输出译文本身。`

/** 单次翻译最多处理的字符数，超出只翻译前面部分 */
const TRANSLATE_MAX_CHARS = 24000
/** 每段的目标长度（按行累计，不切断代码块） */
const CHUNK_LIMIT = 2800
const TRANSLATE_CONCURRENCY = 2
const CACHE_TTL = 30 * 86400000
const CACHE_MAX = 40

interface CacheEntry {
  at: number
  text: string
}

let translateCache: Record<string, CacheEntry> | null = null

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'translate-cache.json')
}

function loadCache(): Record<string, CacheEntry> {
  if (translateCache) return translateCache
  try {
    translateCache = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'))
  } catch {
    translateCache = {}
  }
  return translateCache!
}

function persistCache(): void {
  try {
    const entries = Object.entries(loadCache())
      .filter(([, v]) => Date.now() - v.at < CACHE_TTL)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_MAX)
    translateCache = Object.fromEntries(entries)
    fs.writeFileSync(cacheFile(), JSON.stringify(translateCache), 'utf-8')
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

function cacheKey(fullName: string, text: string): string {
  return createHash('sha256').update(`${fullName}\u0000${text}`).digest('hex').slice(0, 32)
}

/** 按行切段，只在代码块外面断开，保证 ``` 围栏成对 */
function splitMarkdown(md: string, limit = CHUNK_LIMIT): string[] {
  const lines = md.split('\n')
  const chunks: string[] = []
  let buf: string[] = []
  let size = 0
  let inFence = false

  const flush = (): void => {
    if (buf.length) {
      chunks.push(buf.join('\n'))
      buf = []
      size = 0
    }
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    buf.push(line)
    size += line.length + 1
    if (!inFence && size >= limit) flush()
  }
  flush()
  return chunks.length ? chunks : [md]
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** 模型有时会把整段译文包进 ```markdown，剥掉 */
function stripFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  return m ? m[1] : t
}

async function translateChunk(
  chunk: string,
  fullName: string,
  index: number,
  total: number
): Promise<string> {
  const out = await chatText(
    [
      { role: 'system', content: TRANSLATE_SYSTEM },
      {
        role: 'user',
        content: `${fullName} 的 README 第 ${index}/${total} 段，请翻译：\n\n${chunk}`
      }
    ],
    { temperature: 0.1, maxTokens: 4096, timeoutMs: 120000 }
  )
  return stripFence(out)
}

export async function translate(input: {
  text: string
  fullName?: string
}): Promise<TranslateResult> {
  const source = (input.text || '').trim()
  if (!source) {
    return { ok: false, text: '', chunks: 0, cached: false, message: '没有可翻译的内容' }
  }
  const { ai } = loadSettings()
  if (!ai.apiKey) {
    return {
      ok: false,
      text: '',
      chunks: 0,
      cached: false,
      message: '还没配置 AI API Key，请打开设置填写后再翻译'
    }
  }

  const truncated = source.length > TRANSLATE_MAX_CHARS
  const body = truncated ? source.slice(0, TRANSLATE_MAX_CHARS) : source
  const key = cacheKey(input.fullName || '', body)

  const hit = loadCache()[key]
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return {
      ok: true,
      text: hit.text,
      chunks: 0,
      cached: true,
      message: '用了本地缓存的译文，没有消耗 token'
    }
  }

  const chunks = splitMarkdown(body)
  try {
    const parts = await mapLimit(chunks, TRANSLATE_CONCURRENCY, (c, i) =>
      translateChunk(c, input.fullName || '该仓库', i + 1, chunks.length)
    )
    const text = parts.join('\n')
    loadCache()[key] = { at: Date.now(), text }
    persistCache()
    return {
      ok: true,
      text,
      chunks: chunks.length,
      cached: false,
      message: truncated ? `README 太长，只翻译了前 ${TRANSLATE_MAX_CHARS} 字` : ''
    }
  } catch (err: any) {
    return {
      ok: false,
      text: '',
      chunks: chunks.length,
      cached: false,
      message: err?.hint || err?.message || String(err)
    }
  }
}

/** 真发一次极小的对话，确认模型名真的可用（/models 列表不一定全） */
async function probeChat(): Promise<{ ok: boolean; message: string }> {
  const { ai } = loadSettings()
  try {
    const r = await postJson<any>(
      buildEndpoint(ai.baseUrl, '/chat/completions'),
      {
        model: ai.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0
      },
      { Authorization: `Bearer ${ai.apiKey}` },
      30000
    )
    if (r?.choices?.length) return { ok: true, message: `连接成功，模型 ${ai.model} 可正常对话` }
    return { ok: false, message: `接口返回异常：${JSON.stringify(r).slice(0, 160)}` }
  } catch (err: any) {
    return { ok: false, message: err?.hint || err?.message || String(err) }
  }
}

export async function test(): Promise<{ ok: boolean; message: string }> {
  const { ai } = loadSettings()
  if (!ai.apiKey) return { ok: false, message: '请先填写 API Key' }
  try {
    const url = buildEndpoint(ai.baseUrl, '/models')
    const res = await request(url, {
      headers: { Authorization: `Bearer ${ai.apiKey}` },
      timeoutMs: 20000
    })
    if (res.ok) {
      let models: string[] = []
      try {
        const j: any = await res.json()
        models = (j.data || []).map((m: any) => m.id).filter(Boolean)
      } catch {
        /* ignore */
      }
      const hit = models.find((m) => m === ai.model)
      if (hit) return { ok: true, message: `连接成功，模型 ${ai.model} 可用` }

      // 列表里没有这个模型名，别急着报警：/models 经常只列一部分，
      // 直接发一次最小对话，能通就说明配置正确。
      const probe = await probeChat()
      if (probe.ok) {
        return {
          ok: true,
          message: `${probe.message}（${ai.baseUrl} 的模型列表里没列 ${ai.model}，不影响调用${
            models.length ? `；列表中是 ${models.slice(0, 4).join(', ')}` : ''
          }）`
        }
      }
      return {
        ok: false,
        message: models.length
          ? `${probe.message}。当前模型 ${ai.model} 不在可用列表里，试试：${models.slice(0, 6).join(', ')}`
          : probe.message
      }
    }
    // /models 不被支持时，用一次极小对话兜底验证
    return await probeChat()
  } catch (err: any) {
    return { ok: false, message: err?.hint || err?.message || String(err) }
  }
}
