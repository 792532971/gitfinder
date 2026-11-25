<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { RepoItem, DockerProbe, DeployPlan } from '../../../shared/types'
import { toast, saveSettings } from '../store'
import { toCloneable } from '../cloneable'
import EnvDiagnose from './EnvDiagnose.vue'

const props = defineProps<{ repo: RepoItem }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const probeLoading = ref(true)
const probe = ref<DockerProbe | null>(null)
const probeError = ref('')

const mode = ref<'compose' | 'dockerfile' | 'manual'>('dockerfile')
const hostPort = ref(8080)
const containerPort = ref(8080)
const imageName = ref(props.repo.name.toLowerCase().replace(/[^a-z0-9]/g, '-'))
const extraArgs = ref('')
const manualCommand = ref('')

const plan = ref<DeployPlan | null>(null)
const planError = ref('')
const showScript = ref(false)

const logs = ref<{ stream: string; line: string }[]>([])
const running = ref(false)
const taskId = ref('')
const doneOk = ref<boolean | null>(null)
const logBox = ref<HTMLElement | null>(null)

let offLog: (() => void) | null = null
let offDone: (() => void) | null = null
let planTimer: ReturnType<typeof setTimeout> | null = null

const available = computed(() => {
  if (mode.value === 'manual') return manualCommand.value.trim().length > 0
  if (mode.value === 'compose') return !!probe.value?.hasCompose
  if (mode.value === 'dockerfile') return !!probe.value?.hasDockerfile
  return false
})

const noDockerAtAll = computed(
  () =>
    !!probe.value &&
    !probe.value.hasCompose &&
    !probe.value.hasDockerfile &&
    !probe.value.readmeDockerRun
)

onMounted(async () => {
  offLog = window.api.events.onDeployLog((e) => {
    if (e.taskId !== taskId.value) return
    logs.value.push({ stream: e.stream, line: e.line })
    scrollLog()
  })
  offDone = window.api.events.onDeployDone((e) => {
    if (e.taskId !== taskId.value) return
    running.value = false
    doneOk.value = e.ok
    if (e.ok) toast('部署成功，去浏览器看看吧', 'ok')
    else toast(`部署失败，退出码 ${e.code}`, 'error', 6000)
  })

  try {
    const p = await window.api.github.probeDocker(props.repo.owner, props.repo.name)
    probe.value = p
    if (p.hasCompose) mode.value = 'compose'
    else if (p.hasDockerfile) mode.value = 'dockerfile'
    else {
      // 根目录没有 Docker 支持，直接切到手动模式，避免停在一个禁用状态的 tab 上
      mode.value = 'manual'
      if (p.readmeDockerRun) manualCommand.value = p.readmeDockerRun
    }
    const port = p.exposedPorts[0]
    if (port) {
      hostPort.value = port
      containerPort.value = port
    }
    const m = p.readmeDockerRun.match(/-p\s+(\d+):(\d+)/)
    if (m) {
      hostPort.value = Number(m[1])
      containerPort.value = Number(m[2])
    }
  } catch (err: any) {
    probeError.value = err.message || String(err)
  } finally {
    probeLoading.value = false
    schedulePlan()
  }
})

onUnmounted(() => {
  offLog?.()
  offDone?.()
  if (planTimer) clearTimeout(planTimer)
})

function scrollLog(): void {
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  })
}

function schedulePlan(): void {
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(buildPlan, 250)
}

async function buildPlan(): Promise<void> {
  planError.value = ''
  try {
    plan.value = await window.api.deploy.plan({
      fullName: `${props.repo.owner}/${props.repo.name}`,
      mode: mode.value,
      hostPort: Number(hostPort.value),
      containerPort: Number(containerPort.value),
      imageName: imageName.value,
      extraArgs: extraArgs.value,
      manualCommand: manualCommand.value
    })
  } catch (err: any) {
    plan.value = null
    planError.value = err.message || String(err)
  }
}

watch([mode, hostPort, containerPort, imageName, extraArgs, manualCommand], schedulePlan)

