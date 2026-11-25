/**
 * WSL / Docker 环境诊断。
 *
 * 思路：先在本机跑一批只读探测命令（wsl.exe 的多种调用方式、注册表、服务状态、
 * WSL 内部的 docker 探测），把「命令 + 退出码 + 原始输出」作为证据。
 * 证据够用就本地规则出结论；配置了 AI 时再把证据交给模型，由它给出更贴近实际的
 * 判断和修复命令。
 *
 * 注意：AI 不执行任何命令。它只能在白名单里点名「还想看哪几项探测」，
 * 由主进程执行固定的只读命令后回传，避免模型输出被当成 shell 执行。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { execWslCapture, decodeWslBuffer } from './shell'
import { chatJson } from './llm'
import { loadSettings } from './settings'
import type { DistroInfo, EnvIssue, EnvReport, ProbeStep } from '../../shared/env'

/** 单条输出最多保留多少字符（注册表可能很长） */
const MAX_OUT = 1600
/** 塞进 prompt 的每条输出上限 */
const MAX_PROMPT_OUT = 700

interface Capture {
  code: number | null
  out: string
}

function sys32(name: string): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32', name)
}

function clip(text: string, max = MAX_OUT): string {
  const t = text.replace(/\0/g, '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n…（输出过长，已截断 ${t.length - max} 字符）`
}

/** 跑一个 Windows 命令，统一拿到退出码和合并输出 */
function runCapture(exe: string, args: string[], timeoutMs = 10000): Promise<Capture> {
  return new Promise((resolve) => {
    let settled = false
    let text = ''
    const chunks: Buffer[] = []
    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      if (!text) text = decodeWslBuffer(Buffer.concat(chunks))
      resolve({ code, out: clip(text) })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } })
    } catch (err: any) {
      resolve({ code: -2, out: `无法启动 ${exe}：${String(err?.message || err)}` })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      text = decodeWslBuffer(Buffer.concat(chunks))
      done(-1)
    }, timeoutMs)

    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.stderr?.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', (err: any) => {
      clearTimeout(timer)
      text = `无法启动 ${exe}：${String(err?.message || err)}`
      done(-2)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code)
    })
  })
}

// ---------------------------------------------------------------- 探测定义

const INNER_SCRIPT = `
echo "@@UNAME@@ $(uname -sr 2>&1 | head -n1)"
echo "@@DISTRO@@ \${WSL_DISTRO_NAME:-unknown}"
echo "@@SYSTEMD@@ $(ps -p 1 -o comm= 2>&1 | head -n1)"
echo "@@DOCKERBIN@@ $(command -v docker 2>/dev/null || echo none)"
if command -v docker >/dev/null 2>&1; then
  echo "@@DOCKERVER@@ $(docker --version 2>&1 | head -n1)"
  echo "@@COMPOSE@@ $(docker compose version 2>&1 | head -n1)"
  echo "@@DOCKERINFO@@ $(timeout 8 docker info --format '{{.ServerVersion}}' 2>&1 | head -n1)"
  echo "@@DOCKERPS@@ $(timeout 8 docker ps --format '{{.Names}}' 2>&1 | head -n2 | tr '\\n' ',')"
else
  echo "@@DOCKERVER@@ none"
  echo "@@COMPOSE@@ none"
  echo "@@DOCKERINFO@@ none"
  echo "@@DOCKERPS@@ none"
fi
echo "@@GROUPS@@ $(id -Gn 2>&1 | head -n1)"
echo "@@GIT@@ $(git --version 2>&1 | head -n1)"
`

interface ProbeDef {
  id: string
  label: string
  cmd: string
  /** 第一轮不跑，只在常规探测失败后由 AI 点名补充 */
  optional?: boolean
  run: () => Promise<Capture>
}

