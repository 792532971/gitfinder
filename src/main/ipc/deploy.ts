import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { WebContents } from 'electron'
import { runWslScript, execWslCapture } from '../lib/shell'
import { loadSettings, gitProxyArgs } from '../lib/settings'
import * as manage from './manage'
import type { DeployPlan } from '../../shared/types'

const running = new Map<string, ChildProcess>()

/** bash 单引号安全包裹 */
function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** 白名单校验，防止把用户输入当命令执行 */
function assertSafe(label: string, value: string, re: RegExp): string {
  const v = String(value || '').trim()
  if (!re.test(v)) {
    throw new Error(`${label} 含非法字符：${v || '(空)'}`)
  }
  return v
}

function sanitizeImage(name: string): string {
  const v = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return v || 'app'
}

function sanitizePort(n: number, fallback: number): number {
  const v = Number(n)
  if (!Number.isInteger(v) || v < 1 || v > 65535) return fallback
  return v
}

export async function plan(input: {
  fullName: string
  mode: 'compose' | 'dockerfile' | 'manual'
  hostPort: number
  containerPort: number
  imageName: string
  extraArgs: string
  manualCommand?: string
}): Promise<DeployPlan> {
  const settings = loadSettings()
  const [owner, repo] = input.fullName.split('/')
  if (!owner || !repo) throw new Error('仓库名格式应为 owner/repo')

  const cloneUrl = assertSafe(
    '仓库地址',
    `https://github.com/${owner}/${repo}.git`,
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/
  )

  const dirName = assertSafe('项目目录名', repo, /^[A-Za-z0-9._-]+$/)
  const containerName = sanitizeImage(input.imageName || repo)
  const imageName = sanitizeImage(input.imageName || repo)
  const hostPort = sanitizePort(input.hostPort, 8080)
  const containerPort = sanitizePort(input.containerPort, hostPort)

  const extraArgs = String(input.extraArgs || '')
    .replace(/[;&|`$<>\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  let manualCommand = ''
  if (input.mode === 'manual') {
    manualCommand = String(input.manualCommand || '')
      .replace(/[;&|`$<>\n\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!/^docker\s+run\b/i.test(manualCommand)) {
      throw new Error('手动命令必须以 docker run 开头')
    }
  }

  const workDir = (settings.wslWorkDir || '').trim() || '~/gitfinder-apps'
  const distro = (settings.wslDistro || '').trim()

  const deployPlan: DeployPlan = {
    fullName: `${owner}/${repo}`,
    cloneUrl,
    distro,
    workDir,
    dirName,
    mode: input.mode,
    composeFile: '',
    imageName,
    containerName,
    hostPort,
    containerPort,
    extraArgs,
    manualCommand,
    script: ''
  }
  deployPlan.script = buildScript(deployPlan)
  return deployPlan
}

/** 手动模式：直接执行 README 里给出的 docker run 命令 */
function buildManualScript(p: DeployPlan): string {
  return [
    'set -uo pipefail',
    '',
    'echo "=================================================="',
    `echo " 目标仓库 : ${p.fullName}"`,
    'echo " 部署模式 : README 中的 docker run 命令"',
    'echo "=================================================="',
    'echo ""',
    'echo "[1/2] 检查 Docker 环境..."',
    'if ! command -v docker >/dev/null 2>&1; then',
    '  echo "❌ 未找到 docker 命令，请先在当前 WSL 发行版中安装 Docker"',
    '  exit 127',
    'fi',
    'if ! docker info >/dev/null 2>&1; then',
    '  echo "❌ Docker 守护进程未运行，或当前用户没有 docker 权限"',
    '  exit 126',
    'fi',
    'echo "✅ Docker 可用"',
    'echo ""',
    'echo "[2/2] 执行启动命令..."',
    `echo "   ${p.manualCommand.replace(/"/g, '')}"`,
    p.manualCommand,
    'CODE=$?',
    'if [ "$CODE" != "0" ]; then echo "❌ 命令执行失败，退出码 $CODE"; exit "$CODE"; fi',
    'echo ""',
    'echo "================ 运行中的容器 ================"',
    'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}" | head -n 10',
    'echo "=============================================="',
    'exit 0'
  ].join('\n')
}

