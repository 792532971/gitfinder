import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { execWslCapture, runWindowsExe } from '../lib/shell'
import { loadSettings } from '../lib/settings'
import * as store from '../lib/managed'
import { releases } from './github'
import { installPackage } from './installer'
import type {
  ManagedAction,
  ManagedAppItem,
  ManagedDockerItem,
  ManagedItem,
  ManagedActionResult
} from '../../shared/types'

/** bash 单引号安全包裹 */
function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** 只截取尾部，避免把几分钟的构建日志全塞进 IPC */
function tail(text: string, max = 6000): string {
  const t = String(text || '').trim()
  return t.length > max ? `…（前面省略）\n${t.slice(-max)}` : t
}

function assertManageableDir(dir: string): string {
  const d = String(dir || '').trim()
  if (!d || !d.startsWith('/')) throw new Error('目录异常，拒绝操作')
  const bad = ['/', '/home', '/root', '/home/', '/root/', '$HOME', '~']
  if (bad.includes(d)) throw new Error('目录异常，拒绝操作')
  if (d.includes('..')) throw new Error('目录含 ..，拒绝操作')
  return d
}

/* ------------------------------------------------------------------
 * 列表 + 状态探测
 * ---------------------------------------------------------------- */

interface ContainerRow {
  name: string
  state: string
  status: string
  image: string
  project: string
}

const PS_LIST = `docker ps -a --format '{{.Names}}\\t{{.State}}\\t{{.Status}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project"}}' 2>/dev/null`

function parseContainers(raw: string): ContainerRow[] {
  return String(raw || '')
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 5 && p[0].trim())
    .map((p) => ({
      name: p[0].trim(),
      state: (p[1] || '').trim(),
      status: (p[2] || '').trim(),
      image: (p[3] || '').trim(),
      project: (p[4] || '').trim()
    }))
}

/** 一次 WSL 调用，把某个发行版里的容器列表和各目录大小都拿回来 */
async function dockerSnapshot(
  distro: string,
  dirs: string[]
): Promise<{ docker: boolean; containers: ContainerRow[]; sizes: Map<string, number>; gone: Set<string> }> {
  const sizes = new Map<string, number>()
  const gone = new Set<string>()
  if (!dirs.length) {
    const r = await execWslCapture(
      `if ! command -v docker >/dev/null 2>&1; then echo "NO_DOCKER"; exit 0; fi\n${PS_LIST}`,
      { distro: distro || undefined, timeoutMs: 20000 }
    )
    return {
      docker: !r.stdout.includes('NO_DOCKER'),
      containers: parseContainers(r.stdout),
      sizes,
      gone
    }
  }

  const script = [
    'if ! command -v docker >/dev/null 2>&1; then echo "NO_DOCKER"; else',
    PS_LIST,
    'fi',
    'for d in ' + dirs.map(q).join(' '),
    'do',
    '  if [ -d "$d" ]; then echo "SIZE|$d|$(du -sm "$d" 2>/dev/null | cut -f1)"; else echo "GONE|$d|0"; fi',
    'done'
  ].join('\n')

  const r = await execWslCapture(script, { distro: distro || undefined, timeoutMs: 30000 })
  const lines = r.stdout.split(/\r?\n/)
  const containerLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('SIZE|')) {
      const [, d, mb] = line.split('|')
      sizes.set(d, Number(mb) || 0)
    } else if (line.startsWith('GONE|')) {
      gone.add(line.split('|')[1])
    } else if (line.trim()) {
      containerLines.push(line)
    }
  }
  return {
    docker: !r.stdout.includes('NO_DOCKER'),
    containers: parseContainers(containerLines.join('\n')),
    sizes,
    gone
  }
}

function matchContainers(item: ManagedDockerItem, all: ContainerRow[]): ContainerRow[] {
  if (item.mode === 'compose') {
    return all.filter(
      (c) =>
        c.project === item.dirName ||
        c.project === item.dirName.toLowerCase() ||
        c.name.startsWith(`${item.dirName}-`) ||
        c.name.startsWith(`${item.dirName}_`)
    )
  }
  return all.filter((c) => c.name === item.containerName)
}

/** 最新版本查询缓存：刷新状态时不必每次都打 GitHub API */
const updateCache = new Map<string, { at: number; latest: string }>()
const UPDATE_TTL = 5 * 60 * 1000

