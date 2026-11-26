/** 主进程与渲染层共享的类型定义 */

import type { EnvReport } from './env'

export interface AiConfig {
  /** 兼容 OpenAI 协议的 base url，如 https://api.deepseek.com */
  baseUrl: string
  apiKey: string
  model: string
  /** 是否默认启用 AI 润色 */
  enabled: boolean
  /** 是否自动为榜单项目生成中文用途与安装方式 */
  enrich: boolean
}

export interface Settings {
  githubToken: string
  /** 代理，支持 http://127.0.0.1:7890 / socks5://127.0.0.1:7891，留空走系统代理 */
  proxy: string
  ai: AiConfig
  /** WSL 发行版名称，留空则自动取默认发行版 */
  wslDistro: string
  /** WSL 内克隆项目的目录 */
  wslWorkDir: string
  /** Windows 本地安装目录默认值 */
  installDir: string
  /** exe 安装模式：silent 静默安装到指定目录 / manual 由用户点安装器 */
  installMode: 'silent' | 'manual'
  /** 搜索默认每页条数 */
  perPage: number
  /** core 配额用尽时，自动改用搜索接口的 repo: 语法兜底 */
  githubFallback: boolean
}

/** 某一类 GitHub 接口的配额 */
export interface QuotaBucket {
  limit: number
  used: number
  remaining: number
  /** 重置时间（Unix 秒） */
  reset: number
}

export interface QuotaInfo {
  /** 配额真的按登录账号算了（以服务端 limit 为准，不是看本地有没有填） */
  authenticated: boolean
  /** 本地填了 Token，但服务端仍按未登录给额度——通常是 Token 无效或过期 */
  tokenInvalid: boolean
  /** core：仓库详情 / README / Release 等 */
  core: QuotaBucket
  /** search：搜索与榜单 */
  search: QuotaBucket
  graphql: QuotaBucket | null
  at: number
  note: string
}

export interface AiPolishResult {
  /** 最终送给 GitHub 的 q 参数 */
  query: string
  language: string
  sort: 'stars' | 'forks' | 'updated' | 'best-match'
  order: 'desc' | 'asc'
  /** 模型对这次改写的一句话解释 */
  explain: string
  /** 模型补充的推荐关键词 */
  keywords: string[]
}

export interface SearchParams {
  q: string
  language?: string
  sort?: 'stars' | 'forks' | 'updated' | 'best-match'
  order?: 'desc' | 'asc'
  perPage?: number
  page?: number
}

export interface RepoItem {
  id: number
  full_name: string
  owner: string
  name: string
  html_url: string
  description: string
  language: string
  stars: number
  forks: number
  open_issues: number
  updated_at: string
  pushed_at: string
  created_at: string
  topics: string[]
  license: string
  archived: boolean
  default_branch: string
  homepage: string
  /** 中文画像；搜索结果的简介翻译也复用它（purpose 即中文一句话） */
  profile?: RepoProfile
}

export interface SearchResponse {
  total: number
  items: RepoItem[]
  rateRemaining: number | null
  rateReset: number | null
  /** 实际发给 GitHub 的原始 q（用于排查） */
  rawQuery: string
}

/** 一种安装 / 使用方式 */
export interface InstallOption {
  /** docker / compose / installer / portable / package / hosted / source / plugin / library */
  kind: string
  /** 2~6 字短标签，如「Docker」「npm」「Windows 安装包」 */
  label: string
  /** 可执行命令或补充说明 */
  detail?: string
}

/** 仓库中文画像：讲清它到底能干什么、怎么装 */
export interface RepoProfile {
  /** 一句话中文用途；为空表示尚未生成（界面回退到英文简介） */
  purpose: string
  /** 中文领域标签，如「自托管阅读器」 */
  category: string
  /** 支持的平台 */
  platforms: string[]
  installs: InstallOption[]
  /** 上手难度：简单 / 中等 / 较难 */
  level: string
  /** 是否可直接用本工具一键 Docker 部署 */
  deployable?: boolean
  /** ai = 模型生成；heuristic = 仅依据仓库元数据推测 */
  source: 'ai' | 'heuristic'
  at: number
}

/** 送给画像模块的最小仓库信息 */
export interface ProfileInput {
  full_name: string
  description: string
  language: string
  topics: string[]
  stars: number
  archived: boolean
  pushed_at?: string
}

/** AI 画像流式回传 */
export interface ProfileUpdateEvent {
  /** 请求方传入的标识（通常是 boardId），用于丢弃过期批次 */
  scope?: string
  /** 已完成条数与总数 */
  finished: number
  total: number
  /** 本批新增的画像，按 full_name 索引 */
  profiles: Record<string, RepoProfile>
  done: boolean
  /** 出错时的说明（其余条目会回退到元数据推测） */
  error?: string
}