const PROBES: ProbeDef[] = [
  {
    id: 'wsl-list-v',
    label: '列出发行版（含状态与版本）',
    cmd: 'wsl.exe -l -v',
    run: () => runCapture('wsl.exe', ['-l', '-v'], 10000)
  },
  {
    id: 'wsl-list-q',
    label: '列出发行版（纯名称）',
    cmd: 'wsl.exe -l -q',
    run: () => runCapture('wsl.exe', ['-l', '-q'], 10000)
  },
  {
    id: 'wsl-status',
    label: 'WSL 整体状态',
    cmd: 'wsl.exe --status',
    run: () => runCapture('wsl.exe', ['--status'], 10000)
  },
  {
    id: 'wsl-version',
    label: 'WSL 版本信息',
    cmd: 'wsl.exe --version',
    run: () => runCapture('wsl.exe', ['--version'], 10000)
  },
  {
    id: 'wsl-where',
    label: '定位 wsl.exe 路径',
    cmd: 'where.exe wsl.exe',
    run: () => runCapture(sys32('where.exe'), ['wsl.exe'], 6000)
  },
  {
    id: 'wsl-file',
    label: 'System32 下是否存在 wsl.exe',
    cmd: 'fs.existsSync(%SystemRoot%\\System32\\wsl.exe)',
    run: async () => {
      const p = sys32('wsl.exe')
      const exists = fs.existsSync(p)
      let size = 0
      try {
        size = exists ? fs.statSync(p).size : 0
      } catch {
        /* ignore */
      }
      return { code: exists ? 0 : 1, out: exists ? `${p}（${size} 字节）` : `${p} 不存在` }
    }
  },
  {
    id: 'wsl-registry',
    label: '注册表中的发行版登记信息',
    cmd: 'reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss /s',
    run: () =>
      runCapture(
        sys32('reg.exe'),
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'],
        12000
      )
  },
  {
    id: 'lxss-service',
    label: 'LxssManager 服务状态',
    cmd: 'sc.exe query LxssManager',
    run: () => runCapture(sys32('sc.exe'), ['query', 'LxssManager'], 6000)
  },
  {
    id: 'wsl-inner',
    label: '在默认发行版里探测 docker / git',
    cmd: 'wsl.exe -- bash -lc <探测脚本>',
    run: async () => {
      const r = await execWslCapture(INNER_SCRIPT, { timeoutMs: 25000 })
      const out = clip([r.stdout, r.stderr].filter(Boolean).join('\n'))
      return { code: r.code, out: out || '（没有拿到任何输出）' }
    }
  },
  // ---------- 以下为补充探测，按需执行 ----------
  {
    id: 'wsl-appx',
    label: '已安装的 WSL 相关应用包',
    cmd: 'powershell -c "Get-AppxPackage *Linux*"',
    optional: true,
    run: () =>
      runCapture(
        sys32('WindowsPowerShell\\v1.0\\powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-AppxPackage | Where-Object { $_.Name -match 'Linux|Ubuntu|Debian|SUSE|Kali|WSL' } | Select-Object Name,Version | Format-Table -AutoSize | Out-String -Width 200"
        ],
        20000
      )
  },
  {
    id: 'docker-win',
    label: 'Windows 侧是否装了 Docker',
    cmd: 'where.exe docker.exe',
    optional: true,
    run: () => runCapture(sys32('where.exe'), ['docker.exe'], 6000)
  },
  {
    id: 'wslconfig',
    label: '.wslconfig 内容',
    cmd: 'type %USERPROFILE%\\.wslconfig',
    optional: true,
    run: async () => {
      const p = path.join(process.env.USERPROFILE || '', '.wslconfig')
      try {
        const t = fs.readFileSync(p, 'utf-8')
        return { code: 0, out: `${p}\n${t}` }
      } catch (err: any) {
        return { code: 1, out: `读取失败：${String(err?.message || err)}` }
      }
    }
  },
  {
    id: 'wsl-docker-ps',
    label: 'WSL 里 docker 能否正常连上守护进程',
    cmd: 'wsl.exe -- docker ps',
    optional: true,
    run: async () => {
      const r = await execWslCapture('docker ps 2>&1 | head -n 10; echo "exit=$?"', {
        timeoutMs: 20000
      })
      return { code: r.code, out: clip([r.stdout, r.stderr].filter(Boolean).join('\n')) }
    }
  }
]

