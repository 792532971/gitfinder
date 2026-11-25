import { ghJson, ghText, exists, request, HttpError } from '../lib/http'
import { loadSettings } from '../lib/settings'
import type {
  SearchParams,
  SearchResponse,
  RepoItem,
  DockerProbe,
  ReleaseInfo,
  ReleaseAsset
} from '../../shared/types'

const API = 'https://api.github.com'

export function mapRepo(raw: any): RepoItem {
  return {
    id: raw.id,
    full_name: raw.full_name,
    owner: raw.owner?.login || '',
    name: raw.name || '',
    html_url: raw.html_url,
    description: raw.description || '',
    language: raw.language || '',
    stars: raw.stargazers_count || 0,
    forks: raw.forks_count || 0,
    open_issues: raw.open_issues_count || 0,
    updated_at: raw.updated_at || '',
    pushed_at: raw.pushed_at || '',
    created_at: raw.created_at || '',
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    license: raw.license?.spdx_id || raw.license?.name || '',
    archived: !!raw.archived,
    default_branch: raw.default_branch || 'main',
    homepage: raw.homepage || ''
  }
}

/** 组装 q：避免用户已手写 language: 时重复追加 */
function buildQuery(params: SearchParams): string {
  let q = (params.q || '').trim()
  if (!q) throw new Error('搜索关键词不能为空')
  if (params.language && params.language !== 'any') {
    if (!/\blanguage:/i.test(q)) {
      q += ` language:${params.language}`
    }
  }
  return q
}

export async function search(params: SearchParams): Promise<SearchResponse> {
  const q = buildQuery(params)
  const perPage = Math.min(Math.max(params.perPage || 30, 1), 100)
  const page = Math.max(params.page || 1, 1)

  const url = new URL(`${API}/search/repositories`)
  url.searchParams.set('q', q)
  if (params.sort && params.sort !== 'best-match') {
    url.searchParams.set('sort', params.sort)
    url.searchParams.set('order', params.order || 'desc')
  }
  url.searchParams.set('per_page', String(perPage))
  url.searchParams.set('page', String(page))

  const res = await fetchWithRateInfo(url.toString())
  return res
}

async function fetchWithRateInfo(url: string): Promise<SearchResponse> {
  const token = loadSettings().githubToken?.trim()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const resp = await request(url, { headers })
  const remaining = resp.headers.get('x-ratelimit-remaining')
  const reset = resp.headers.get('x-ratelimit-reset')

  if (!resp.ok) {
    let body = ''
    try {
      body = await resp.text()
    } catch {
      /* ignore */
    }
    let msg = `搜索失败 HTTP ${resp.status}`
    let hint = ''
    if (resp.status === 403 || resp.status === 429) {
      hint =
        remaining === '0'
          ? `已达 GitHub 搜索频率上限（未登录 10 次/分钟，登录 30 次/分钟）${
              reset ? `，${new Date(Number(reset) * 1000).toLocaleTimeString()} 后重置` : ''
            }`
          : '权限不足或触发风控，建议在设置里配置 GitHub Token'
    } else if (resp.status === 422) {
      hint = '搜索语法有误，试试让 AI 重新润色描述'
    } else if (resp.status === 401) {
      hint = 'GitHub Token 无效，请到设置里更新'
    }
    throw new HttpError(msg, resp.status, body, hint)
  }

  const data: any = await resp.json()
  const items: RepoItem[] = (data.items || []).map(mapRepo)
  const urlObj = new URL(url)
  return {
    total: data.total_count || 0,
    items,
    rateRemaining: remaining ? Number(remaining) : null,
    rateReset: reset ? Number(reset) : null,
    rawQuery: urlObj.searchParams.get('q') || ''
  }
}

/** 读取 README 纯文本，失败返回空串 */
export async function readme(owner: string, repo: string): Promise<string> {
  try {
    return await ghText(`${API}/repos/${owner}/${repo}/readme`, 'application/vnd.github.raw')
  } catch {
    return ''
  }
}

