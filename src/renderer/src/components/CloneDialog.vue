<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { RepoItem, ClonePlan, CloneTarget, CloneExistsMode, GitAvailability } from '../../../shared/types'
import { toast } from '../store'

const props = defineProps<{ repo: RepoItem }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const target = ref<CloneTarget>('windows')
const parentDir = ref('')
const dirName = ref(props.repo.name)
const branch = ref('')
const depth = ref(1)
const submodules = ref(false)
const useProxy = ref(false)
const onExists = ref<CloneExistsMode>('update')

const plan = ref<ClonePlan | null>(null)
const planError = ref('')
const planning = ref(false)
const git = ref<GitAvailability | null>(null)

const logs = ref<{ stream: string; line: string; key: string }[]>([])
const running = ref(false)
const taskId = ref('')
const doneOk = ref<boolean | null>(null)
const doneDir = ref('')
const logBox = ref<HTMLElement | null>(null)

let offLog: (() => void) | null = null
let offDone: (() => void) | null = null
let planTimer: ReturnType<typeof setTimeout> | null = null

const canRun = computed(() => !!plan.value && !planning.value && !running.value)
const existsNow = computed(() => !!plan.value?.exists)
const actionText = computed(() => (plan.value?.action === 'update' ? '更新现有仓库' : '克隆到新目录'))

/** 记住上次用过的目录，下次默认填它 */
function savedDir(t: CloneTarget): string {
  try {
    return localStorage.getItem(`gitfinder.cloneDir.${t}`) || ''
  } catch {
    return ''
  }
}

function rememberDir(t: CloneTarget, dir: string): void {
  try {
    localStorage.setItem(`gitfinder.cloneDir.${t}`, dir)
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  offLog = window.api.events.onCloneLog((e) => {
    if (e.taskId !== taskId.value) return
    pushLog(e.stream, e.line)
  })
  offDone = window.api.events.onCloneDone((e) => {
    if (e.taskId !== taskId.value) return
    running.value = false
    doneOk.value = e.ok
    doneDir.value = e.destDir
    toast(e.ok ? '代码已经拉取到本地' : `拉取失败，退出码 ${e.code}`, e.ok ? 'ok' : 'error', 6000)
  })

  try {
    const [d, g, proxy] = await Promise.all([
      window.api.clone.defaults(),
      window.api.clone.checkGit(),
      proxyHint()
    ])
    git.value = g
    parentDir.value = savedDir('windows') || d.windows
    if (!g.windows && g.wsl) {
      target.value = 'wsl'
      parentDir.value = savedDir('wsl') || d.wsl
    }
    // 设置里配了代理就默认勾上，用户的 git 走代理通常更快
    useProxy.value = /\S/.test(proxy)
  } catch {
    /* 忽略：仍可手填目录 */
  }
  schedulePlan()
})

async function proxyHint(): Promise<string> {
  try {
    const s = await window.api.settings.get()
    return s.proxy || ''
  } catch {
    return ''
  }
}

onUnmounted(() => {
  offLog?.()
  offDone?.()
  if (planTimer) clearTimeout(planTimer)
})

function schedulePlan(): void {
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(buildPlan, 300)
}

async function buildPlan(): Promise<void> {
  planning.value = true
  planError.value = ''
  try {
    plan.value = await window.api.clone.plan({
      fullName: `${props.repo.owner}/${props.repo.name}`,
      target: target.value,
      parentDir: parentDir.value,
      dirName: dirName.value,
      branch: branch.value,
      depth: Number(depth.value),
      submodules: submodules.value,
      useProxy: useProxy.value,
      onExists: onExists.value
    })
  } catch (err: any) {
    plan.value = null
    planError.value = err?.message || String(err)
  } finally {
    planning.value = false
  }
}

watch([target, parentDir, dirName, branch, depth, submodules, useProxy, onExists], schedulePlan)

/** 切换目标时把目录换成对应平台的默认值 */
watch(target, async (t) => {
  try {
    const d = await window.api.clone.defaults()
    parentDir.value = savedDir(t) || (t === 'windows' ? d.windows : d.wsl)
  } catch {
    parentDir.value = savedDir(t) || (t === 'windows' ? '' : '~/projects')
  }
})

async function pickWindowsDir(): Promise<void> {
  const dir = await window.api.settings.pickDir('选择拉取到的目录')
  if (dir) parentDir.value = dir
}

