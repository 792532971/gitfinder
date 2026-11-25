/**
 * 兼容 OpenAI 协议的对话封装。
 *
 * 搜索润色和榜单画像都走这里，省得两处各自维护 endpoint、降级重试和 JSON 解析。
 */
import { postJson, HttpError } from './http'
import { loadSettings } from './settings'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** 默认 true，失败会自动降级重试一次不带 response_format 的请求 */
  jsonMode?: boolean
}

/** 把用户填的 baseUrl 补成完整的 /chat/completions 地址 */
export function buildEndpoint(baseUrl: string, path: string): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('未配置 AI 接口地址')
  if (/\/chat\/completions$/i.test(b)) return b
  if (/\/v\d+$/i.test(b)) return `${b}${path}`
  return `${b}/v1${path}`
}

/** 模型偶尔会包 Markdown 代码块或加前后缀，这里尽量把 JSON 抠出来 */
export function extractJson(text: string): any {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        /* fallthrough */
      }
    }
    throw new Error('AI 返回的内容不是合法 JSON')
  }
}

/** 发起一次对话并解析成 JSON */
export async function chatJson(messages: ChatMessage[], opts: ChatOptions = {}): Promise<any> {
  const { ai } = loadSettings()
  if (!ai.apiKey) {
    throw new Error('还没配置 AI API Key，请打开设置填写（支持 DeepSeek 等 OpenAI 兼容接口）')
  }
  const url = buildEndpoint(ai.baseUrl, '/chat/completions')
  const call = (useJsonMode: boolean): Promise<any> =>
    postJson<any>(
      url,
      {
        model: ai.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 900,
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {})
      },
      { Authorization: `Bearer ${ai.apiKey}` },
      opts.timeoutMs ?? 60000
    )

  let data: any
  if (opts.jsonMode === false) {
    data = await call(false)
  } else {
    try {
      data = await call(true)
    } catch (err) {
      // 部分兼容服务不支持 response_format，降级重试一次
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) data = await call(false)
      else throw err
    }
  }

  const content = data?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new Error('AI 没有返回内容，请检查模型名称是否正确')
  }
  return extractJson(content)
}