const PROBE_MAP: Record<string, ProbeDef> = Object.fromEntries(PROBES.map((p) => [p.id, p]))

// ---------------------------------------------------------------- 结果解析

export interface Facts {
  exeFound: boolean
  /** wsl 命令行是否正常回应（能列出东西或给出可读提示） */
  cliResponded: boolean
  /** 命令行被拦/无法启动的迹象 */
  blocked: boolean
  distros: DistroInfo[]
  defaultName: string
  markers: Record<string, string>
  innerOk: boolean
  /** 是否成功判断出 docker 情况 */
  dockerKnown: boolean
}

export function parseMarkers(out: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^@@([A-Z]+)@@\s?(.*)$/)
    if (m) map[m[1]] = m[2].trim()
  }
  return map
}

export function parseListV(out: string): { name: string; state: string; version: string; isDefault: boolean }[] {
  const rows: { name: string; state: string; version: string; isDefault: boolean }[] = []
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/\0/g, '').replace(/\s+$/, '')
    if (!line.trim()) continue
    if (/^\s*NAME\s+STATE/i.test(line)) continue
    const m = line.match(/^(\*)?\s*(\S+)\s+([A-Za-z]+)\s+(\d)\s*$/)
    if (m) rows.push({ isDefault: !!m[1], name: m[2], state: m[3], version: m[4] })
  }
  return rows
}

export function parseListQ(out: string): string[] {
  return out
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => !!s && !/^docker-desktop/i.test(s) && !/^-{3,}/.test(s))
}

interface RegEntry {
  guid: string
  name: string
  version?: string
  basePath?: string
}

export function parseRegistry(out: string): { entries: RegEntry[]; defaultGuid: string } {
  const entries: RegEntry[] = []
  let defaultGuid = ''
  // 每一段以 "HKEY_" 开头的键块，首行是完整键路径
  for (const raw of out.replace(/\0/g, '').split(/^HKEY_/m)) {
    const block = `HKEY_${raw}`
    const header = block.split(/\r?\n/)[0] || ''
    const guid = header.match(/\{([0-9a-fA-F-]{8,})\}\s*$/)
    if (!guid) {
      // 根键：里面可能登记了默认发行版
      const m = block.match(/DefaultDistribution\s+REG_SZ\s+\{([0-9a-fA-F-]+)\}/)
      if (m) defaultGuid = `{${m[1]}}`
      continue
    }
    const name = block.match(/DistributionName\s+REG_SZ\s+(\S.*)/)
    if (!name) continue
    const ver = block.match(/Version\s+REG_DWORD\s+0x(\d+)/)
    const base = block.match(/BasePath\s+REG_SZ\s+(\S.*)/)
    entries.push({
      guid: `{${guid[1]}}`,
      name: name[1].trim(),
      version: ver ? String(parseInt(ver[1], 16)) : undefined,
      basePath: base ? base[1].trim() : undefined
    })
  }
  return { entries, defaultGuid }
}