/** git 进度条用 \r 刷新，同一阶段只保留最后一行，避免日志刷屏 */
function progressKey(line: string): string {
  const m = line.match(
    /^(?:remote:\s*)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Enumerating objects|Finding sources|Checking out files)\s*:/
  )
  return m ? m[1] : ''
}

function pushLog(stream: string, line: string): void {
  const key = progressKey(line)
  if (key) {
    const last = logs.value[logs.value.length - 1]
    if (last && last.key === key) {
      last.line = line
      return
    }
  }
  logs.value.push({ stream, line, key })
  if (logs.value.length > 600) logs.value.splice(0, logs.value.length - 600)
  scrollLog()
}

function scrollLog(): void {
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  })
}

async function start(): Promise<void> {
  if (!plan.value) {
    await buildPlan()
    if (!plan.value) {
      toast(planError.value || '参数有误，请检查目录', 'error')
      return
    }
  }
  logs.value = []
  running.value = true
  doneOk.value = null
  doneDir.value = ''
  try {
    const { taskId: id } = await window.api.clone.run(plan.value)
    taskId.value = id
    rememberDir(target.value, parentDir.value)
    logs.value.push({
      stream: 'system',
      line: `任务已启动：${plan.value.action === 'update' ? '更新' : '克隆'} → ${plan.value.destDir}`,
      key: ''
    })
  } catch (err: any) {
    running.value = false
    toast(`启动失败：${err.message}`, 'error', 6000)
  }
}

async function cancel(): Promise<void> {
  if (!taskId.value) return
  await window.api.clone.cancel(taskId.value)
  running.value = false
  logs.value.push({ stream: 'system', line: '已请求停止', key: '' })
}

async function reveal(): Promise<void> {
  if (!plan.value) return
  try {
    const res = await window.api.clone.reveal(plan.value)
    if (!res.ok) toast(res.message, 'warn')
  } catch (err: any) {
    toast(`打开目录失败：${err.message}`, 'error')
  }
}

function lineClass(stream: string): string {
  if (stream === 'stderr') return 'l-stderr'
  if (stream === 'system') return 'l-system'
  return ''
}
</script>