function buildScript(p: DeployPlan): string {
  if (p.mode === 'manual') return buildManualScript(p)

  const proxy = gitProxyArgs()
  const proxyLine = proxy.length
    ? `GIT_PROXY_ARGS=${q(proxy.join(' '))}\n`
    : `GIT_PROXY_ARGS=""\n`

  const lines: string[] = []
  lines.push('set -uo pipefail')
  lines.push('')
  lines.push(`echo "=================================================="`)
  lines.push(`echo " 目标仓库 : ${p.fullName}"`)
  lines.push(`echo " 工作目录 : ${p.workDir}/${p.dirName}"`)
  lines.push(`echo " 部署模式 : ${p.mode === 'compose' ? 'docker compose' : 'Dockerfile 单容器'}"`)
  lines.push(`echo "=================================================="`)
  lines.push('')
  lines.push('echo "[1/4] 检查 Docker 环境..."')
  lines.push('if ! command -v docker >/dev/null 2>&1; then')
  lines.push('  echo "❌ 未找到 docker 命令。请在当前 WSL 发行版中安装 Docker："')
  lines.push('  echo "   curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker \\$USER"')
  lines.push('  exit 127')
  lines.push('fi')
  lines.push('if ! docker info >/dev/null 2>&1; then')
  lines.push('  echo "❌ Docker 守护进程未运行，或当前用户无权限访问 docker.sock"')
  lines.push('  echo "   尝试: sudo service docker start   或   sudo systemctl start docker"')
  lines.push('  exit 126')
  lines.push('fi')
  lines.push('echo "✅ Docker 可用: $(docker --version)"')
  lines.push('')
  lines.push('if docker compose version >/dev/null 2>&1; then')
  lines.push('  DC="docker compose"')
  lines.push('elif command -v docker-compose >/dev/null 2>&1; then')
  lines.push('  DC="docker-compose"')
  lines.push('else')
  lines.push('  DC=""')
  lines.push('fi')
  lines.push('')
  lines.push('echo "[2/4] 拉取仓库..."')
  lines.push(`WORKDIR="${p.workDir.replace(/"/g, '')}"`)
  lines.push('WORKDIR="${WORKDIR/#\\~/$HOME}"')
  lines.push('mkdir -p "$WORKDIR"')
  lines.push('cd "$WORKDIR" || exit 1')
  lines.push(proxyLine)
  lines.push(`if [ -d ${q(p.dirName)} ]; then`)
  lines.push('  echo "   目录已存在，尝试更新代码"')
  lines.push(`  cd ${q(p.dirName)}`)
  lines.push('  git $GIT_PROXY_ARGS pull --ff-only 2>&1 | tail -n 5 || echo "   ⚠️ 更新失败，继续使用现有代码"')
  lines.push('else')
  lines.push(`  git $GIT_PROXY_ARGS clone --depth 1 ${q(p.cloneUrl)} ${q(p.dirName)}`)
  lines.push('  if [ $? -ne 0 ]; then')
  lines.push('    echo "❌ 克隆失败。常见原因：网络不通 / 需要代理 / 仓库已私有"')
  lines.push('    exit 1')
  lines.push('  fi')
  lines.push(`  cd ${q(p.dirName)}`)
  lines.push('fi')
  lines.push('echo "✅ 代码就绪: $(pwd)"')
  lines.push('')

  if (p.mode === 'compose') {
    lines.push('echo "[3/4] 检测 compose 文件..."')
    lines.push('COMPOSE_FILE=""')
    lines.push('for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do')
    lines.push('  if [ -f "$f" ]; then COMPOSE_FILE="$f"; break; fi')
    lines.push('done')
    lines.push('if [ -z "$COMPOSE_FILE" ]; then')
    lines.push('  echo "❌ 当前目录没有找到 compose 文件"')
    lines.push('  exit 2')
    lines.push('fi')
    lines.push('echo "   使用: $COMPOSE_FILE"')
    lines.push('')
    lines.push('echo "[4/4] 构建并启动容器..."')
    lines.push('if [ -z "$DC" ]; then echo "❌ 未安装 docker compose 插件"; exit 3; fi')
    lines.push('$DC up -d --build 2>&1 | tail -n 40')
    lines.push('CODE=${PIPESTATUS[0]:-$?}')
    lines.push('if [ "$CODE" != "0" ]; then echo "❌ compose 启动失败，退出码 $CODE"; exit "$CODE"; fi')
    lines.push('')
    lines.push('echo ""')
    lines.push('echo "================ 部署结果 ================"')
    lines.push('$DC ps')
    lines.push('echo "=========================================="')
  } else {
    lines.push('echo "[3/4] 构建镜像..."')
    lines.push(`if [ ! -f Dockerfile ]; then echo "❌ 根目录没有 Dockerfile"; exit 2; fi`)
    lines.push(`docker build -t ${q(p.imageName)} . 2>&1 | tail -n 40`)
    lines.push('CODE=${PIPESTATUS[0]:-$?}')
    lines.push('if [ "$CODE" != "0" ]; then echo "❌ 镜像构建失败，退出码 $CODE"; exit "$CODE"; fi')
    lines.push('echo "✅ 镜像构建完成: ' + p.imageName + '"')
    lines.push('')
    lines.push('echo "[4/4] 启动容器..."')
    lines.push('if docker ps -a --format "{{.Ports}}" | grep -q ":'
      + p.hostPort + '->"; then')
    lines.push(`  echo "   ⚠️ 端口 ${p.hostPort} 已被其他容器占用，可能需要换一个端口"`)
    lines.push('fi')
    lines.push(`docker rm -f ${q(p.containerName)} >/dev/null 2>&1 || true`)
    lines.push(
      `docker run -d --name ${q(p.containerName)} --restart unless-stopped -p ${p.hostPort}:${p.containerPort} ${p.extraArgs} ${q(p.imageName)} 2>&1 | tail -n 5`
    )
    lines.push('CODE=${PIPESTATUS[0]:-$?}')
    lines.push('if [ "$CODE" != "0" ]; then echo "❌ 容器启动失败，退出码 $CODE"; exit "$CODE"; fi')
    lines.push('')
    lines.push('echo ""')
    lines.push('echo "================ 部署结果 ================"')
    lines.push(`docker ps --filter name=${q(p.containerName)} --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`)
    lines.push('echo "=========================================="')
  }

  lines.push('')
  lines.push(`echo ""`)
  lines.push(`echo "🎉 部署完成。Windows 浏览器访问: http://localhost:${p.hostPort}"`)
  lines.push('exit 0')
  return lines.join('\n')
}