/** 把各探测结果揉成一份可判断的事实 */
export function buildFacts(steps: ProbeStep[]): Facts {
  const byId = (id: string): ProbeStep | undefined => steps.find((s) => s.id === id)
  const listV = byId('wsl-list-v')
  const listQ = byId('wsl-list-q')
  const status = byId('wsl-status')
  const version = byId('wsl-version')
  const file = byId('wsl-file')
  const reg = byId('wsl-registry')
  const inner = byId('wsl-inner')

  const blockedTexts = [listV, listQ, status, version].map((s) => s?.out || '').join('\n')
  const blocked =
    /EPERM|EACCES|拒绝访问|Access is denied|无法启动|spawn|ENOENT|blocked|不允许/i.test(blockedTexts) ||
    [listV, listQ].some((s) => s && (s.code === -2 || s.code === -1))

  const exeFound = !!file?.ok || /wsl\.exe/i.test(byId('wsl-where')?.out || '')

  // 发行版：注册表最可靠，其次 wsl -l -v，最后 wsl -l -q
  const distros: DistroInfo[] = []
  const seen = new Set<string>()
  const add = (d: DistroInfo): void => {
    const key = d.name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    distros.push(d)
  }

  const regInfo = parseRegistry(reg?.out || '')
  const regDefaultName =
    regInfo.entries.find((e) => regInfo.defaultGuid && e.guid.toLowerCase() === regInfo.defaultGuid.toLowerCase())
      ?.name || ''
  for (const e of regInfo.entries) {
    add({
      name: e.name,
      isDefault: !!regDefaultName && e.name === regDefaultName,
      version: e.version,
      docker: 'unknown',
      from: '注册表'
    })
  }

  const rows = parseListV(listV?.ok ? listV.out : '')
  for (const r of rows) {
    const hit = distros.find((d) => d.name.toLowerCase() === r.name.toLowerCase())
    if (hit) {
      hit.version = hit.version || r.version
      hit.state = r.state
      hit.isDefault = r.isDefault || hit.isDefault
      hit.from = 'wsl -l -v'
    } else {
      add({ name: r.name, isDefault: r.isDefault, version: r.version, state: r.state, docker: 'unknown', from: 'wsl -l -v' })
    }
  }

  if (!distros.length && listQ?.ok) {
    for (const n of parseListQ(listQ.out)) {
      add({ name: n, isDefault: distros.length === 0, docker: 'unknown', from: 'wsl -l -q' })
    }
  }

  // 默认发行版：* 标记 > 注册表 DefaultDistribution > 第一个
  let defaultName = distros.find((d) => d.isDefault)?.name || ''
  if (!defaultName && regDefaultName) {
    defaultName = regDefaultName
    const hit = distros.find((d) => d.name === regDefaultName)
    if (hit) hit.isDefault = true
  }
  if (!defaultName && distros.length) {
    defaultName = distros[0].name
    distros[0].isDefault = true
  }

  const markers = parseMarkers(inner?.ok ? inner.out : '')
  const innerOk = inner?.ok === true && Object.keys(markers).length > 0
  const dockerBin = markers.DOCKERBIN || ''
  const dockerKnown = innerOk && !!dockerBin
  if (dockerKnown) {
    const has = dockerBin !== 'none'
    const running = !!markers.DOCKERINFO && !/cannot connect|permission denied|is the docker daemon running|error/i.test(markers.DOCKERINFO)
    for (const d of distros) {
      d.docker = has ? (running ? 'yes' : 'unknown') : 'no'
      if (has) d.dockerVersion = markers.DOCKERVER && markers.DOCKERVER !== 'none' ? markers.DOCKERVER : ''
      d.compose = !!markers.COMPOSE && !/unknown|not found|none/i.test(markers.COMPOSE)
    }
  }

  const cliResponded =
    !!listV?.ok || !!listQ?.ok || (!!defaultName && distros.length > 0) || !!status?.ok

  // docker-desktop / docker-desktop-data 是 Docker Desktop 的内部发行版，不展示给用户
  const internal = /^docker-desktop/i
  const external = distros.filter((d) => !internal.test(d.name))
  const visible = external.length ? external : distros
  if (!visible.some((d) => d.name === defaultName) && visible.length) {
    defaultName = visible[0].name
    visible.forEach((d) => (d.isDefault = d.name === defaultName))
  }

  return {
    exeFound,
    cliResponded,
    blocked,
    distros: visible,
    defaultName,
    markers,
    innerOk,
    dockerKnown
  }
}

// ---------------------------------------------------------------- 本地规则结论

