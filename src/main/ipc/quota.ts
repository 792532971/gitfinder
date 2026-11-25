/** GitHub 接口配额查询 */
import { request, HttpError } from '../lib/http'
import { loadSettings } from '../lib/settings'
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
 */
export async function fetchQuota(): Promise<QuotaInfo> {
  const token = (loadSettings().githubToken || '').trim()
  const resp = await request('https://api.github.com/rate_limit', { timeoutMs: 15000 })

  if (!resp.ok) {
    let body = ''
    try {
      body = await resp.text()
    } catch {
      /* ignore */
    }
    const hint =
      resp.status === 401
        ? 'Token 无效或已过期，到上面重新填一个'
        : resp.status === 403
          ? '请求被拒，检查代理是否可用'
          : '检查网络连接或代理设置'
    throw new HttpError(`读取配额失败 HTTP ${resp.status}`, resp.status, body, hint)
  }

  const data: any = await resp.json().catch(() => null)
  const res = data?.resources || {}
  const core = bucket(res.core)
  const search = bucket(res.search)

  // 用服务端给的上限判断，而不是「本地填没填」：
  // 填了个错的 Token 也会被带上去，但 GitHub 只给匿名的 60 次，这里能识破。
  const AUTHED_CORE_LIMIT = 1000
  const authenticated = !!token && core.limit >= AUTHED_CORE_LIMIT
  const tokenInvalid = !!token && core.limit < AUTHED_CORE_LIMIT

  return {
    authenticated,
    tokenInvalid,
    core,
    search,
    graphql: res.graphql ? bucket(res.graphql) : null,
    at: Date.now(),
    note: authenticated
      ? '已配置 Token，配额按账号计算'
      : tokenInvalid
        ? '填了 Token 但没生效，多半是复制少了字符或已过期——重新生成一个再填'
        : '未登录时 core 只有 60 次/小时、search 10 次/分钟，填一个 Token 能提到 5000 次/小时和 30 次/分钟'
  }
}