export function run(plan: DeployPlan, sender: WebContents): string {
  const taskId = randomUUID()
  const emit = (stream: 'stdout' | 'stderr' | 'system', line: string): void => {
    if (sender.isDestroyed()) return
    sender.send('deploy:log', { taskId, stream, line })
  }

  const child = runWslScript(plan.script, {
    distro: plan.distro,
    onStdout: (line) => emit('stdout', line),
    onStderr: (line) => emit('stderr', line),
    onError: (err) => {
      emit('system', `进程启动失败: ${err.message}`)
      if (!sender.isDestroyed()) sender.send('deploy:done', { taskId, ok: false, code: -1 })
      running.delete(taskId)
    },
    onExit: (code) => {
      if (!sender.isDestroyed()) sender.send('deploy:done', { taskId, ok: code === 0, code })
      running.delete(taskId)
      // 部署成功才落账：管理页后续的启动 / 更新 / 卸载都靠这条记录
      if (code === 0) {
        manage.recordDockerDeploy(plan).catch((err) => console.error('[deploy] 写入管理台账失败', err))
      }
    }
  })
  running.set(taskId, child)
  return taskId
}

export function stop(taskId: string, distro: string): void {
  const child = running.get(taskId)
  if (!child) return
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  running.delete(taskId)
  // wsl.exe 被杀后，WSL 内的子进程可能残留，补一刀
  execWslCapture(
    `pkill -f "gitfinder-deploy" 2>/dev/null; pkill -f "docker compose up" 2>/dev/null; true`,
    { distro, timeoutMs: 8000 }
  ).catch(() => undefined)
}

export async function containers(distro?: string): Promise<{ ok: boolean; output: string }> {
  const d = distro || loadSettings().wslDistro || undefined
  const res = await execWslCapture(
    [
      'if ! command -v docker >/dev/null 2>&1; then echo "NO_DOCKER"; exit 1; fi',
      'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"'
    ].join('\n'),
    { distro: d, timeoutMs: 20000 }
  )
  if (res.stdout.includes('NO_DOCKER')) {
    return { ok: false, output: '当前 WSL 发行版里没有安装 Docker' }
  }
  return { ok: res.code === 0, output: (res.stdout || res.stderr || '').trim() }
}