function dockerIssue(f: Facts): EnvIssue | null {
  if (!f.innerOk) return null
  const bin = f.markers.DOCKERBIN || ''
  const info = f.markers.DOCKERINFO || ''
  const groups = f.markers.GROUPS || ''

  if (!bin || bin === 'none') {
    return {
      level: 'warn',
      title: '这个发行版里没有安装 Docker',
      detail: `在 ${f.defaultName || '默认发行版'} 里找不到 docker 命令。Docker 部署必须先在里面装好 Docker。`,
      fix: 'curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER'
    }
  }
  if (/permission denied/i.test(info) || /permission denied/i.test(f.markers.DOCKERPS || '')) {
    return {
      level: 'warn',
      title: '当前用户没有 Docker 权限',
      detail: 'docker 已安装，但普通用户不在 docker 组里，需要 sudo 或把用户加入 docker 组后重开终端。',
      fix: 'sudo usermod -aG docker $USER'
    }
  }
  if (/cannot connect|is the docker daemon running|refused/i.test(info)) {
    return {
      level: 'error',
      title: 'Docker 守护进程没在运行',
      detail: '客户端在，但连不上 dockerd。WSL 里常见原因是没启用 systemd，或服务没启动。',
      fix: 'sudo service docker start'
    }
  }
  if (groups && !/\bdocker\b/.test(groups)) {
    return {
      level: 'info',
      title: '当前用户不在 docker 组',
      detail: `已加入的组：${groups}。不加 docker 组也能用，但每条 docker 命令都要 sudo。`,
      fix: 'sudo usermod -aG docker $USER'
    }
  }
  return null
}

export function buildLocalReport(f: Facts, steps: ProbeStep[]): EnvReport {
  const issues: EnvIssue[] = []

  if (!f.exeFound) {
    issues.push({
      level: 'error',
      title: '没有找到 wsl.exe',
      detail:
        '这台机器看起来没有安装 WSL（或者 System32 下被清理过）。GitFinder 的 Docker 部署完全依赖 WSL，需要先装好 WSL 和至少一个发行版。',
      fix: 'wsl --install'
    })
  } else if (!f.cliResponded) {
    if (f.blocked) {
      issues.push({
        level: 'error',
        title: 'wsl.exe 存在，但调用被拦截或无法启动',
        detail:
          '命令没有正常返回，输出里出现了权限或启动失败的信息。常见原因：杀毒软件/安全软件拦截、组策略限制、或程序以受限用户身份运行。可以先用管理员身份的 PowerShell 手动执行 "wsl -l -v" 验证。',
        fix: 'wsl -l -v'
      })
    } else {
      issues.push({
        level: 'error',
        title: 'wsl.exe 有响应，但没列出任何发行版',
        detail: 'WSL 组件在，但没有可用的发行版。装一个发行版之后才能在里面跑 Docker。',
        fix: 'wsl --install -d Ubuntu'
      })
    }
  }

  const dock = dockerIssue(f)
  if (dock) issues.push(dock)

  if (f.innerOk && !dock) {
    const ver2 = f.distros.some((d) => d.version === '2')
    if (!ver2 && f.distros.length) {
      issues.push({
        level: 'warn',
        title: '发行版是 WSL1',
        detail: 'WSL1 跑不了 Linux 的 Docker 守护进程，需要把发行版升级到 WSL2。',
        fix: `wsl --set-version ${f.defaultName || 'Ubuntu'} 2`
      })
    }
    if (f.markers.SYSTEMD && f.markers.SYSTEMD !== 'systemd') {
      issues.push({
        level: 'info',
        title: 'WSL 里没有启用 systemd',
        detail: `1 号进程是 ${f.markers.SYSTEMD}。不启用 systemd 也能用 docker service 启动，但重启 WSL 后要重新起。`,
        fix: 'sudo service docker start'
      })
    }
  }

  const dockerBin = f.markers.DOCKERBIN || ''
  const dockerVersion = f.markers.DOCKERVER && f.markers.DOCKERVER !== 'none' ? f.markers.DOCKERVER : ''
  const composeOk = !!f.markers.COMPOSE && !/unknown|not found|none/i.test(f.markers.COMPOSE)
  const available = f.dockerKnown && dockerBin !== 'none'

  const parts: string[] = []
  if (f.distros.length) {
    parts.push(
      `检测到 ${f.distros.length} 个 WSL 发行版（${f.distros.map((d) => d.name).join('、')}），默认 ${f.defaultName || '未知'}`
    )
  } else if (f.cliResponded) {
    parts.push('WSL 可用，但没有检测到发行版')
  } else {
    parts.push('没能确认 WSL 环境（详见下方探测记录）')
  }
  if (available) {
    parts.push(`WSL 内 Docker 可用${dockerVersion ? `（${dockerVersion}）` : ''}${composeOk ? '，compose 也已安装' : '，但没有 docker compose'}`)
  } else if (f.innerOk) {
    parts.push('WSL 内没有可用的 Docker')
  }

  return {
    at: Date.now(),
    source: 'local',
    wslInstalled: f.exeFound && f.cliResponded,
    wslExeFound: f.exeFound,
    distros: f.distros,
    suggestDistro: f.defaultName || f.distros[0]?.name || '',
    docker: {
      available,
      version: dockerVersion,
      compose: composeOk,
      note: f.innerOk
        ? available
          ? '可以正常用 docker 部署'
          : '发行版里没有可用的 docker'
        : '没能进入 WSL 内部探测，Docker 情况未知'
    },
    issues,
    summary: parts.join('；') + '。',
    steps
  }
}