async function startDeploy(): Promise<void> {
  if (!plan.value) {
    await buildPlan()
    if (!plan.value) {
      toast(planError.value || '参数有误，请检查', 'error')
      return
    }
  }
  logs.value = []
  running.value = true
  doneOk.value = null
  try {
    const { taskId: id } = await window.api.deploy.run(toCloneable(plan.value))
    taskId.value = id
    logs.value.push({ stream: 'system', line: `任务已启动：${id.slice(0, 8)}` })
  } catch (err: any) {
    running.value = false
    toast(`启动失败：${err.message}`, 'error', 6000)
  }
}

async function stopDeploy(): Promise<void> {
  if (!taskId.value) return
  await window.api.deploy.stop(taskId.value, plan.value?.distro)
  running.value = false
  logs.value.push({ stream: 'system', line: '已请求停止' })
}

function lineClass(stream: string): string {
  if (stream === 'stderr') return 'l-stderr'
  if (stream === 'system') return 'l-system'
  return ''
}

/** 诊断面板里点发行版：直接写进设置，重新生成部署脚本 */
async function onPickDistro(name: string): Promise<void> {
  try {
    await saveSettings({ wslDistro: name })
    toast(`部署发行版已设为 ${name}`, 'ok', 3000)
    schedulePlan()
  } catch (err: any) {
    toast(`保存失败：${err.message}`, 'error')
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="!running && emit('close')">
    <div class="modal deploy-modal">
      <div class="modal-head">
        <div>
          <h3>部署到 WSL Docker</h3>
          <p class="tiny muted" style="margin-top: 2px">{{ repo.full_name }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" :disabled="running" @click="emit('close')">关闭</button>
      </div>

      <div class="modal-body">
        <!-- 探测结果 -->
        <div v-if="probeLoading" class="probe-box">
          <span class="spin">◌</span> 正在检测仓库的 Docker 支持情况…
        </div>
        <div v-else-if="probeError" class="probe-box probe-err">
          探测失败：{{ probeError }}（仍可尝试手动模式）
        </div>
        <div v-else class="probe-box">
          <span :class="['badge', probe?.hasCompose ? 'badge-green' : 'badge']">
            docker-compose {{ probe?.hasCompose ? '✓' : '×' }}
          </span>
          <span :class="['badge', probe?.hasDockerfile ? 'badge-green' : 'badge']">
            Dockerfile {{ probe?.hasDockerfile ? '✓' : '×' }}
          </span>
          <span :class="['badge', probe?.readmeDockerRun ? 'badge-amber' : 'badge']">
            README docker run {{ probe?.readmeDockerRun ? '✓' : '×' }}
          </span>
          <span v-if="probe?.exposedPorts.length" class="badge badge-accent">
            端口 {{ probe?.exposedPorts.join(', ') }}
          </span>
        </div>

        <div v-if="noDockerAtAll" class="warn-box">
          仓库根目录没有找到 Dockerfile 或 compose 文件，README 里也没有 docker run 命令。
          如果 Docker 配置在子目录（比如 docker/ 或 deploy/）里，可以切到「手动模式」自己填构建命令；
          也可以改用「下载安装」。
        </div>

        <!-- 模式 -->
        <div class="section-title">部署方式</div>
        <div class="mode-tabs">
          <button
            :class="['mode-tab', { active: mode === 'compose' }]"
            :disabled="!probe?.hasCompose || running"
            @click="mode = 'compose'"
          >
            <strong>docker compose</strong>
            <span>用仓库自带的 compose 文件一键起服务</span>
          </button>
          <button
            :class="['mode-tab', { active: mode === 'dockerfile' }]"
            :disabled="!probe?.hasDockerfile || running"
            @click="mode = 'dockerfile'"
          >
            <strong>Dockerfile</strong>
            <span>构建镜像后单容器运行，可自定义端口</span>
          </button>
          <button
            :class="['mode-tab', { active: mode === 'manual' }]"
            :disabled="running"
            @click="mode = 'manual'"
          >
            <strong>手动命令</strong>
            <span>直接执行一条 docker run 命令</span>
          </button>
        </div>

        <!-- 参数 -->
        <template v-if="mode === 'manual'">
          <div class="field" style="margin-top: 16px">
            <label>启动命令</label>
            <textarea
              v-model="manualCommand"
              class="input mono"
              rows="3"
              :disabled="running"
              placeholder="docker run -d -p 8080:80 --name myapp image:tag"
            ></textarea>
            <span class="desc">只允许 docker run 开头的单条命令，会自动去掉危险字符。</span>
          </div>
        </template>
        <template v-else>
          <div class="grid-3" style="margin-top: 16px">
            <div class="field">
              <label>宿主端口</label>
              <input v-model.number="hostPort" class="input mono" type="number" :disabled="running" />
            </div>
            <div class="field">
              <label>容器端口</label>
              <input
                v-model.number="containerPort"
                class="input mono"
                type="number"
                :disabled="running || mode === 'compose'"
              />
            </div>
            <div class="field">
              <label>镜像名</label>
              <input v-model="imageName" class="input mono" :disabled="running" />
            </div>
          </div>
          <div v-if="mode === 'dockerfile'" class="field" style="margin-top: 12px">
            <label>额外 docker run 参数（可选）</label>
            <input
              v-model="extraArgs"
              class="input mono"
              :disabled="running"
              placeholder="-e TZ=Asia/Shanghai -v /data:/app/data"
            />
            <span class="desc">常用：-e 环境变量、-v 挂载目录、--network host</span>
          </div>
          <div v-if="mode === 'compose'" class="warn-box soft">
            compose 模式下的端口由仓库的 compose 文件决定，上面填的端口不会生效。
          </div>
        </template>

        <!-- 脚本预览 -->
        <div class="section-title script-toggle" @click="showScript = !showScript">
          <span>{{ showScript ? '▾' : '▸' }} 查看将要执行的脚本</span>
          <span class="tiny muted">脚本通过 base64 传给 WSL 内的 bash，避免转义问题</span>
        </div>
        <div v-if="showScript">
          <div v-if="planError" class="probe-box probe-err">{{ planError }}</div>
          <pre v-else class="log script-pre">{{ plan?.script }}</pre>
        </div>

        <!-- 日志 -->
        <div class="section-title">
          执行日志
          <span v-if="doneOk === true" class="badge badge-green">成功</span>
          <span v-else-if="doneOk === false" class="badge badge-red">失败</span>
        </div>
        <div ref="logBox" class="log log-box">
          <template v-if="logs.length">
            <div v-for="(l, i) in logs" :key="i" :class="lineClass(l.stream)">{{ l.line }}</div>
          </template>
          <div v-else class="log-placeholder">
            {{ running ? '正在执行…' : '点击右下角「开始部署」后，这里的输出会实时刷新。' }}
          </div>
        </div>

        <!-- 环境诊断 -->
        <details class="env-fold">
          <summary>部署不起来？检查 WSL / Docker 环境</summary>
          <p class="tiny muted" style="margin-top: 6px">
            会执行几条只读命令（wsl.exe、注册表、服务状态、WSL 内的 docker 版本），配置了 AI 时再交给它分析原因。
          </p>
          <EnvDiagnose compact @pick-distro="onPickDistro" />
        </details>
      </div>

      <div class="modal-foot">
        <button v-if="running" class="btn btn-danger" @click="stopDeploy">停止</button>
        <div class="spacer"></div>
        <button class="btn" :disabled="running" @click="emit('close')">关闭</button>
        <button class="btn btn-primary" :disabled="running || !available" @click="startDeploy">
          {{ running ? '部署中…' : '开始部署' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.deploy-modal {
  max-width: 900px;
}
.probe-box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-2);
}
.probe-err {
  background: var(--red-soft);
  color: var(--red);
}
.warn-box {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--amber-soft);
  color: var(--amber);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.6;
}
.warn-box.soft {
  background: var(--bg-subtle);
  color: var(--text-2);
}
.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 20px 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.script-toggle {
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}
.mode-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.mode-tab {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  text-align: left;
  transition: all 0.15s;
}
.mode-tab strong {
  font-size: 13px;
  font-weight: 600;
}
.mode-tab span {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.45;
}
.mode-tab:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
}
.mode-tab.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.mode-tab.active strong {
  color: var(--accent);
}
.mode-tab:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1.4fr;
  gap: 12px;
}
.script-pre {
  max-height: 220px;
  font-size: 11.5px;
}
.log-box {
  height: 220px;
}
.log-placeholder {
  color: #6e7681;
  font-style: italic;
}
textarea.input {
  resize: vertical;
  line-height: 1.6;
}
.env-fold {
  margin-top: 16px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}
.env-fold > summary {
  cursor: pointer;
  user-select: none;
  color: var(--text-2);
}
</style>
