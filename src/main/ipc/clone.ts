import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { shell, type WebContents } from 'electron'
import { loadSettings, gitProxyTarget } from '../lib/settings'
import { execWslCapture } from '../lib/shell'
import { listDistros } from '../lib/wslprobe'
import type {
  CloneOptions,
  ClonePlan,
  CloneLogEvent,
  GitAvailability
} from '../../shared/types'

const running = new Map<string, ChildProcess>()

/** bash 单引号安全包裹 */
function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function assertSafe(label: string, value: string, re: RegExp): string {
  const v = String(value || '').trim()
  if (!re.test(v)) throw new Error(`${label} 含非法字符：${v || '(空)'}`)
  return v
}

/** 目录名去掉危险字符 */
function sanitizeName(name: string, fallback: string): string {
  const v = String(name || '')
    .replace(/[\\/:*?"<>|\s]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return v || fallback
}

/** 把父目录 + 名称拼成目标绝对路径 */
function joinDest(target: 'windows' | 'wsl', parent: string, name: string): string {
  if (target === 'windows') {
    const p = parent.replace(/[\\/]+$/, '')
    return p ? `${p}\\${name}` : name
  }
  const p = parent.replace(/\/+$/, '')
  return p ? `${p}/${name}` : name
}

function validateParent(target: 'windows' | 'wsl', raw: string): string {
  const v = String(raw || '').trim()
  if (!v) throw new Error(target === 'windows' ? '请选择拉取到的目录' : '请填写 WSL 内的目录')
  if (/[\n\r\0]/.test(v)) throw new Error('目录里含有换行等非法字符')
  if (target === 'windows') {
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(v)) {
      throw new Error('Windows 目录需要是绝对路径，例如 D:\\code\\github')
    }
    return v
  }
  if (!/^(?:\/|~\/|~$|\$HOME)/.test(v)) {
    throw new Error('WSL 目录需要以 / 或 ~ 开头，例如 ~/projects')
  }
  if (/[`;|&<>]|\$\(/.test(v)) throw new Error('WSL 目录里不能有 ` ; | & < > $() 等字符')
  return v
}

// ---------------- Windows git ----------------

const GIT_CANDIDATES = [
  process.env.GITFINDER_GIT || '',
  'git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\cmd\\git.exe')
]

let gitCache: string | null = null

function tryGit(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!bin) return resolve(false)
    let out = ''
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn(bin, ['--version'], { windowsHide: true })
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0 && /git version/i.test(out)))
    } catch {
      done(false)
    }
  })
}

async function resolveWindowsGit(): Promise<string> {
  if (gitCache) return gitCache
  for (const bin of GIT_CANDIDATES) {
    if (await tryGit(bin)) {
      gitCache = bin
      return bin
    }
  }
  throw new Error(
    '本机没有找到 git.exe。请先安装 Git for Windows（https://git-scm.com/download/win），或把拉取目标改成 WSL 目录。'
  )
}

interface Captured {
  code: number | null
  stdout: string
  stderr: string
}

function capture(bin: string, args: string[], cwd?: string): Promise<Captured> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    try {
      const child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
      child.stderr?.on('data', (b: Buffer) => (err += b.toString('utf8')))
      child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: String(e?.message || e) }))
      child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
    } catch (e: any) {
      resolve({ code: -1, stdout: out, stderr: String(e?.message || e) })
    }
  })
}

// ---------------- 计划 ----------------