async function refreshApp(item: ManagedAppItem): Promise<ManagedAppItem> {
  const next: ManagedAppItem = { ...item }
  const hasDir = !!item.installDir && fs.existsSync(item.installDir)

  if (!item.installDir) {
    next.state = 'manual'
    next.sizeMb = 0
  } else if (!hasDir) {
    next.state = 'missing'
    next.sizeMb = 0
  } else {
    const scanned = store.scanAppDir(item.installDir, item.name)
    if (scanned.exePath) next.exePath = scanned.exePath
    if (scanned.uninstaller) next.uninstaller = scanned.uninstaller
    next.sizeMb = scanned.sizeMb
    // 目录在但找不到主程序：手动安装的让用户再指定目录，静默安装的说明装失败了
    next.state = scanned.exePath ? 'installed' : item.manual ? 'manual' : 'missing'
  }

  // 目录里没有卸载器时，去注册表按安装路径反查（顺带拿到显示名与真实版本）
  if (hasDir && !next.uninstaller) {
    const hit = await store.registryLookup(item.installDir)
    if (hit) {
      next.uninstaller = hit.uninstaller || next.uninstaller
      next.displayName = hit.displayName || next.displayName
      if (hit.version && !item.version) next.version = hit.version
    }
  }

  if (item.fullName) {
    const cached = updateCache.get(item.fullName)
    if (cached && Date.now() - cached.at < UPDATE_TTL) {
      next.latestVersion = cached.latest
      next.updateAvailable = store.isNewerVersion(cached.latest, item.version || '')
    } else {
      try {
        const [owner, repo] = item.fullName.split('/')
        const r = await releases(owner, repo)
        if (r?.tagName) {
          updateCache.set(item.fullName, { at: Date.now(), latest: r.tagName })
          next.latestVersion = r.tagName
          next.updateAvailable = store.isNewerVersion(r.tagName, item.version || '')
        }
      } catch {
        /* 查不到最新版不影响管理 */
      }
    }
  }
  return next
}