/** 榜单里的一条记录：在 RepoItem 基础上补充榜单位次与涨星指标 */
/** README 读取结果：把「真的没有」和「读不到」分开 */
export interface ReadmeResult {
  ok: boolean
  text: string
  /** raw 直连不耗配额，api 走 GitHub 接口 */
  source: 'raw' | 'api' | ''
  /** 实际命中的文件名，如 README.md */
  fileName: string
  code: '' | 'not-found' | 'rate-limit' | 'network' | 'auth'
  message: string
  hint: string
}

/** README 翻译结果 */
export interface TranslateResult {
  ok: boolean
  text: string
  /** 分段数量 */
  chunks: number
  /** 是否命中本地缓存（命中的不花 token） */
  cached: boolean
  message: string
}

export interface BoardItem extends RepoItem {
  rank: number
  /** 涨星数（GitHub 官方口径或本地采样） */
  starDelta?: number
  /** 涨星口径：github = 官方 trending 统计；local = 本机采样差值 */
  deltaSource?: 'github' | 'local'
  /** 涨星窗口（天） */
  deltaWindow?: number
  /** 额外的展示指标，如「平均 +82 星/天」 */
  extra?: string
  /** 项目年龄（天），潜力榜用 */
  ageDays?: number
  /** 中文画像（未配置 AI 时只含推测的安装方式） */
  profile?: RepoProfile
}

export interface BoardResult {
  boardId: string
  items: BoardItem[]
  /** 数据抓取时间戳 */
  fetchedAt: number
  /** 是否命中缓存 */
  cached: boolean
  source: 'github-trending' | 'github-search' | 'local'
  /** 数据口径说明 */
  note: string
  /** 实际上报给 GitHub 的查询（排查用） */
  rawQuery: string
  rateRemaining: number | null
}

export interface BoardQuery {
  boardId: string
  language?: string
  /** trending 榜内部的排序方式 */
  orderBy?: 'delta' | 'stars'
  /** 跳过缓存强制刷新 */
  refresh?: boolean
}

export interface TrackState {
  fullNames: string[]
}

export interface DockerProbe {
  hasDockerfile: boolean
  hasCompose: boolean
  composeFile: string
  /** Dockerfile 里声明的 EXPOSE 端口 */
  exposedPorts: number[]
  /** README 中提取出的 docker run 命令（降级方案） */
  readmeDockerRun: string
  readmeSnippet: string
}

export interface DeployPlan {
  fullName: string
  cloneUrl: string
  distro: string
  workDir: string
  dirName: string
  mode: 'compose' | 'dockerfile' | 'manual'
  composeFile: string
  imageName: string
  containerName: string
  hostPort: number
  containerPort: number
  extraArgs: string
  manualCommand: string
  /** 生成的可读脚本，供用户在界面上确认 */
  script: string
}

export interface DeployLogEvent {
  taskId: string
  stream: 'stdout' | 'stderr' | 'system'
  line: string
}

export interface DeployDoneEvent {
  taskId: string
  ok: boolean
  code: number | null
}

/** 拉取目标：Windows 本地目录 / WSL 内目录 */
export type CloneTarget = 'windows' | 'wsl'

/** 目录已存在时的处理方式 */
export type CloneExistsMode = 'update' | 'fail' | 'new'

export interface CloneOptions {
  fullName: string
  target: CloneTarget
  /** windows: 父目录绝对路径；wsl: 父目录，可用 ~/xxx */
  parentDir: string
  /** 目标文件夹名，默认用仓库名 */
  dirName?: string
  /** 分支 / 标签，留空用默认分支 */
  branch?: string
  /** 浅克隆深度，0 表示完整历史 */
  depth: number
  /** 递归拉取子模块 */
  submodules: boolean
  /** 是否使用设置里配置的代理 */
  useProxy: boolean
  onExists: CloneExistsMode
}

export interface ClonePlan {
  fullName: string
  cloneUrl: string
  target: CloneTarget
  parentDir: string
  dirName: string
  destDir: string
  /** 给资源管理器用的路径：windows 原样；wsl 为 \\wsl$\发行版\... */
  displayPath: string
  branch: string
  depth: number
  submodules: boolean
  useProxy: boolean
  proxyText: string
  onExists: CloneExistsMode
  /** 目标是否已存在 */
  exists: boolean
  /** 已存在且是 git 仓库（update 模式会 pull） */
  isRepo: boolean
  /** 实际会执行的动作 */
  action: 'clone' | 'update'
  /** wsl: bash 脚本；windows: 等价命令预览 */
  script: string
  distro: string
  /** 环境提示，如「WSL 内没有 git」 */
  warning: string
}

export interface CloneLogEvent {
  taskId: string
  stream: 'stdout' | 'stderr' | 'system'
  line: string
}

export interface CloneDoneEvent {
  taskId: string
  ok: boolean
  code: number | null
  destDir: string
  action: 'clone' | 'update'
}

export interface GitAvailability {
  windows: boolean
  windowsVersion: string
  wsl: boolean
  wslVersion: string
}