function extractDockerRun(md: string): { cmd: string; snippet: string } {
  const blocks = [...md.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const pools = blocks.length ? blocks : [md]
  for (const block of pools) {
    const lines = block.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(\$|#|>)?\s*docker\s+run\b/i.test(lines[i])) {
        const parts: string[] = []
        let j = i
        while (j < lines.length && j < i + 30) {
          const raw = lines[j]
          const continued = /\\\s*$/.test(raw)
          parts.push(raw.replace(/\\\s*$/, '').trim())
          if (!continued) break
          j++
        }
        const cmd = parts
          .join(' ')
          .replace(/^\s*(\$|#|>)\s*/, '')
          .replace(/\s+/g, ' ')
          .trim()
        return { cmd, snippet: parts.join('\n').slice(0, 800) }
      }
    }
  }
  return { cmd: '', snippet: '' }
}

/** 探测仓库是否有 Docker 相关配置，并给出可用端口 */
export async function probeDocker(owner: string, repo: string): Promise<DockerProbe> {
  const result: DockerProbe = {
    hasDockerfile: false,
    hasCompose: false,
    composeFile: '',
    exposedPorts: [],
    readmeDockerRun: '',
    readmeSnippet: ''
  }

  try {
    const entries = await ghJson<Array<{ name: string; type: string }>>(
      `${API}/repos/${owner}/${repo}/contents/`
    )
    const names = entries.filter((e) => e.type === 'file').map((e) => e.name)
    const lower = names.map((n) => n.toLowerCase())

    const dockerfileIdx = lower.findIndex(
      (n) => n === 'dockerfile' || n.startsWith('dockerfile.') || n === 'containerfile'
    )
    if (dockerfileIdx >= 0) {
      result.hasDockerfile = true
      try {
        const content = await ghText(
          `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(names[dockerfileIdx])}`,
          'application/vnd.github.raw'
        )
        const ports = new Set<number>()
        for (const m of content.matchAll(/^\s*EXPOSE\s+(.+)$/gim)) {
          for (const p of m[1].split(/\s+/)) {
            const n = parseInt(p.replace(/\/.*$/, ''), 10)
            if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n)
          }
        }
        result.exposedPorts = [...ports].slice(0, 8)
      } catch {
        /* ignore */
      }
    }

    const composeIdx = lower.findIndex(
      (n) =>
        n === 'docker-compose.yml' ||
        n === 'docker-compose.yaml' ||
        n === 'compose.yml' ||
        n === 'compose.yaml'
    )
    if (composeIdx >= 0) {
      result.hasCompose = true
      result.composeFile = names[composeIdx]
    }
  } catch {
    /* 仓库可能为空或私有 */
  }

  if (!result.hasDockerfile && !result.hasCompose) {
    const md = await readme(owner, repo)
    if (md) {
      const { cmd, snippet } = extractDockerRun(md)
      result.readmeDockerRun = cmd
      result.readmeSnippet = snippet
      // 从 docker run -p 8080:80 提取端口
      const m = cmd.match(/-p\s+(\d+):(\d+)/)
      if (m) result.exposedPorts = [Number(m[1])]
    }
  }

  return result
}

function scoreAsset(name: string): { score: number; kind: ReleaseAsset['kind'] } {
  const n = name.toLowerCase()
  let score = 0
  let kind: ReleaseAsset['kind'] = 'other'

  if (n.endsWith('.exe')) {
    kind = 'installer'
    score += 10
    if (/setup|installer|install|安装/.test(n)) {
      score += 6
      kind = 'installer'
    }
    if (/portable|standalone|no[-_]?install|免安装/.test(n)) {
      kind = 'portable'
      score += 3
    }
  } else if (/\.(zip|7z|msi)$/.test(n)) {
    kind = n.endsWith('.msi') ? 'installer' : 'archive'
    score += 4
  } else {
    return { score: -100, kind: 'other' }
  }

  if (/win(dows)?[-_.]?x?64|x64|amd64/.test(n)) score += 4
  else if (/x86_64|x86-64/.test(n)) score += 3
  if (/arm64|aarch64/.test(n)) score -= 20
  if (/ia32|win32|x86(?!_64)/.test(n) && !/x64|amd64/.test(n)) score -= 3
  if (/\.(blockmap|sig|sha256|sha512|txt|json)$/.test(n)) score -= 100

  return { score, kind }
}

export async function releases(owner: string, repo: string): Promise<ReleaseInfo | null> {
  let data: any
  try {
    data = await ghJson<any>(`${API}/repos/${owner}/${repo}/releases/latest`)
  } catch {
    // latest 不存在时尝试拉 release 列表
    try {
      const list = await ghJson<any[]>(`${API}/repos/${owner}/${repo}/releases?per_page=1`)
      if (!list?.length) return null
      data = list[0]
    } catch {
      return null
    }
  }

  const assets: ReleaseAsset[] = (data.assets || [])
    .map((a: any) => {
      const { score, kind } = scoreAsset(a.name)
      return {
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
        recommended: false,
        kind,
        _score: score
      } as ReleaseAsset & { _score: number }
    })
    .filter((a: any) => a._score > -50)
    .sort((a: any, b: any) => b._score - a._score)

  // 只把最高分的那个（且是 exe/msi）标记为推荐
  const top = assets[0] as any
  if (top && top._score > 0 && (top.name.toLowerCase().endsWith('.exe') || top.name.toLowerCase().endsWith('.msi'))) {
    top.recommended = true
  }
  for (const a of assets) delete (a as any)._score

  return {
    tagName: data.tag_name || '',
    publishedAt: data.published_at || '',
    htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases`,
    assets
  }
}

/** 判断仓库根目录是否存在某文件（备用能力） */
export async function hasFile(owner: string, repo: string, file: string): Promise<boolean> {
  return exists(`${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}`)
}