export async function list(): Promise<ManagedItem[]> {
  const items = store.listItems()
  const out: ManagedItem[] = []

  const dockerItems = items.filter((i): i is ManagedDockerItem => i.kind === 'docker')
  const byDistro = new Map<string, ManagedDockerItem[]>()
  for (const d of dockerItems) {
    const key = d.distro || ''
    if (!byDistro.has(key)) byDistro.set(key, [])
    byDistro.get(key)!.push(d)
  }

  const snapshots = new Map<string, Awaited<ReturnType<typeof dockerSnapshot>>>()
  for (const [distro, list] of byDistro) {
    snapshots.set(distro, await dockerSnapshot(distro, list.map((i) => i.dir)))
  }

  for (const item of items) {
    if (item.kind === 'app') {
      try {
        out.push(await refreshApp(item))
      } catch {
        // 单条探测失败不影响整页：保持上次记录的状态
        out.push(item)
      }
      continue
    }
    const snap = snapshots.get(item.distro || '')
    const next: ManagedDockerItem = { ...item }
    if (snap) {
      const rows = matchContainers(item, snap.containers)
      next.containers = rows.map((r) => r.name)
      next.statusText = rows.map((r) => r.status).join(' / ')
      next.image = rows[0]?.image || ''
      if (!snap.docker) {
        next.state = 'unknown'
        next.statusText = '当前 WSL 发行版里没有 docker'
      } else if (!rows.length) {
        next.state = 'missing'
        next.statusText = next.statusText || '容器不存在（可能被手动删除）'
      } else if (rows.some((r) => r.state.toLowerCase() === 'running')) {
        next.state = 'running'
      } else {
        next.state = 'exited'
      }
      const size = snap.sizes.get(item.dir)
      next.sizeMb = snap.gone.has(item.dir) ? 0 : size || next.sizeMb || 0
      if (snap.gone.has(item.dir)) next.state = 'missing'
    }
    out.push(next)
  }

  store.replaceAll(out)
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/* ------------------------------------------------------------------
 * Docker 操作
 * ---------------------------------------------------------------- */

function dcPrelude(): string {
  return [
    'if docker compose version >/dev/null 2>&1; then DC="docker compose";',
    'elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose";',
    'else echo "❌ 没有可用的 docker compose"; exit 3; fi'
  ].join('\n')
}

function runDocker(dir: string, body: string, distro: string, timeoutMs = 300000): Promise<{ ok: boolean; output: string }> {
  const d = assertManageableDir(dir)
  const script = [
    'set -uo pipefail',
    'if ! command -v docker >/dev/null 2>&1; then echo "❌ 当前 WSL 发行版里没有 docker"; exit 127; fi',
    `cd ${q(d)} || { echo "❌ 目录不存在：${d.replace(/"/g, '')}"; exit 2; }`,
    body
  ].join('\n')
  return execWslCapture(script, { distro: distro || undefined, timeoutMs }).then((r) => ({
    ok: r.code === 0,
    output: tail([r.stdout, r.stderr].filter(Boolean).join('\n'))
  }))
}

function dockerAction(item: ManagedDockerItem, action: ManagedAction): Promise<{ ok: boolean; output: string }> {
  const dir = item.dir
  const distro = item.distro

  if (item.mode === 'compose') {
    const head = dcPrelude()
    switch (action) {
      case 'start':
        return runDocker(dir, `${head}\n$DC start 2>&1 | tail -n 20 || $DC up -d 2>&1 | tail -n 40`, distro)
      case 'stop':
        return runDocker(dir, `${head}\n$DC stop 2>&1 | tail -n 20`, distro, 120000)
      case 'restart':
        return runDocker(dir, `${head}\n$DC restart 2>&1 | tail -n 20`, distro, 180000)
      case 'update':
        return runDocker(
          dir,
          [
            head,
            'echo "[1/3] 更新代码..."',
            'git pull --ff-only 2>&1 | tail -n 8 || echo "⚠️ git 更新失败，继续使用现有代码"',
            'echo "[2/3] 拉取镜像..."',
            '$DC pull 2>&1 | tail -n 20 || true',
            'echo "[3/3] 重新构建并启动..."',
            '$DC up -d --build 2>&1 | tail -n 60'
          ].join('\n'),
          distro
        )
      case 'uninstall':
        return runDocker(
          dir,
          [
            head,
            'echo "[1/2] 停止并移除容器、网络、数据卷..."',
            '$DC down -v --remove-orphans 2>&1 | tail -n 30',
            'echo "[2/2] 删除项目目录..."',
            `cd .. && rm -rf ${q(item.dirName)} && echo "✅ 已删除 ${item.dir}"`
          ].join('\n'),
          distro,
          180000
        )
      default:
        return Promise.resolve({ ok: false, output: '不支持的操作' })
    }
  }

  // dockerfile 单容器模式：用记录里的参数重建
  const port = `${item.hostPort}:${item.containerPort}`
  const extra = item.extraArgs ? ` ${item.extraArgs}` : ''
  const image = item.imageName || item.containerName
  switch (action) {
    case 'start':
      return runDocker(dir, `docker start ${q(item.containerName)} 2>&1 | tail -n 10`, distro, 60000)
    case 'stop':
      return runDocker(dir, `docker stop ${q(item.containerName)} 2>&1 | tail -n 10`, distro, 60000)
    case 'restart':
      return runDocker(dir, `docker restart ${q(item.containerName)} 2>&1 | tail -n 10`, distro, 90000)
    case 'update':
      return runDocker(
        dir,
        [
          'echo "[1/4] 更新代码..."',
          'git pull --ff-only 2>&1 | tail -n 8 || echo "⚠️ git 更新失败，继续使用现有代码"',
          'echo "[2/4] 重新构建镜像..."',
          `docker build -t ${q(image)} . 2>&1 | tail -n 40 || { echo "❌ 镜像构建失败"; exit 4; }`,
          'echo "[3/4] 替换容器..."',
          `docker rm -f ${q(item.containerName)} >/dev/null 2>&1 || true`,
          'echo "[4/4] 启动..."',
          `docker run -d --name ${q(item.containerName)} --restart unless-stopped -p ${port}${extra} ${q(image)} 2>&1 | tail -n 10`
        ].join('\n'),
        distro
      )
    case 'uninstall':
      return runDocker(
        dir,
        [
          'echo "[1/3] 停止并删除容器..."',
          `docker rm -f ${q(item.containerName)} >/dev/null 2>&1 || true`,
          'echo "[2/3] 删除镜像..."',
          `docker rmi ${q(image)} >/dev/null 2>&1 || true`,
          'echo "[3/3] 删除项目目录..."',
          `cd .. && rm -rf ${q(item.dirName)} && echo "✅ 已删除 ${item.dir}"`
        ].join('\n'),
        distro,
        120000
      )
    default:
      return Promise.resolve({ ok: false, output: '不支持的操作' })
  }
}

/* ------------------------------------------------------------------
 * Windows 程序操作
 * ---------------------------------------------------------------- */

function waitGone(dir: string, ms: number): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      if (!fs.existsSync(dir)) return resolve(true)
      if (Date.now() - start > ms) return resolve(false)
      setTimeout(tick, 600)
    }
    tick()
  })
}

