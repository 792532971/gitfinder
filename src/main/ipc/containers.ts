import { shell } from 'electron'
import { execWslCapture } from '../lib/shell'
import { loadSettings } from '../lib/settings'
import { listDistros } from '../lib/wslprobe'
import * as store from '../lib/managed'
import type {
  ContainerAction,
  ContainerActionResult,
  ContainerInfo,
  ContainerOverview,
  ContainerPort
} from '../../shared/types'

/** bash 单引号安全包裹 */
function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function tail(text: string, max = 6000): string {
  const t = String(text || '').trim()
  return t.length > max ? `…（前面省略）\n${t.slice(-max)}` : t
}

/** 容器名只允许 docker 认可的字符，避免拼进 shell 时被搞事 */
function assertName(name: string): string {
  const n = String(name || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(n)) throw new Error('容器名不合法')
  return n
}

/* ------------------------------------------------------------------
 * 采集
 * ---------------------------------------------------------------- */

const PS_FORMAT = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.Image}}',
  '{{.State}}',
  '{{.Status}}',
  '{{.Ports}}',
  '{{.CreatedAt}}',
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.service"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}',
  '{{.Label "com.docker.compose.project.config_files"}}'
].join('\\t')

const SCRIPT = [
  'if ! command -v docker >/dev/null 2>&1; then echo "NO_DOCKER"; exit 0; fi',
  'ver=$(docker info --format "{{.ServerVersion}}" 2>/dev/null) || { echo "DAEMON_DOWN"; exit 0; }',
  'echo "VERSION|$ver"',
  `docker ps -a --format '${PS_FORMAT}' 2>&1 || echo "PS_FAILED"`
].join('\n')

