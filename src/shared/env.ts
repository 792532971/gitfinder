/** WSL / Docker 环境诊断相关的共享类型 */

/** 单条探测记录：原样保留命令与输出，方便用户核对，也作为 AI 判断依据 */
export interface ProbeStep {
  id: string
  label: string
  /** 实际执行的命令（给人看的近似写法） */
  cmd: string
  /** 0 = 成功；-1 = 超时；-2 = 进程启动失败；其余为真实退出码 */
  code: number | null
  ok: boolean
  /** 已裁剪的原始输出（stdout + stderr 合并） */
  out: string
}

export interface DistroInfo {
  name: string
  isDefault: boolean
  /** WSL 版本 1 / 2 */
  version?: string
  state?: string
  /** docker 是否可用：yes / no / unknown */
  docker: 'yes' | 'no' | 'unknown'
  dockerVersion?: string
  compose?: boolean
  /** 数据来源说明，如「注册表」「wsl -l -v」「AI 推断」 */
  from?: string
}

export interface EnvIssue {
  level: 'error' | 'warn' | 'info'
  title: string
  detail: string
  /** 可复制执行的修复命令 */
  fix?: string
}

export interface EnvReport {
  at: number
  /** local = 纯规则推断；ai = AI 参与分析 */
  source: 'local' | 'ai'
  /** 是否检测到 WSL 本体 */
  wslInstalled: boolean
  /** 是否找到可执行的 wsl.exe */
  wslExeFound: boolean
  distros: DistroInfo[]
  /** 建议填入设置的发行版名 */
  suggestDistro: string
  docker: {
    available: boolean
    version: string
    compose: boolean
    note: string
  }
  issues: EnvIssue[]
  summary: string
  /** 已执行的探测记录 */
  steps: ProbeStep[]
  /** AI 认为证据不足时，额外请求执行的探测 id */
  extraProbes?: string[]
  /** AI 不可用时的说明（此时 source 为 local） */
  aiNote?: string
}