// ---------------------------------------------------------------- AI 诊断

function evidenceText(f: Facts, steps: ProbeStep[]): string {
  const lines: string[] = []
  lines.push(`平台：${process.platform} ${process.arch}，Electron ${process.versions.electron}`)
  lines.push(
    `本地规则初判：exeFound=${f.exeFound} cliResponded=${f.cliResponded} blocked=${f.blocked} innerOk=${f.innerOk} distros=${f.distros.map((d) => d.name).join('/') || '无'}`
  )
  lines.push('')
  lines.push('探测记录：')
  for (const s of steps) {
    lines.push(`### ${s.id} — ${s.label}`)
    lines.push(`$ ${s.cmd}`)
    lines.push(`exit=${s.code}`)
    const body = (s.out || '').replace(/\r/g, '').trim()
    lines.push(body ? body.slice(0, MAX_PROMPT_OUT) : '(无输出)')
    lines.push('')
  }
  return lines.join('\n')
}

const AI_SYSTEM = `你是 Windows 平台 WSL 与 Docker 的环境诊断工程师。用户会给你一组在本机实际执行过的探测记录（命令、退出码、原始输出）。

你的任务：
1. 判断这台机器上 WSL 是否安装、装了哪些发行版、哪个是默认发行版；
2. 判断默认发行版里 Docker 与 docker compose 是否可用、能否连通守护进程；
3. 找出会阻碍「在 WSL 里用 Docker 部署项目」的问题，并给出准确的修复办法。

硬性要求：
- 只能依据探测记录下结论，禁止脑补路径、版本号、发行版名称。
- 证据不足的字段填 "unknown"，不要猜。
- 如果还需要看别的东西，把这些探测的 id 放进 needMore（只能从下方清单里选），不要再请求别的命令。
- 修复命令写成用户可直接复制执行的一条命令；Windows 侧命令和 WSL 内命令要区分清楚（WSL 内的命令前面带 sudo 等原样写）。
- 全部输出中文，语气直接，不要客套话。

可补充探测清单（needMore 只能填这些 id）：
${PROBES.filter((p) => p.optional)
  .map((p) => `- ${p.id}：${p.label}（${p.cmd}）`)
  .join('\n')}

返回 JSON，结构如下（不要加任何额外字段）：
{
  "wslInstalled": true,
  "distros": [{ "name": "Ubuntu", "isDefault": true, "version": "2", "docker": "yes|no|unknown", "dockerVersion": "27.3.1", "note": "一句话" }],
  "suggestDistro": "Ubuntu",
  "docker": { "available": true, "version": "27.3.1", "compose": true, "note": "一句话说明能不能用" },
  "issues": [{ "level": "error|warn|info", "title": "短标题", "detail": "原因说明", "fix": "可复制执行的命令" }],
  "summary": "两句话说清现状和下一步",
  "needMore": []
}`

