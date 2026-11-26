import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runWindowsExe } from './shell'
import type { ManagedAppItem, ManagedDockerItem, ManagedItem } from '../../shared/types'

/**
 * 已安装程序 / 已部署服务的本地台账。
 * 只记 GitFinder 自己装过、部署过的东西，磁盘上是 userData/managed.json，方便用户直接看和备份。
 */

const VERSION = 1

interface Store {
  version: number
  items: ManagedItem[]
}

function file(): string {
  return path.join(app.getPath('userData'), 'managed.json')
}

function read(): Store {
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.items)) return { version: VERSION, items: [] }
    return { version: VERSION, items: data.items.filter((i: any) => i && i.id && i.kind) }
  } catch {
    return { version: VERSION, items: [] }
  }
}

function write(store: Store): void {
  const target = file()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(store, null, 2), 'utf8')
  } catch (err) {
    console.error('[managed] 写入失败', err)
  }
}

export function listItems(): ManagedItem[] {
  return read().items.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getItem(id: string): ManagedItem | null {
  return read().items.find((i) => i.id === id) || null
}

export function removeItem(id: string): void {
  const store = read()
  store.items = store.items.filter((i) => i.id !== id)
  write(store)
}

export function replaceAll(items: ManagedItem[]): void {
  write({ version: VERSION, items })
}

function upsert(item: ManagedItem): ManagedItem {
  const store = read()
  const i = store.items.findIndex((x) => x.id === item.id)
  if (i >= 0) store.items[i] = item
  else store.items.unshift(item)
  write(store)
  return item
}

/* ------------------------------------------------------------------
 * Windows 已安装程序
 * ---------------------------------------------------------------- */

export function appId(fullName: string, installDir: string): string {
  return `app:${fullName.toLowerCase()}@${installDir.toLowerCase()}`
}

/** 目录里挑主程序和卸载器：名字像仓库名的优先，其次挑最大的 exe */
export function scanAppDir(
  dir: string,
  repoName: string
): { exePath: string; uninstaller: string; sizeMb: number } {
  const empty = { exePath: '', uninstaller: '', sizeMb: 0 }
  if (!dir || !fs.existsSync(dir)) return empty

  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const want = norm(repoName)
  const exes: { file: string; size: number }[] = []
  let uninstaller = ''
  let total = 0

  const walk = (cur: string, depth: number): void => {
    if (depth > 2) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        // 跳过明显不是程序本体的目录
        if (/^(node_modules|resources|locales|swiftshader|\.git)$/i.test(e.name)) continue
        walk(full, depth + 1)
        continue
      }
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      total += size
      if (!/\.exe$/i.test(e.name)) continue
      const base = e.name.toLowerCase()
      if (/^unins|uninstall/.test(base)) {
        if (!uninstaller || depth <= 1) uninstaller = full
        continue
      }
      if (/^(update|squirrel|crashpad|elevate|notification|createdump)\.exe$/.test(base)) continue
      exes.push({ file: full, size })
    }
  }
  walk(dir, 0)

  let exePath = ''
  if (exes.length) {
    const scored = exes
      .map((e) => {
        const b = norm(path.basename(e.file, '.exe'))
        let score = 0
        if (want && (b === want || b.includes(want) || want.includes(b))) score += 1000
        return { ...e, score: score + Math.min(e.size / 1024 / 1024, 200) }
      })
      .sort((a, b) => b.score - a.score)
    exePath = scored[0].file
  }

  return {
    exePath,
    uninstaller,
    sizeMb: Math.round((total / 1024 / 1024) * 10) / 10
  }
}

interface RegistryHit {
  displayName: string
  version: string
  uninstaller: string
  quietUninstall: string
}