async function uninstallApp(item: ManagedAppItem): Promise<ManagedActionResult> {
  if (!item.installDir || !fs.existsSync(item.installDir)) {
    store.removeItem(item.id)
    return { ok: true, message: '安装目录已不存在，已从列表移除', changed: true }
  }

  let exe = ''
  let args: string[] = []
  if (item.quietUninstall) {
    const parsed = store.parseCommand(item.quietUninstall)
    exe = parsed.exe
    args = parsed.args
  }
  if (!exe) exe = item.uninstaller
  if (!exe) {
    const hit = await store.registryLookup(item.installDir)
    if (hit?.quietUninstall) {
      const parsed = store.parseCommand(hit.quietUninstall)
      exe = parsed.exe
      args = parsed.args
    } else if (hit?.uninstaller) {
      exe = hit.uninstaller
    }
  }
  if (!exe) {
    throw new Error(
      '没找到卸载程序。可以点「打开目录」手动运行 Uninstall.exe，或用 Windows「应用和功能」卸载后回到这里移除记录。'
    )
  }

  if (!args.length) args = item.installerKind === 'squirrel' ? ['--uninstall'] : ['/S']
  const r = await runWindowsExe(exe, args, { detached: true })
  if (!r.ok) throw new Error(r.message)

  // 静默卸载会另起一个进程，只能轮询目录判断是否真的删掉了
  const gone = await waitGone(item.installDir, 25000)
  if (gone) {
    store.removeItem(item.id)
    return { ok: true, message: '已卸载，安装目录已删除', changed: true }
  }
  return {
    ok: true,
    message: '卸载程序已启动，但目录还在（可能弹了确认框或在清理残留），稍后刷新看看。',
    changed: true
  }
}

async function updateApp(item: ManagedAppItem): Promise<ManagedActionResult> {
  if (!item.fullName) throw new Error('记录里没有仓库信息，无法检查更新')
  if (!item.installDir) throw new Error('还没确认安装目录，先点「指定目录」再更新')
  const [owner, repo] = item.fullName.split('/')
  const rel = await releases(owner, repo)
  if (!rel || !rel.tagName) throw new Error('没查到 Release，可能这个项目不发版')

  if (!store.isNewerVersion(rel.tagName, item.version || '')) {
    return { ok: true, message: `已是最新版本（${item.version || rel.tagName}）` }
  }
  const asset =
    rel.assets.find((a) => a.name === item.fileName) ||
    rel.assets.find((a) => a.kind === 'installer' && /\.(exe|msi)$/i.test(a.name)) ||
    rel.assets.find((a) => a.recommended)
  if (!asset) throw new Error(`最新版 ${rel.tagName} 里没有找到可安装的 exe/msi`)

  const outcome = await installPackage({
    url: asset.downloadUrl,
    fileName: asset.name,
    mode: 'silent',
    installDir: item.installDir
  })
  if (!outcome.ok) throw new Error(outcome.message)

  store.saveApp({
    fullName: item.fullName,
    name: item.name,
    version: rel.tagName,
    installDir: item.installDir,
    sourceUrl: asset.downloadUrl,
    fileName: asset.name,
    installerKind: item.installerKind,
    manual: false
  })
  updateCache.set(item.fullName, { at: Date.now(), latest: rel.tagName })
  return { ok: true, message: `已更新到 ${rel.tagName}`, changed: true }
}

/* ------------------------------------------------------------------
 * 对外入口
 * ---------------------------------------------------------------- */