/** 把 "0.0.0.0:8098->80/tcp, [::]:8098->80/tcp, 9000/tcp" 拆成结构化端口 */
export function parsePorts(raw: string): ContainerPort[] {
  const out: ContainerPort[] = []
  const seen = new Set<string>()
  for (const piece of String(raw || '').split(',')) {
    const s = piece.trim()
    if (!s) continue
    const m = s.match(/^(?:\[?([0-9a-fA-F:.]*)\]?:(\d+)->)?(\d+)\/([a-z]+)$/)
    if (!m) continue
    const bind = (m[1] || '').trim()
    const host = m[2] ? Number(m[2]) : null
    const containerPort = Number(m[3])
    const protocol = m[4]
    const key = `${containerPort}/${protocol}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ bind, host, container: containerPort, protocol })
  }
  return out
}

function normalizeState(raw: string): ContainerInfo['state'] {
  const s = String(raw || '').toLowerCase()
  if (s === 'running' || s === 'exited' || s === 'paused' || s === 'restarting' || s === 'created' || s === 'dead') {
    return s
  }
  return 'unknown'
}

function shortImage(image: string): string {
  // sha256:... 这种没 tag 的用短 id 更好读
  if (/^sha256:/.test(image)) return image.slice(0, 19)
  return image
}

function parseRows(stdout: string): { containers: ContainerInfo[]; warnings: string[] } {
  const containers: ContainerInfo[] = []
  const warnings: string[] = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.startsWith('VERSION|') || line.startsWith('NO_DOCKER') || line.startsWith('DAEMON_DOWN')) continue
    if (line === 'PS_FAILED' || !line.includes('\t')) {
      warnings.push(line.slice(0, 300))
      continue
    }
    const p = line.split('\t')
    if (p.length < 11) continue
    containers.push({
      id: (p[0] || '').slice(0, 12),
      name: p[1].trim(),
      image: shortImage(p[2].trim()),
      state: normalizeState(p[3]),
      status: p[4].trim(),
      ports: parsePorts(p[5]),
      createdAt: (p[6] || '').trim(),
      project: p[7].trim(),
      service: p[8].trim(),
      workDir: p[9].trim(),
      composeFiles: p[10].trim(),
      managed: false
    })
  }
  return { containers, warnings }
}

function pickDistro(wanted: string | undefined, distros: string[]): string {
  const w = String(wanted || '').trim()
  if (w) return w
  const saved = String(loadSettings().wslDistro || '').trim()
  if (saved) return saved
  return distros[0] || ''
}

/** 发行版列表缓存：刷新容器时不必每次都重新枚举 wsl -l -q */
let distroCache: { at: number; list: string[] } | null = null

async function safeDistros(): Promise<string[]> {
  if (distroCache && Date.now() - distroCache.at < 60_000) return distroCache.list
  try {
    const list = await listDistros()
    if (list.length) distroCache = { at: Date.now(), list }
    return list
  } catch {
    return []
  }
}

/** 台账里记录过的容器名，用来在列表里标出「GitFinder 部署」 */
function managedNames(): Set<string> {
  const set = new Set<string>()
  for (const item of store.listItems()) {
    if (item.kind !== 'docker') continue
    if (item.containerName) set.add(item.containerName)
    for (const n of item.containers || []) set.add(n)
  }
  return set
}

function buildGroups(list: ContainerInfo[]): ContainerOverview['groups'] {
  const map = new Map<string, ContainerOverview['groups'][number]>()
  for (const c of list) {
    const key = c.project || ''
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: c.project || '独立容器',
        workDir: '',
        composeFiles: '',
        containers: [],
        running: 0
      })
    }
    const g = map.get(key)!
    g.containers.push(c)
    if (c.state === 'running') g.running++
    if (!g.workDir && c.workDir) g.workDir = c.workDir
    if (!g.composeFiles && c.composeFiles) g.composeFiles = c.composeFiles
  }

  const groups = [...map.values()]
  for (const g of groups) {
    g.containers.sort((a, b) => {
      // 运行中的排前面，其次按 compose service 名
      if (a.state === 'running' !== (b.state === 'running')) return a.state === 'running' ? -1 : 1
      return (a.service || a.name).localeCompare(b.service || b.name)
    })
  }
  groups.sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1
    if (b.running !== a.running) return b.running - a.running
    return b.containers.length - a.containers.length
  })
  return groups
}

export async function overview(distro?: string): Promise<ContainerOverview> {
  const distros = await safeDistros()
  const active = pickDistro(distro, distros)
  const base: ContainerOverview = {
    distro: active,
    distros,
    docker: false,
    version: '',
    groups: [],
    total: 0,
    running: 0,
    stopped: 0,
    exposedPorts: 0,
    at: Date.now(),
    error: ''
  }

  if (!active) {
    base.error = '没有检测到 WSL 发行版，请先在 Windows 里安装并启动一个'
    return base
  }

  const r = await execWslCapture(SCRIPT, { distro: active, timeoutMs: 25000 })
  const stdout = r.stdout || ''
  const stderr = (r.stderr || '').trim()

  if (stdout.includes('NO_DOCKER')) {
    base.error = `发行版「${active}」里没有安装 Docker`
    return base
  }
  if (stdout.includes('DAEMON_DOWN')) {
    base.error = `Docker 装好了但服务没在跑。在 WSL 里执行 sudo service docker start 再回来刷新`
    return base
  }
  if (!stdout.trim() && stderr) {
    base.error = stderr
    return base
  }

  base.docker = true
  const verLine = stdout.split(/\r?\n/).find((l) => l.startsWith('VERSION|'))
  base.version = verLine ? verLine.slice('VERSION|'.length).trim() : ''

  const { containers, warnings } = parseRows(stdout)
  const known = managedNames()
  for (const c of containers) c.managed = known.has(c.name)

  base.total = containers.length
  base.running = containers.filter((c) => c.state === 'running').length
  base.stopped = base.total - base.running
  base.exposedPorts = containers.reduce(
    (n, c) => n + c.ports.filter((p) => p.host).length,
    0
  )
  base.groups = buildGroups(containers)
  if (warnings.length) base.error = warnings.join('\n').slice(0, 500)
  return base
}

/* ------------------------------------------------------------------
 * 操作
 * ---------------------------------------------------------------- */

const VERBS: Record<ContainerAction, string> = {
  start: 'start',
  stop: 'stop',
  restart: 'restart',
  pause: 'pause',
  unpause: 'unpause',
  remove: 'rm -f'
}

const TEXT: Record<ContainerAction, string> = {
  start: '已启动',
  stop: '已停止',
  restart: '已重启',
  pause: '已暂停（docker unpause 可恢复）',
  unpause: '已恢复运行',
  remove: '已删除容器（镜像和数据卷没动）'
}

export async function action(input: {
  distro: string
  name: string
  action: ContainerAction
}): Promise<ContainerActionResult> {
  const name = assertName(input?.name)
  const act = input?.action
  const verb = VERBS[act]
  if (!verb) throw new Error('不支持的操作')

  const distro = String(input?.distro || '').trim() || loadSettings().wslDistro || undefined
  const r = await execWslCapture(
    [
      'if ! command -v docker >/dev/null 2>&1; then echo "❌ 当前发行版里没有 docker"; exit 127; fi',
      `docker ${verb} ${q(name)} 2>&1 | tail -n 20`
    ].join('\n'),
    { distro, timeoutMs: act === 'remove' ? 90000 : 60000 }
  )
  const output = tail([r.stdout, r.stderr].filter(Boolean).join('\n'))

  if (r.code !== 0) {
    const err: any = new Error(`docker ${verb} ${name} 失败`)
    err.hint = output || `退出码 ${r.code}`
    throw err
  }
  return { ok: true, message: `${name} ${TEXT[act] || '操作完成'}`, output }
}

export async function logs(input: { distro: string; name: string; tail?: number }): Promise<string> {
  const name = assertName(input?.name)
  const n = Math.min(Math.max(1, Number(input?.tail) || 200), 1000)
  const distro = String(input?.distro || '').trim() || loadSettings().wslDistro || undefined
  const r = await execWslCapture(`docker logs --tail ${n} --no-color ${q(name)} 2>&1`, {
    distro,
    timeoutMs: 30000
  })
  const out = tail([r.stdout, r.stderr].filter(Boolean).join('\n'), 20000)
  return out || '（没有日志输出）'
}

/** 在资源管理器里打开 compose 项目目录（\\wsl.localhost\<发行版>\<路径>） */
export async function reveal(input: { distro: string; dir: string }): Promise<void> {
  const dir = String(input?.dir || '').trim()
  if (!dir.startsWith('/') || dir.includes('..')) throw new Error('目录异常，拒绝打开')
  const distro = String(input?.distro || '').trim() || loadSettings().wslDistro || ''
  if (!distro) throw new Error('不知道是哪个发行版')
  const err = await shell.openPath(`\\\\wsl.localhost\\${distro}${dir.replace(/\//g, '\\')}`)
  if (err) throw new Error(err)
}
