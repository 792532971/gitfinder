import { postJson, request } from '../lib/http'
import { loadSettings } from '../lib/settings'
import { buildEndpoint, chatJson } from '../lib/llm'
import type { AiPolishResult } from '../../shared/types'

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
      return {
        ok: true,
        message: hit
          ? `连接成功，模型 ${ai.model} 可用`
          : models.length
            ? `连接成功。当前模型 ${ai.model} 未在列表中出现，可用模型：${models.slice(0, 6).join(', ')}`
            : `连接成功`
      }
    }
    // /models 不被支持时，用一次极小对话兜底验证
    const fallback = await postJson<any>(
      buildEndpoint(ai.baseUrl, '/chat/completions'),
      { model: ai.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
      { Authorization: `Bearer ${ai.apiKey}` },
      30000
    )
    if (fallback?.choices?.length) return { ok: true, message: `连接成功，模型 ${ai.model} 可用` }
    return { ok: false, message: `接口返回异常：${JSON.stringify(fallback).slice(0, 160)}` }
  } catch (err: any) {
    return { ok: false, message: err?.hint || err?.message || String(err) }
  }
}