async function askAi(f: Facts, steps: ProbeStep[], round: number): Promise<any> {
  const user =
    evidenceText(f, steps) +
    (round > 1
      ? '\n\n这是补充探测后的第二轮，请直接给最终结论，needMore 返回空数组。'
      : '\n\n请给出结论。如果上面的记录已足够，needMore 返回空数组。')
  return chatJson(
    [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: user }
    ],
    { temperature: 0.1, maxTokens: 1400, timeoutMs: 90000 }
  )
}

function normalizeLevel(v: any): EnvIssue['level'] {
  const s = String(v || '').toLowerCase()
  if (s === 'error' || s === 'warn' || s === 'info') return s
  return 'info'
}

function mergeAiReport(base: EnvReport, ai: any, steps: ProbeStep[]): EnvReport {
  const distros: DistroInfo[] = Array.isArray(ai?.distros)
    ? ai.distros
        .filter((d: any) => d && typeof d.name === 'string' && d.name.trim())
        .slice(0, 20)
        .map((d: any) => ({
          name: String(d.name).trim(),
          isDefault: !!d.isDefault,
          version: d.version ? String(d.version) : undefined,
          state: undefined,
          docker: ['yes', 'no', 'unknown'].includes(String(d.docker)) ? String(d.docker) : 'unknown',
          dockerVersion: d.dockerVersion ? String(d.dockerVersion) : undefined,
          compose: typeof d.compose === 'boolean' ? d.compose : undefined,
          from: 'AI 判定'
        }))
    : []

  // AI 没给出可信发行版时，保住本地探测到的结果，避免把「检测到了」变成「什么都没有」
  let finalDistros = distros
  let note = ''
  if (!distros.length && base.distros.length) {
    finalDistros = base.distros
    note = 'AI 没能从证据里确认发行版，这里沿用本机探测的结果。'
  } else if (base.distros.length && distros.length) {
    const localNames = new Set(base.distros.map((d) => d.name.toLowerCase()))
    const onlyAi = distros.filter((d) => !localNames.has(d.name.toLowerCase()))
    if (onlyAi.length) {
      note = `AI 另外识别出：${onlyAi.map((d) => d.name).join('、')}（建议自行核对）。`
    }
  }

  const issues: EnvIssue[] = Array.isArray(ai?.issues)
    ? ai.issues
        .filter((i: any) => i && (i.title || i.detail))
        .slice(0, 8)
        .map((i: any) => ({
          level: normalizeLevel(i.level),
          title: String(i.title || '环境问题').slice(0, 60),
          detail: String(i.detail || '').slice(0, 600),
          fix: i.fix ? String(i.fix).slice(0, 400) : undefined
        }))
    : []

  // Docker 结论优先信本地探测（它来自真实命令输出），AI 只补说明
  const aiDocker = ai?.docker || {}
  const docker = { ...base.docker }
  if (base.docker.available) {
    docker.note = aiDocker.note ? String(aiDocker.note) : base.docker.note
    if (aiDocker.version && !docker.version) docker.version = String(aiDocker.version)
    if (typeof aiDocker.compose === 'boolean') docker.compose = aiDocker.compose || docker.compose
  } else if (base.docker.note.includes('没能进入')) {
    // 本地进不去 WSL，只能听 AI 的判断
    docker.available = !!aiDocker.available
    docker.version = aiDocker.version ? String(aiDocker.version) : ''
    docker.compose = !!aiDocker.compose
    docker.note = aiDocker.note ? String(aiDocker.note) : base.docker.note
  } else if (aiDocker.note) {
    docker.note = String(aiDocker.note)
  }

  const suggest =
    (typeof ai?.suggestDistro === 'string' && ai.suggestDistro.trim()) ||
    finalDistros.find((d) => d.isDefault)?.name ||
    finalDistros[0]?.name ||
    base.suggestDistro

  const summaryParts = [String(ai?.summary || base.summary).trim()]
  if (note) summaryParts.push(note)
  if (!issues.length && base.issues.length) summaryParts.push('AI 未列出额外问题，请参考本机探测记录。')

  return {
    ...base,
    source: 'ai',
    wslInstalled: typeof ai?.wslInstalled === 'boolean' ? ai.wslInstalled || base.wslInstalled : base.wslInstalled,
    distros: finalDistros,
    suggestDistro: suggest,
    docker,
    issues: issues.length ? issues : base.issues,
    summary: summaryParts.filter(Boolean).join(' '),
    steps
  }
}

