/** GitHub 接口配额查询 */
import { request, HttpError, ghHeaders } from '../lib/http'
import { loadSettings, normalizeToken } from '../lib/settings'
import type { QuotaBucket, QuotaInfo } from '../../shared/types'

function bucket(raw: any): QuotaBucket {
  return {
    limit: Number(raw?.limit) || 0,
    used: Number(raw?.used) || 0,
    remaining: Number(raw?.remaining) || 0,
    reset: Number(raw?.reset) || 0
  }
}

/**
 * 读 /rate_limit。这个接口本身不消耗配额，所以可以随手刷新。
 * 注意 core 与 search 是两个独立的池子：core 管仓库详情、README、Release，
 * search 管搜索与榜单。
 *
 * 关键点：这个请求必须带上 Authorization 头。不带的话 GitHub 一律按匿名算账，
 * 返回的就是 core 60/h、search 10/min，看起来像「Token 没生效」。
 */
export async function fetchQuota(): Promise<QuotaInfo> {
  const token = normalizeToken(loadSettings().githubToken)
  const resp = await request('https://api.github.com/rate_limit', {
    headers: ghHeaders(),
    timeoutMs: 15000
  })

  if (!resp.ok) {
    let body = ''
    try {
      body = await resp.text()
    } catch {
      /* ignore */
    }
    // Token 被 GitHub 直接拒了（401）：这里不当作异常抛，而是返回「未生效」状态，
    // 让面板直接显示「Token 没生效」的引导块，用户一眼就知道该重填。
    if (resp.status === 401) {
      const zero: QuotaBucket = { limit: 0, used: 0, remaining: 0, reset: 0 }
      let why = 'Bad credentials'
      try {
        const j = JSON.parse(body)
        if (j?.message) why = String(j.message)
      } catch {
        /* ignore */
      }
      return {
        authenticated: false,
        tokenInvalid: true,
        core: zero,
        search: { ...zero },
        graphql: null,
        at: Date.now(),
        note: `GitHub 的回应：${why}（HTTP 401）`
      }
    }
    let msg = `读取配额失败 HTTP ${resp.status}`
    let hint = '检查网络连接或代理设置'
    if (resp.status === 403 || resp.status === 429) {
      hint = '请求被拒，多半是代理不通或触发了限流'
    }
    throw new HttpError(msg, resp.status, body, hint)
  }

  const data: any = await resp.json().catch(() => null)
  const res = data?.resources || {}
  const core = bucket(res.core)
  const search = bucket(res.search)

  // 用服务端给的上限判断，而不是「本地填没填」：
  // 填了个错的 Token 也会被带上去，但 GitHub 只给匿名的 60 次，这里能识破。
  const AUTHED_CORE_LIMIT = 1000
  const authenticated = !!token && core.limit >= AUTHED_CORE_LIMIT
  const tokenInvalid = !!token && !authenticated

  return {
    authenticated,
    tokenInvalid,
    core,
    search,
    graphql: res.graphql ? bucket(res.graphql) : null,
    at: Date.now(),
    note: authenticated
      ? `Token 已生效，配额按账号计算（core ${core.limit} 次/小时）`
      : tokenInvalid
        ? `服务端回的是匿名额度（core ${core.limit} 次/小时），说明这个 Token 没被认出来`
        : '未登录时 core 只有 60 次/小时、search 10 次/分钟，填一个 Token 能提到 5000 次/小时和 30 次/分钟'
  }
}

/**
 * 保存设置前先验一次表单里的 Token：有效才落盘，无效就留在弹窗里让用户改。
 * 用 /rate_limit 验证不消耗配额，也不需要额外权限。
 */
export async function verifyToken(raw: string): Promise<{
  ok: boolean
  limit: number
  message: string
}> {
  const token = normalizeToken(raw)
  if (!token) return { ok: false, limit: 0, message: '还没填 Token' }

  const resp = await request('https://api.github.com/rate_limit', {
    headers: ghHeaders({}, token),
    timeoutMs: 15000
  })

  if (resp.status === 401) {
    let why = 'Bad credentials'
    try {
      const body = await resp.text()
      const j = JSON.parse(body)
      if (j?.message) why = String(j.message)
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      limit: 0,
      message: `GitHub 拒绝了这个 Token（${why}）：无效、已过期，或者复制时少了字符`
    }
  }
  if (!resp.ok) {
    return { ok: false, limit: 0, message: `校验请求失败（HTTP ${resp.status}），检查网络或代理` }
  }

  const data: any = await resp.json().catch(() => null)
  const core = bucket(data?.resources?.core)
  if (core.limit < 1000) {
    return {
      ok: false,
      limit: core.limit,
      message: `服务端仍按未登录给你额度（core ${core.limit} 次/小时），这个 Token 没有被识别`
    }
  }
  return { ok: true, limit: core.limit, message: `Token 有效，core ${core.limit} 次/小时` }
}