/** WSL 里探测 ~ 的真实路径 / 目标是否存在 / 是否 git 仓库 */
async function probeWsl(dest: string, distro: string): Promise<{
  ok: boolean
  home: string
  exists: boolean
  isRepo: boolean
  hasGit: string
  error: string
}> {
  const script = [
    'echo "HOME=$(cd ~ && pwd)"',
    `D=${q(dest)}`,
    'D="${D/#\\~/$HOME}"',
    'if [ -d "$D/.git" ]; then echo "REPO=1"; elif [ -e "$D" ]; then echo "REPO=0"; else echo "REPO=-"; fi',
    'if [ -d "$D" ]; then echo "EXISTS=1"; else echo "EXISTS=0"; fi',
    'if command -v git >/dev/null 2>&1; then echo "GIT=$(git --version)"; else echo "GIT="; fi'
  ].join('\n')
  try {
    const res = await execWslCapture(script, { distro: distro || undefined, timeoutMs: 12000 })
    const text = res.stdout || ''
    const pick = (key: string): string => {
      const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'))
      return m ? m[1].trim() : ''
    }
    const home = pick('HOME')
    const repo = pick('REPO')
    return {
      ok: true,
      home,
      exists: pick('EXISTS') === '1' || repo === '1' || repo === '0',
      isRepo: repo === '1',
      hasGit: pick('GIT'),
      error: ''
    }
  } catch (err: any) {
    return { ok: false, home: '', exists: false, isRepo: false, hasGit: '', error: String(err?.message || err) }
  }
}

/** 目录已存在且要求新建时，找一个没被占用的名字 */
async function uniqueName(
  target: 'windows' | 'wsl',
  parent: string,
  name: string,
  distro: string
): Promise<string> {
  for (let i = 2; i <= 20; i++) {
    const candidate = `${name}-${i}`
    const dest = joinDest(target, parent, candidate)
    const taken = target === 'windows' ? fs.existsSync(dest) : (await probeWsl(dest, distro)).exists
    if (!taken) return candidate
  }
  throw new Error('目标目录里同名文件夹太多了，请换一个父目录')
}