export async function action(id: string, act: ManagedAction): Promise<ManagedActionResult> {
  const item = store.getItem(id)
  if (!item) throw new Error('记录不存在，可能已经被移除')

  if (act === 'forget') {
    store.removeItem(id)
    return { ok: true, message: '已移除记录（磁盘上的文件没动）', changed: true }
  }

  if (item.kind === 'app') {
    switch (act) {
      case 'start': {
        if (!item.exePath || !fs.existsSync(item.exePath)) {
          if (item.installDir && fs.existsSync(item.installDir)) {
            await shell.openPath(item.installDir)
            return { ok: true, message: '没找到主程序，已打开安装目录' }
          }
          throw new Error('找不到主程序，可能已经卸载')
        }
        const r = await runWindowsExe(item.exePath, [], { detached: true, cwd: path.dirname(item.exePath) })
        return { ok: r.ok, message: r.ok ? '已启动' : r.message }
      }
      case 'update':
        return updateApp(item)
      case 'uninstall':
        return uninstallApp(item)
      default:
        throw new Error('这个操作只对 Docker 服务有效')
    }
  }

  // docker
  const r = await dockerAction(item, act)
  store.updateDockerRuntime(id, { statusText: r.ok ? '操作完成' : '操作失败' })
  if (act === 'uninstall' && r.ok) {
    store.removeItem(id)
    return { ok: true, message: '已卸载并删除项目目录', output: r.output, changed: true }
  }
  if (!r.ok) {
    const err: any = new Error('执行失败，详情见下方输出')
    err.hint = tail(r.output, 3000)
    throw err
  }
  return { ok: true, message: '操作完成', output: r.output, changed: true }
}

export async function logs(id: string, tailLines = 200): Promise<string> {
  const item = store.getItem(id)
  if (!item || item.kind !== 'docker') throw new Error('只能查看 Docker 服务的日志')
  const n = Math.min(Math.max(1, Number(tailLines) || 200), 1000)
  const script =
    item.mode === 'compose'
      ? [
          dcPrelude(),
          `cd ${q(assertManageableDir(item.dir))} || exit 2`,
          `$DC logs --tail ${n} --no-color 2>&1 | tail -n ${n}`
        ].join('\n')
      : `docker logs --tail ${n} ${q(item.containerName)} 2>&1`
  const r = await execWslCapture(script, { distro: item.distro || undefined, timeoutMs: 30000 })
  return tail([r.stdout, r.stderr].filter(Boolean).join('\n'), 20000) || '（没有日志输出）'
}

export async function open(id: string): Promise<void> {
  const item = store.getItem(id)
  if (!item) throw new Error('记录不存在')
  if (item.kind === 'app') {
    const target = item.installDir || (item.exePath ? path.dirname(item.exePath) : '')
    if (!target) throw new Error('还没确认安装目录')
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
    return
  }
  if (!item.hostPort) throw new Error('这条记录没有端口信息')
  await shell.openExternal(`http://localhost:${item.hostPort}`)
}

export function attachDir(id: string, dir: string): ManagedItem[] {
  const next = store.attachAppDir(id, dir)
  if (!next) throw new Error('只能给「本机应用」记录指定目录')
  return store.listItems()
}

/** 部署成功后由 deploy.ts 调用：把 WSL 里的真实绝对路径解析出来再落账 */
export async function recordDockerDeploy(plan: {
  fullName: string
  mode: 'compose' | 'dockerfile' | 'manual'
  distro: string
  workDir: string
  dirName: string
  imageName: string
  containerName: string
  hostPort: number
  containerPort: number
  extraArgs: string
  composeFile: string
}): Promise<void> {
  if (plan.mode === 'manual') return
  const workDir = (plan.workDir || '').trim() || '~/gitfinder-apps'
  const distro = (plan.distro || loadSettings().wslDistro || '').trim()
  // 展开 ~ 拿到真实路径，rm -rf / compose 操作都用它
  const r = await execWslCapture(
    `d=${q(workDir)}; d="\${d/#\\~/$HOME}"; cd "$d/${plan.dirName}" 2>/dev/null && pwd`,
    { distro: distro || undefined, timeoutMs: 15000 }
  )
  const dir = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  if (!dir.startsWith('/')) return

  store.saveDocker({
    fullName: plan.fullName,
    name: plan.fullName.split('/')[1] || plan.dirName,
    mode: plan.mode,
    distro,
    dir,
    dirName: plan.dirName,
    imageName: plan.imageName,
    containerName: plan.containerName,
    hostPort: plan.hostPort,
    containerPort: plan.containerPort,
    extraArgs: plan.extraArgs,
    composeFile: plan.composeFile
  })
}