export interface ReleaseAsset {
  name: string
  size: number
  downloadUrl: string
  /** 是否被判定为推荐的 Windows 安装包 */
  recommended: boolean
  kind: 'installer' | 'portable' | 'archive' | 'other'
}

export interface ReleaseInfo {
  tagName: string
  publishedAt: string
  htmlUrl: string
  assets: ReleaseAsset[]
}

export interface InstallProgressEvent {
  taskId: string
  received: number
  total: number
  percent: number
  phase: 'download' | 'install' | 'done'
}

export interface InstallDoneEvent {
  taskId: string
  ok: boolean
  message: string
  filePath?: string
}

export interface AppInfo {
  version: string
  electron: string
  platform: string
  userData: string
}

/** 前端通过 window.api 调用的完整契约 */
export interface Api {
  app: {
    info: () => Promise<AppInfo>
    openExternal: (url: string) => Promise<void>
    openPath: (p: string) => Promise<string>
  }
  settings: {
    get: () => Promise<Settings>
    save: (patch: Partial<Settings>) => Promise<Settings>
    pickDir: (title: string) => Promise<string | null>
    applyProxy: () => Promise<{ ok: boolean; message: string }>
  }
  ai: {
    polish: (text: string) => Promise<AiPolishResult>
    test: () => Promise<{ ok: boolean; message: string }>
    /** 把 README 译成中文，只在用户点击时调用 */
    translate: (input: { text: string; fullName?: string }) => Promise<TranslateResult>
  }
  github: {
    search: (params: SearchParams) => Promise<SearchResponse>
    /** 失败不抛错，用 code 区分「没有 README」和「配额/网络读不到」 */
    readme: (owner: string, repo: string, branch?: string) => Promise<ReadmeResult>
    probeDocker: (owner: string, repo: string) => Promise<DockerProbe>
    releases: (owner: string, repo: string) => Promise<ReleaseInfo | null>
    /** 查询当前接口配额（core / search 两个独立池子） */
    quota: () => Promise<QuotaInfo>
    /** 保存前验证一个 Token 是否真的被 GitHub 认（不消耗配额） */
    verifyToken: (token: string) => Promise<{ ok: boolean; limit: number; message: string }>
  }
  deploy: {
    plan: (input: {
      fullName: string
      mode: 'compose' | 'dockerfile' | 'manual'
      hostPort: number
      containerPort: number
      imageName: string
      extraArgs: string
      manualCommand?: string
    }) => Promise<DeployPlan>
    run: (plan: DeployPlan) => Promise<{ taskId: string }>
    stop: (taskId: string, distro?: string) => Promise<void>
    wslDistros: () => Promise<string[]>
    containers: () => Promise<{ ok: boolean; output: string }>
  }
  board: {
    fetch: (query: BoardQuery) => Promise<BoardResult>
    tracked: () => Promise<string[]>
    toggleTrack: (fullName: string, stars?: number) => Promise<string[]>
    clearCache: () => Promise<number>
    /** 后台补齐中文画像，结果通过 onBoardProfiles 流式回传 */
    enrich: (input: {
      items: ProfileInput[]
      scope?: string
      /** 忽略已有缓存，强制重新生成 */
      force?: boolean
    }) => Promise<{ total: number; cached: number; pending: number; ai: boolean }>
    clearProfiles: () => Promise<number>
  }
  install: {
    download: (input: {
      url: string
      fileName: string
      mode: 'silent' | 'manual'
      installDir: string
    }) => Promise<{ taskId: string }>
    cancel: (taskId: string) => Promise<void>
  }
  clone: {
    /** 生成拉取计划（校验路径、检测目标是否已存在） */
    plan: (input: CloneOptions) => Promise<ClonePlan>
    run: (plan: ClonePlan) => Promise<{ taskId: string }>
    cancel: (taskId: string) => Promise<void>
    /** 在资源管理器里打开拉取到的目录 */
    reveal: (plan: ClonePlan) => Promise<{ ok: boolean; message: string }>
    /** 检测 Windows 与 WSL 各自的 git 是否可用 */
    checkGit: () => Promise<GitAvailability>
    /** 默认父目录建议 */
    defaults: () => Promise<{ windows: string; wsl: string; distro: string }>
  }
  env: {
    /** 探测 WSL / Docker 环境；useAi 为 false 时只用本地规则 */
    diagnose: (opts?: { useAi?: boolean }) => Promise<EnvReport>
  }
  events: {
    onDeployLog: (cb: (e: DeployLogEvent) => void) => () => void
    onDeployDone: (cb: (e: DeployDoneEvent) => void) => () => void
    onCloneLog: (cb: (e: CloneLogEvent) => void) => () => void
    onCloneDone: (cb: (e: CloneDoneEvent) => void) => () => void
    onInstallProgress: (cb: (e: InstallProgressEvent) => void) => () => void
    onInstallDone: (cb: (e: InstallDoneEvent) => void) => () => void
    onBoardProfiles: (cb: (e: ProfileUpdateEvent) => void) => () => void
  }
}