// ---------------------------------------------------------------- 对外入口

/** 跑一批探测并返回记录；extraIds 用于第二轮补充 */
async function runProbes(ids: string[]): Promise<ProbeStep[]> {
  const steps: ProbeStep[] = []
  for (const id of ids) {
    const def = PROBE_MAP[id]
    if (!def) continue
    let r: Capture
    try {
      r = await def.run()
    } catch (err: any) {
      r = { code: -2, out: `探测异常：${String(err?.message || err)}` }
    }
    steps.push({
      id: def.id,
      label: def.label,
      cmd: def.cmd,
      code: r.code,
      ok: r.code === 0 && !!r.out.trim() && !/^无法启动/.test(r.out),
      out: r.out
    })
  }
  return steps
}

export interface DiagnoseOptions {
  /** false = 只用规则，不调用 AI */
  useAi?: boolean
}

export async function diagnose(opts: DiagnoseOptions = {}): Promise<EnvReport> {
  const primary = PROBES.filter((p) => !p.optional).map((p) => p.id)
  let steps = await runProbes(primary)
  let facts = buildFacts(steps)
  const local = buildLocalReport(facts, steps)

  if (opts.useAi === false) return local

  const aiReady = !!loadSettings().ai.apiKey
  if (!aiReady) {
    return {
      ...local,
      aiNote: '还没配置 AI Key，上面是纯规则推断的结果。到「AI 润色」里填一个 Key 后，可以让 AI 结合探测记录给出更具体的排查建议。'
    }
  }

  try {
    let ai = await askAi(facts, steps, 1)
    const want: string[] = Array.isArray(ai?.needMore)
      ? ai.needMore
          .map((x: any) => String(x))
          .filter((x) => PROBE_MAP[x]?.optional)
          .slice(0, 3)
      : []

    if (want.length) {
      const extra = await runProbes(want)
      steps = [...steps, ...extra]
      facts = buildFacts(steps)
      ai = await askAi(facts, steps, 2)
    }

    const merged = mergeAiReport(local, ai, steps)
    return { ...merged, extraProbes: want.length ? want : undefined }
  } catch (err: any) {
    return { ...local, aiNote: `AI 诊断失败：${String(err?.message || err)}。下面仍是本机探测的结果。` }
  }
}

/** 只列发行版（设置页下拉用），逐级降级：-l -q → -l -v → 注册表 */
export async function listDistros(): Promise<string[]> {
  const q = await runCapture('wsl.exe', ['-l', '-q'], 8000)
  if (q.code === 0) {
    const list = parseListQ(q.out)
    if (list.length) return list
  }

  const v = await runCapture('wsl.exe', ['-l', '-v'], 8000)
  if (v.code === 0) {
    const rows = parseListV(v.out)
    if (rows.length) return [...new Set(rows.map((r) => r.name))]
  }

  const reg = await runCapture(
    sys32('reg.exe'),
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'],
    10000
  )
  if (reg.code === 0) {
    const { entries } = parseRegistry(reg.out)
    const names = entries.map((e) => e.name).filter((n) => !/^docker-desktop/i.test(n))
    if (names.length) return [...new Set(names)]
  }
  return []
}