<template>
  <div class="modal-mask" @click.self="!running && emit('close')">
    <div class="modal clone-modal">
      <div class="modal-head">
        <div>
          <h3>拉取到指定目录</h3>
          <p class="tiny muted" style="margin-top: 2px">{{ repo.full_name }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" :disabled="running" @click="emit('close')">关闭</button>
      </div>

      <div class="modal-body">
        <!-- 目标位置 -->
        <div class="section-title">拉取到哪里</div>
        <div class="target-tabs">
          <button
            :class="['target-tab', { active: target === 'windows' }]"
            :disabled="running"
            @click="target = 'windows'"
          >
            <strong>Windows 本地目录</strong>
            <span>
              {{ git?.windows ? `用本机 git 克隆（${git.windowsVersion || '已就绪'}）` : '未检测到 git.exe' }}
            </span>
          </button>
          <button
            :class="['target-tab', { active: target === 'wsl' }]"
            :disabled="running"
            @click="target = 'wsl'"
          >
            <strong>WSL 内目录</strong>
            <span>{{ git?.wsl ? `在 WSL 里克隆（${git.wslVersion}）` : 'WSL 内未检测到 git' }}</span>
          </button>
        </div>

        <!-- 目录 -->
        <div class="field" style="margin-top: 14px">
          <label>{{ target === 'windows' ? '父目录（仓库会放在这里的子文件夹）' : 'WSL 父目录（支持 ~ 开头）' }}</label>
          <div class="row">
            <input
              v-model="parentDir"
              class="input mono"
              :disabled="running"
              :placeholder="target === 'windows' ? 'D:\\code\\github' : '~/projects'"
            />
            <button
              v-if="target === 'windows'"
              class="btn btn-sm"
              :disabled="running"
              @click="pickWindowsDir"
            >
              浏览…
            </button>
          </div>
          <span v-if="target === 'wsl'" class="desc">
            常用：~/projects、~/code、/opt/apps；目录不存在会自动创建。
          </span>
        </div>

        <div class="grid-2" style="margin-top: 12px">
          <div class="field">
            <label>文件夹名</label>
            <input v-model="dirName" class="input mono" :disabled="running" placeholder="默认用仓库名" />
          </div>
          <div class="field">
            <label>分支 / 标签（可选）</label>
            <input v-model="branch" class="input mono" :disabled="running" placeholder="留空用默认分支" />
          </div>
        </div>

        <!-- 选项 -->
        <div class="section-title">选项</div>
        <div class="opt-grid">
          <label class="opt">
            <span class="opt-label">拉取深度</span>
            <select v-model.number="depth" class="select compact" :disabled="running">
              <option :value="1">浅克隆 depth=1（最快）</option>
              <option :value="50">浅克隆 depth=50</option>
              <option :value="0">完整历史（含所有分支）</option>
            </select>
          </label>
          <label class="opt">
            <span class="opt-label">目录已存在时</span>
            <select v-model="onExists" class="select compact" :disabled="running">
              <option value="update">更新（git pull）</option>
              <option value="fail">报错提示</option>
              <option value="new">自动加后缀新建</option>
            </select>
          </label>
          <label class="switch opt-switch">
            <input v-model="submodules" type="checkbox" :disabled="running" />
            <span class="track"></span>
            <span class="tiny">同时拉取子模块</span>
          </label>
          <label class="switch opt-switch">
            <input v-model="useProxy" type="checkbox" :disabled="running" />
            <span class="track"></span>
            <span class="tiny">使用设置里的代理</span>
          </label>
        </div>

        <!-- 计划 -->
        <div v-if="planError" class="probe-box probe-err">{{ planError }}</div>
        <div v-else-if="plan" class="dest-box">
          <div class="dest-line">
            <span class="badge" :class="plan.action === 'update' ? 'badge-amber' : 'badge-accent'">
              {{ actionText }}
            </span>
            <span class="mono dest-path" :title="plan.destDir">{{ plan.destDir }}</span>
          </div>
          <div class="dest-meta">
            <span v-if="plan.depth > 0" class="badge">depth={{ plan.depth }}</span>
            <span v-else class="badge">完整历史</span>
            <span v-if="plan.branch" class="badge">分支 {{ plan.branch }}</span>
            <span v-if="plan.submodules" class="badge">含子模块</span>
            <span v-if="plan.proxyText" class="badge badge-accent">代理 {{ plan.proxyText }}</span>
            <span v-if="existsNow" class="badge badge-amber">目录已存在</span>
            <span class="tiny muted">{{ plan.target === 'windows' ? '本机 git' : `WSL · ${plan.distro || '默认发行版'}` }}</span>
          </div>
          <div v-if="plan.warning" class="warn-inline">{{ plan.warning }}</div>
        </div>
        <div v-else-if="planning" class="probe-box"><span class="spin">◌</span> 正在检查目录…</div>

        <!-- 命令预览 -->
        <details class="script-fold">
          <summary>查看将要执行的命令</summary>
          <pre class="log script-pre">{{ plan?.script }}</pre>
        </details>

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
            {{ running ? '正在拉取…' : '点右下角「开始拉取」，git 的输出会实时显示在这里。' }}
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button v-if="doneOk === true" class="btn btn-sm" @click="reveal">在资源管理器打开</button>
        <div class="spacer"></div>
        <button v-if="running" class="btn btn-danger" @click="cancel">停止</button>
        <button class="btn" :disabled="running" @click="emit('close')">关闭</button>
        <button class="btn btn-primary" :disabled="!canRun" @click="start">
          {{ running ? '拉取中…' : actionText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.clone-modal {
  max-width: 760px;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 10px;
  font-size: 13px;
  font-weight: 600;
}
.section-title:first-child {
  margin-top: 0;
}
.target-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.target-tab {
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
.target-tab strong {
  font-size: 13px;
  font-weight: 600;
}
.target-tab span {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.45;
}
.target-tab:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
}
.target-tab.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.target-tab.active strong {
  color: var(--accent);
}
.target-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.opt-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 10px;
}
.opt-label {
  font-size: 12.5px;
  color: var(--text-2);
  white-space: nowrap;
}
.select.compact {
  width: auto;
  padding: 5px 26px 5px 10px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
}
.opt-switch {
  padding-top: 2px;
}
.dest-box {
  margin-top: 16px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
}
.dest-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dest-path {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dest-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.probe-box {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
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
.warn-inline {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--amber);
}
.script-fold {
  margin-top: 14px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}
.script-fold > summary {
  cursor: pointer;
  user-select: none;
  color: var(--text-2);
}
.script-pre {
  margin-top: 8px;
  max-height: 200px;
  font-size: 11.5px;
}
.log-box {
  height: 200px;
}
.log-placeholder {
  color: #6e7681;
  font-style: italic;
}
</style>