export async function plan(input: CloneOptions): Promise<ClonePlan> {
  const settings = loadSettings()
  const [owner, repo] = String(input.fullName || '').split('/')
  if (!owner || !repo) throw new Error('仓库名格式应为 owner/repo')

  const target = input.target === 'wsl' ? 'wsl' : 'windows'
  const cloneUrl = assertSafe(
    '仓库地址',
    `https://github.com/${owner}/${repo}.git`,
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/
  )
  const parentDir = validateParent(target, input.parentDir)
  const baseName = sanitizeName(input.dirName || repo, repo)
  assertSafe('目录名', baseName, /^[^\\/:*?"<>|\s]+$/)

  const branch = String(input.branch || '')
    .trim()
    .replace(/[^\w./-]/g, '')
    .replace(/^[-.]+/, '')
  const depth = Number.isFinite(Number(input.depth)) && Number(input.depth) > 0
    ? Math.min(Math.max(Math.floor(Number(input.depth)), 1), 1000)
    : 0
  const submodules = !!input.submodules
  const useProxy = !!input.useProxy
  const onExists = input.onExists === 'fail' || input.onExists === 'new' ? input.onExists : 'update'

  const distro = (settings.wslDistro || '').trim()

  let exists = false
  let isRepo = false
  let home = ''
  let wslGit = ''
  let warning = ''

  if (target === 'windows') {
    try {
      const st = fs.statSync(joinDest('windows', parentDir, baseName))
      exists = true
      isRepo = st.isDirectory() && fs.existsSync(path.join(joinDest('windows', parentDir, baseName), '.git'))
    } catch {
      exists = false
    }
    try {
      await resolveWindowsGit()
    } catch (err: any) {
      warning = String(err?.message || err)
    }
  } else {
    const probe = await probeWsl(joinDest('wsl', parentDir, baseName), distro)
    if (probe.ok) {
      exists = probe.exists
      isRepo = probe.isRepo
      home = probe.home
      wslGit = probe.hasGit
      if (!wslGit) {
        warning = '当前 WSL 发行版里没有 git，请先执行：sudo apt update && sudo apt install -y git'
      }
    } else {
      warning = `探测 WSL 失败（${probe.error || '未知原因'}），仍可尝试拉取，但可能因环境问题失败`
    }
  }

  let dirName = baseName
  if (exists && onExists === 'new') {
    // 用户明确要求换新目录，即使已存在的是 git 仓库也另建一个
    dirName = await uniqueName(target, parentDir, baseName, distro)
    exists = false
  }

  const destDir = joinDest(target, parentDir, dirName)
  const proxy = useProxy ? gitProxyTarget() : null
  const proxyText = proxy ? `${proxy.scheme}://${proxy.addr}` : ''

  // 已存在的仓库走更新；用户选了「报错」就保持 clone 让它失败提示
  const action: 'clone' | 'update' = exists && isRepo && onExists !== 'fail' ? 'update' : 'clone'
  if (exists && !isRepo && onExists === 'update') {
    warning = `${destDir} 已存在但不是 git 仓库。可以把「目录已存在时」改成「自动加后缀新建」，或换一个文件夹名。`
  }

  const displayPath =
    target === 'windows'
      ? destDir
      : home
        ? `\\\\wsl$\\${distro || 'WSL'}\\${(destDir.startsWith('~') ? `${home}/${destDir.replace(/^~\/?/, '')}` : destDir)
            .replace(/^\/+/, '')
            .replace(/\//g, '\\')}`
        : destDir

  const shellPlan: ClonePlan = {
    fullName: `${owner}/${repo}`,
    cloneUrl,
    target,
    parentDir,
    dirName,
    destDir,
    displayPath,
    branch,
    depth,
    submodules,
    useProxy,
    proxyText,
    onExists,
    exists,
    isRepo,
    action,
    script: '',
    distro,
    warning
  }
  shellPlan.script =
    target === 'windows' ? buildWindowsPreview(shellPlan) : buildWslScript(shellPlan)
  return shellPlan
}

/** Windows 分支：给用户看的等价命令（实际执行用参数数组，不过 shell） */
function buildWindowsPreview(p: ClonePlan): string {
  const parts: string[] = ['git']
  if (p.proxyText) parts.push('-c', `http.proxy=${p.proxyText}`, '-c', `https.proxy=${p.proxyText}`)
  if (p.action === 'update') {
    const cd = `"${p.destDir}"`
    return [
      `cd ${cd}`,
      `git ${p.proxyText ? `-c http.proxy=${p.proxyText} -c https.proxy=${p.proxyText} ` : ''}remote set-url origin "${p.cloneUrl}"`,
      `git fetch --all --prune --tags`,
      `git pull --ff-only`
    ].join('\n')
  }
  parts.push('clone', '--progress')
  if (p.depth > 0) parts.push('--depth', String(p.depth))
  if (p.branch) parts.push('--branch', p.branch)
  if (p.submodules) parts.push('--recurse-submodules')
  parts.push('--', `"${p.cloneUrl}"`, `"${p.destDir}"`)
  return parts.join(' ')
}

function buildWslScript(p: ClonePlan): string {
  const lines: string[] = []
  lines.push('set -uo pipefail')
  lines.push('')
  lines.push('echo "=================================================="')
  lines.push(`echo " 目标仓库 : ${p.fullName}"`)
  lines.push(`echo " 目标目录 : ${p.destDir}"`)
  lines.push(
    `echo " 拉取方式 : ${p.action === 'update' ? '检测到已有仓库，执行 pull 更新' : p.depth > 0 ? `浅克隆 depth=${p.depth}` : '完整历史'}"`
  )
  lines.push('echo "=================================================="')
  lines.push('')
  lines.push('echo "[1/3] 检查 git..."')
  lines.push('if ! command -v git >/dev/null 2>&1; then')
  lines.push('  echo "❌ 当前 WSL 发行版没有安装 git"')
  lines.push('  echo "   sudo apt update && sudo apt install -y git"')
  lines.push('  exit 127')
  lines.push('fi')
  lines.push('echo "✅ $(git --version)"')
  lines.push('')
  lines.push('echo "[2/3] 准备目录..."')
  lines.push(`DEST=${q(p.destDir)}`)
  lines.push('DEST="${DEST/#\\~/$HOME}"')
  lines.push('PARENT=$(dirname "$DEST")')
  lines.push('if ! mkdir -p "$PARENT"; then')
  lines.push('  echo "❌ 无法创建目录: $PARENT"')
  lines.push('  exit 1')
  lines.push('fi')
  lines.push('echo "   父目录: $PARENT"')
  lines.push('')
  lines.push('GIT_PROXY=""')
  if (p.proxyText) {
    const [host, ...rest] = p.proxyText.replace(/^\w+:\/\//, '').split(':')
    const port = rest.join(':') || '7890'
    lines.push(`PROXY_SCHEME=${q(p.proxyText.split('://')[0] || 'http')}`)
    lines.push(`PROXY_ADDR=${q(`${host}:${port}`)}`)
    lines.push('case "$PROXY_ADDR" in')
    lines.push('  127.0.0.1:*|localhost:*)')
    lines.push("    GW=$(ip route show default 2>/dev/null | awk '{print $3; exit}')")
    lines.push('    if [ -n "$GW" ]; then')
    lines.push('      PROXY_ADDR="$GW:${PROXY_ADDR#*:}"')
    lines.push('      echo "   代理已指向 Windows 主机: $PROXY_ADDR"')
    lines.push('    fi')
    lines.push('    ;;')
    lines.push('esac')
    lines.push('GIT_PROXY="-c http.proxy=$PROXY_SCHEME://$PROXY_ADDR -c https.proxy=$PROXY_SCHEME://$PROXY_ADDR"')
    lines.push('echo "   代理: $PROXY_SCHEME://$PROXY_ADDR"')
  } else {
    lines.push('echo "   代理: 未启用（走 WSL 内的网络设置）"')
  }
  lines.push('export GIT_TERMINAL_PROMPT=0')
  lines.push('')
  lines.push('echo "[3/3] 拉取代码..."')

  if (p.action === 'update') {
    lines.push('if [ ! -d "$DEST/.git" ]; then')
    lines.push('  echo "❌ 目标目录存在但不是 git 仓库，请换个目录名或先清理"')
    lines.push('  exit 2')
    lines.push('fi')
    lines.push('cd "$DEST" || exit 1')
    lines.push(`git $GIT_PROXY remote set-url origin ${q(p.cloneUrl)}`)
    lines.push('git $GIT_PROXY fetch --all --prune --tags')
    lines.push('CODE=$?')
    lines.push('if [ "$CODE" != "0" ]; then echo "❌ 拉取远端信息失败，退出码 $CODE（检查网络 / 代理 / 分支）"; exit "$CODE"; fi')
    lines.push('git $GIT_PROXY pull --ff-only')
    lines.push('CODE=$?')
    lines.push('if [ "$CODE" != "0" ]; then')
    lines.push('  echo "⚠️ 快进更新失败（本地可能有改动或分叉），继续展示当前状态"')
    lines.push('fi')
  } else {
    lines.push('if [ -e "$DEST" ]; then')
    lines.push('  echo "❌ 目标目录已存在: $DEST"')
    lines.push('  echo "   可以勾选「已存在时更新」，或换一个文件夹名"')
    lines.push('  exit 2')
    lines.push('fi')
    const opts: string[] = ['clone', '--progress']
    if (p.depth > 0) opts.push('--depth', String(p.depth))
    if (p.branch) opts.push('--branch', q(p.branch))
    if (p.submodules) opts.push('--recurse-submodules')
    lines.push(`git $GIT_PROXY ${opts.join(' ')} ${q(p.cloneUrl)} "$DEST"`)
    lines.push('CODE=$?')
    lines.push('if [ "$CODE" != "0" ]; then')
    lines.push('  echo "❌ 拉取失败，退出码 $CODE"')
    lines.push('  echo "   常见原因：网络不通 / 需要代理 / 仓库私有或已删除 / 分支名写错"')
    lines.push('  exit "$CODE"')
    lines.push('fi')
  }
  lines.push('')
  lines.push('echo ""')
  lines.push('echo "================ 拉取结果 ================"')
  lines.push('cd "$DEST" 2>/dev/null || { echo "❌ 目录不存在"; exit 3; }')
  lines.push("git log -1 --format='   最新提交: %h %s (%cr)' 2>/dev/null || true")
  lines.push('echo "   当前分支: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"')
  lines.push('echo "   占用空间: $(du -sh . 2>/dev/null | cut -f1)"')
  lines.push('echo "   目录路径: $(pwd)"')
  lines.push('echo "=========================================="')
  lines.push('echo ""')
  lines.push('echo "🎉 完成。可以回到 GitFinder 点「在资源管理器打开」查看这个目录"')
  lines.push('exit 0')
  return lines.join('\n')
}

// ---------------- 执行 ----------------

/** 逐行读取子进程输出，同时把 \r 当作换行（git 进度条用 \r 刷新） */
function spawnLines(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  onLine: (stream: 'stdout' | 'stderr', line: string) => void,
  onExit: (code: number | null) => void,
  onError: (err: Error) => void
): ChildProcess {
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true
  })
  const mk = (stream: 'stdout' | 'stderr') => {
    const dec = new StringDecoder('utf8')
    let rest = ''
    return {
      push: (chunk: Buffer): void => {
        rest += dec.write(chunk)
        const parts = rest.split(/\r\n|\r|\n/)
        rest = parts.pop() || ''
        for (const line of parts) {
          if (line.trim().length) onLine(stream, line)
        }
      },
      flush: (): void => {
        rest += dec.end()
        if (rest.trim().length) onLine(stream, rest)
        rest = ''
      }
    }
  }
  const out = mk('stdout')
  const err = mk('stderr')
  child.stdout?.on('data', (c: Buffer) => out.push(c))
  child.stderr?.on('data', (c: Buffer) => err.push(c))
  child.on('error', (e) => onError(e))
  child.on('close', (code) => {
    out.flush()
    err.flush()
    onExit(code)
  })
  return child
}

export function run(plan: ClonePlan, sender: WebContents): string {
  const taskId = randomUUID()
  let settled = false
  const emit = (stream: CloneLogEvent['stream'], line: string): void => {
    if (sender.isDestroyed()) return
    sender.send('clone:log', { taskId, stream, line })
  }
  const finish = (code: number | null): void => {
    if (settled) return
    settled = true
    running.delete(taskId)
    if (sender.isDestroyed()) return
    sender.send('clone:done', {
      taskId,
      ok: code === 0,
      code,
      destDir: plan.destDir,
      action: plan.action
    })
  }
  const fail = (message: string): void => {
    emit('system', message)
    finish(-1)
  }

  if (plan.target === 'windows') {
    startWindows(taskId, plan, emit, finish, fail)
  } else {
    const b64 = Buffer.from(plan.script, 'utf8').toString('base64')
    const args: string[] = []
    if (plan.distro) args.push('-d', plan.distro)
    args.push('--', 'bash', '-lc', `echo '${b64}' | base64 -d | bash -s`)
    const child = spawnLines(
      'wsl.exe',
      args,
      { env: { ...process.env, WSL_UTF8: '1' } },
      (stream, line) => emit(stream, line),
      (code) => finish(code),
      (err) => fail(`无法启动 wsl.exe：${err.message}`)
    )
    running.set(taskId, child)
  }
  return taskId
}

function startWindows(
  taskId: string,
  plan: ClonePlan,
  emit: (stream: CloneLogEvent['stream'], line: string) => void,
  finish: (code: number | null) => void,
  fail: (msg: string) => void
): void {
  void resolveWindowsGit()
    .then((git) => {
      emit('system', `使用 ${git}`)
      const parent = path.dirname(plan.destDir)
      const proxyArgs = plan.proxyText
        ? ['-c', `http.proxy=${plan.proxyText}`, '-c', `https.proxy=${plan.proxyText}`]
        : []
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      const steps: Array<{ args: string[]; cwd?: string }> = []

      if (plan.action === 'update') {
        steps.push({ args: [...proxyArgs, 'remote', 'set-url', 'origin', plan.cloneUrl], cwd: plan.destDir })
        steps.push({ args: [...proxyArgs, 'fetch', '--all', '--prune', '--tags', '--progress'], cwd: plan.destDir })
        steps.push({ args: [...proxyArgs, 'pull', '--ff-only', '--progress'], cwd: plan.destDir })
      } else {
        const args = [...proxyArgs, 'clone', '--progress']
        if (plan.depth > 0) args.push('--depth', String(plan.depth))
        if (plan.branch) args.push('--branch', plan.branch)
        if (plan.submodules) args.push('--recurse-submodules')
        args.push('--', plan.cloneUrl, plan.destDir)
        // 父目录不存在时先建好，否则 spawn 的 cwd 无效会报 ENOENT
        try {
          fs.mkdirSync(parent, { recursive: true })
        } catch (err: any) {
          fail(`无法创建父目录 ${parent}：${err?.message || err}`)
          return
        }
        steps.push({ args, cwd: parent })
      }

      const runStep = (i: number): void => {
        if (i >= steps.length) {
          emit('system', '✅ 完成')
          finish(0)
          return
        }
        const step = steps[i]
        emit('system', `$ git ${step.args.filter((a) => a !== '--progress').join(' ')}`)
        const child = spawnLines(
          git,
          step.args,
          { cwd: step.cwd, env },
          (stream, line) => emit(stream, line),
          (code) => {
            if (code !== 0) {
              emit('system', `❌ git 退出码 ${code}`)
              finish(code)
              return
            }
            runStep(i + 1)
          },
          (err) => fail(`git 启动失败：${err.message}`)
        )
        // 每个步骤都登记句柄，取消时能杀掉当前子进程
        running.set(taskId, child)
      }

      runStep(0)
    })
    .catch((err) => fail(String(err?.message || err)))
}

export function cancel(taskId: string): void {
  const child = running.get(taskId)
  if (!child) return
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  running.delete(taskId)
}

/** 在资源管理器里打开目标目录 */
export async function reveal(plan: ClonePlan): Promise<{ ok: boolean; message: string }> {
  let target = plan.displayPath || plan.destDir
  if (plan.target === 'wsl') {
    const res = await execWslCapture(`wslpath -w ${q(plan.destDir)} 2>/dev/null || true`, {
      distro: plan.distro || undefined,
      timeoutMs: 8000
    })
    const p = res.stdout.trim().split('\n').filter(Boolean).pop()
    if (p) target = p
  }
  const msg = await shell.openPath(target)
  return { ok: !msg, message: msg || `已打开 ${target}` }
}

export async function checkGit(): Promise<GitAvailability> {
  let windows = false
  let windowsVersion = ''
  try {
    const git = await resolveWindowsGit()
    const res = await capture(git, ['--version'])
    windows = res.code === 0
    windowsVersion = res.stdout.trim()
  } catch {
    windows = false
  }

  let wsl = false
  let wslVersion = ''
  const settings = loadSettings()
  try {
    const res = await execWslCapture('git --version 2>/dev/null || echo NO_GIT', {
      distro: settings.wslDistro || undefined,
      timeoutMs: 8000
    })
    if (/git version/i.test(res.stdout)) {
      wsl = true
      wslVersion = res.stdout.trim().split('\n')[0]
    }
  } catch {
    wsl = false
  }
  return { windows, windowsVersion, wsl, wslVersion }
}

/** 给界面用的默认父目录建议 */
export async function defaults(): Promise<{ windows: string; wsl: string; distro: string }> {
  const settings = loadSettings()
  const home = process.env.USERPROFILE || ''
  const windowsDefault = path.join(home || 'C:\\', 'Documents', 'GitHub')
  let distro = settings.wslDistro
  if (!distro) {
    try {
      const list = await listDistros()
      distro = list[0] || ''
    } catch {
      distro = ''
    }
  }
  return {
    windows: windowsDefault,
    wsl: (settings.wslWorkDir || '').trim() || '~/projects',
    distro
  }
}