/** 从注册表卸载项里按安装目录反查卸载器（比按名字猜安全） */
export async function registryLookup(dir: string): Promise<RegistryHit | null> {
  if (process.platform !== 'win32' || !dir) return null
  const tmp = path.join(app.getPath('temp'), `gitfinder-uninst-${randomUUID().slice(0, 8)}.json`)
  const psDir = dir.replace(/'/g, "''")
  const psTmp = tmp.replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$dir='${psDir}'.TrimEnd('\\').ToLower()`,
    "$keys='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    '$hit = Get-ItemProperty $keys | Where-Object {',
    "  $loc = ''; if ($_.InstallLocation) { $loc = $_.InstallLocation }",
    "  $icon = ''; if ($_.DisplayIcon) { $icon = $_.DisplayIcon }",
    "  $un = ''; if ($_.UninstallString) { $un = $_.UninstallString }",
    "  ($loc -and $loc.TrimEnd('\\').ToLower().StartsWith($dir)) -or",
    "  ($icon -and $icon.ToLower().StartsWith($dir)) -or",
    "  ($un -and $un.ToLower().Contains($dir))",
    '} | Select-Object -First 1 DisplayName,DisplayVersion,UninstallString,QuietUninstallString',
    `if ($hit) { $hit | ConvertTo-Json -Compress | Out-File -FilePath '${psTmp}' -Encoding utf8 }`
  ].join('\n')

  const r = await runWindowsExe('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ])
  if (!r.ok) return null
  try {
    const raw = fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '').trim()
    fs.unlinkSync(tmp)
    if (!raw) return null
    const j = JSON.parse(raw)
    return {
      displayName: String(j.DisplayName || ''),
      version: String(j.DisplayVersion || ''),
      uninstaller: parseCommand(j.UninstallString).exe,
      quietUninstall: String(j.QuietUninstallString || '')
    }
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    return null
  }
}

/** 把注册表里的命令行拆成 exe + 参数（支持带引号路径） */
export function parseCommand(cmd: string): { exe: string; args: string[] } {
  const s = String(cmd || '').trim()
  if (!s) return { exe: '', args: [] }
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 0) {
      return { exe: s.slice(1, end), args: s.slice(end + 1).trim().split(/\s+/).filter(Boolean) }
    }
  }
  const m = s.match(/^(.*?\.exe)(\s+.*)?$/i)
  if (m) return { exe: m[1], args: (m[2] || '').trim().split(/\s+/).filter(Boolean) }
  const parts = s.split(/\s+/)
  return { exe: parts[0], args: parts.slice(1) }
}

export interface AppSaveInput {
  fullName: string
  name: string
  version: string
  installDir: string
  sourceUrl: string
  fileName: string
  installerKind: ManagedAppItem['installerKind']
  manual: boolean
}

/** 安装完成后落账；同一仓库 + 同一目录视为「更新」，保留首次安装时间 */
export function saveApp(input: AppSaveInput): ManagedAppItem {
  const now = Date.now()
  const id = appId(input.fullName, input.installDir || '(unknown)')
  const old = getItem(id)
  const scanned = input.installDir ? scanAppDir(input.installDir, input.name) : { exePath: '', uninstaller: '', sizeMb: 0 }
  const item: ManagedAppItem = {
    kind: 'app',
    id,
    fullName: input.fullName,
    name: input.name,
    version: input.version,
    installDir: input.installDir,
    exePath: scanned.exePath,
    uninstaller: scanned.uninstaller,
    quietUninstall: '',
    installerKind: input.installerKind,
    sourceUrl: input.sourceUrl,
    fileName: input.fileName,
    manual: input.manual,
    installedAt: old && old.kind === 'app' ? old.installedAt : now,
    updatedAt: now,
    state: input.manual && !input.installDir ? 'manual' : 'installed',
    displayName: '',
    latestVersion: '',
    updateAvailable: false,
    sizeMb: scanned.sizeMb
  }
  upsert(item)
  return item
}

/** 手动安装后补指定目录：重扫主程序、卸载器 */
export function attachAppDir(id: string, dir: string): ManagedItem | null {
  const cur = getItem(id)
  if (!cur || cur.kind !== 'app') return null
  const scanned = scanAppDir(dir, cur.name)
  const next: ManagedAppItem = {
    ...cur,
    installDir: dir,
    exePath: scanned.exePath,
    uninstaller: scanned.uninstaller,
    sizeMb: scanned.sizeMb,
    manual: false,
    state: scanned.exePath ? 'installed' : 'missing',
    updatedAt: Date.now()
  }
  return upsert(next)
}

/* ------------------------------------------------------------------
 * Docker 服务
 * ---------------------------------------------------------------- */

export function dockerId(dir: string): string {
  return `docker:${dir}`
}

export interface DockerSaveInput {
  fullName: string
  name: string
  mode: ManagedDockerItem['mode']
  distro: string
  dir: string
  dirName: string
  imageName: string
  containerName: string
  hostPort: number
  containerPort: number
  extraArgs: string
  composeFile: string
}

export function saveDocker(input: DockerSaveInput): ManagedItem {
  const now = Date.now()
  const id = dockerId(input.dir)
  const old = getItem(id)
  const item: ManagedDockerItem = {
    kind: 'docker',
    id,
    fullName: input.fullName,
    name: input.name,
    mode: input.mode,
    distro: input.distro,
    dir: input.dir,
    dirName: input.dirName,
    imageName: input.imageName,
    containerName: input.containerName,
    hostPort: input.hostPort,
    containerPort: input.containerPort,
    extraArgs: input.extraArgs,
    composeFile: input.composeFile,
    installedAt: old ? old.installedAt : now,
    updatedAt: now,
    state: 'unknown',
    statusText: '',
    image: '',
    containers: [],
    sizeMb: 0
  }
  return upsert(item)
}

export function updateDockerRuntime(
  id: string,
  patch: Partial<Pick<ManagedDockerItem, 'state' | 'statusText' | 'image' | 'containers' | 'sizeMb'>>
): void {
  const cur = getItem(id)
  if (!cur || cur.kind !== 'docker') return
  upsert({ ...cur, ...patch })
}

export function updateAppRuntime(
  id: string,
  patch: Partial<
    Pick<
      ManagedAppItem,
      'state' | 'displayName' | 'latestVersion' | 'updateAvailable' | 'sizeMb' | 'exePath' | 'uninstaller'
    >
  >
): void {
  const cur = getItem(id)
  if (!cur || cur.kind !== 'app') return
  upsert({ ...cur, ...patch })
}

/** 版本号比较：去掉 v 前缀和构建元数据，逐段数字比大小；解析不出来就判不等 */
export function isNewerVersion(latest: string, current: string): boolean {
  const norm = (v: string): number[] =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n))
  const a = norm(latest)
  const b = norm(current)
  if (!a.length || !b.length) return !!latest && latest !== current
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}
