<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { ManagedItem, ManagedAppItem, ManagedDockerItem, ManagedAction } from '../../../shared/types'
import { toast } from '../store'

const emit = defineEmits<{
  (e: 'go-search'): void
  (e: 'go-boards'): void
  (e: 'go-containers'): void
}>()

const items = ref<ManagedItem[]>([])
const loading = ref(true)
const loaded = ref(false)
const error = ref('')
const busyId = ref('')
const busyText = ref('')

const confirmItem = ref<ManagedItem | null>(null)
const logModal = ref<{ title: string; text: string } | null>(null)

const apps = computed(() => items.value.filter((i): i is ManagedAppItem => i.kind === 'app'))
const dockers = computed(() => items.value.filter((i): i is ManagedDockerItem => i.kind === 'docker'))
const updateCount = computed(() => apps.value.filter((a) => a.updateAvailable).length)
const runningCount = computed(() => dockers.value.filter((d) => d.state === 'running').length)

const busy = computed(() => !!busyId.value)

onMounted(() => void load())

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  error.value = ''
  try {
    items.value = await window.api.manage.list()
    loaded.value = true
  } catch (err: any) {
    error.value = err?.message || String(err)
    if (silent) toast(`刷新失败：${error.value}`, 'error', 6000)
  } finally {
    loading.value = false
  }
}

function modeLabel(m: ManagedDockerItem['mode']): string {
  if (m === 'compose') return 'docker compose'
  if (m === 'dockerfile') return 'Dockerfile 单容器'
  return '手动 docker run'
}

function stateLabel(d: ManagedDockerItem): { text: string; cls: string } {
  if (d.state === 'running') return { text: '运行中', cls: 'on' }
  if (d.state === 'exited') return { text: '已停止', cls: 'off' }
  if (d.state === 'missing') return { text: '容器丢失', cls: 'lost' }
  return { text: '状态未知', cls: 'unknown' }
}

function sizeText(mb: number): string {
  if (!mb) return ''
  if (mb < 1024) return `${mb} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function openRepo(fullName: string): void {
  if (/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    window.api.app.openExternal(`https://github.com/${fullName}`)
  }
}

async function run(item: ManagedItem, act: ManagedAction): Promise<void> {
  if (act === 'uninstall') {
    confirmItem.value = item
    return
  }
  await exec(item, act)
}

async function exec(item: ManagedItem, act: ManagedAction): Promise<void> {
  if (busy.value) return
  busyId.value = item.id
  busyText.value =
    act === 'update' ? '正在更新…' : act === 'start' ? '正在启动…' : act === 'stop' ? '正在停止…' : '处理中…'
  try {
    const r = await window.api.manage.action(item.id, act)
    if (r.ok) toast(r.message, 'ok', 4000)
    else toast(r.message || '操作失败', 'warn', 5000)
    if (r.output && !r.ok) logModal.value = { title: `${item.name} · 执行输出`, text: r.output }
  } catch (err: any) {
    const msg = String(err?.message || err)
    const lines = msg.split('\n')
    toast(lines[0], 'error', 6000)
    if (lines.length > 1) logModal.value = { title: `${item.name} · 错误详情`, text: msg }
  } finally {
    busyId.value = ''
    busyText.value = ''
    await load(true)
  }
}

async function confirmUninstall(): Promise<void> {
  const item = confirmItem.value
  confirmItem.value = null
  if (!item) return
  await exec(item, 'uninstall')
}

async function openItem(item: ManagedItem): Promise<void> {
  try {
    await window.api.manage.open(item.id)
  } catch (err: any) {
    toast(err?.message || '打开失败', 'error', 5000)
  }
}

async function attachDir(item: ManagedItem): Promise<void> {
  if (busy.value) return
  try {
    items.value = await window.api.manage.attachDir(item.id)
    toast('目录已关联，已重新扫描主程序', 'ok', 3500)
    await load(true)
  } catch (err: any) {
    toast(err?.message || '指定目录失败', 'error', 5000)
  }
}

async function showLogs(item: ManagedItem): Promise<void> {
  if (busy.value) return
  busyId.value = item.id
  busyText.value = '正在读取日志…'
  try {
    const text = await window.api.manage.logs(item.id, 200)
    logModal.value = { title: `${item.name} · 最近 200 行日志`, text }
  } catch (err: any) {
    toast(err?.message || '读取日志失败', 'error', 5000)
  } finally {
    busyId.value = ''
    busyText.value = ''
  }
}
</script>

<template>
  <section class="manage">
    <div class="m-head">
      <div>
        <h2>本机管理</h2>
        <p class="tiny muted">
          只显示通过 GitFinder 装过或部署过的东西。安装目录、容器名、版本都记在本机
          <span class="mono">managed.json</span> 里，不会去猜系统里的其他程序。
        </p>
      </div>
      <div class="row">
        <span v-if="updateCount" class="badge badge-green">{{ updateCount }} 个可更新</span>
        <span v-if="dockers.length" class="badge">{{ runningCount }}/{{ dockers.length }} 个服务在跑</span>
        <button class="btn btn-sm" :disabled="loading || busy" @click="load()">
          <span v-if="loading" class="spin">◌</span>
          {{ loading ? '探测中…' : '刷新状态' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="state-box error-box">
      <strong>读取失败</strong>
      <p>{{ error }}</p>
      <button class="btn btn-sm" @click="load()">重试</button>
    </div>

    <div v-else-if="loading && !loaded" class="state-box">
      <div class="skeleton" v-for="i in 3" :key="i"></div>
    </div>

    <div v-else-if="!items.length" class="state-box empty-box">
      <div class="empty-icon">📦</div>
      <h3>还没有装过或部署过东西</h3>
      <p class="muted">
        在搜索结果里点「安装到本机」或「部署到 Docker」，完成后会自动出现在这里，可以启动、更新、卸载。
      </p>
      <div class="row" style="justify-content: center; margin-top: 14px">
        <button class="btn btn-primary btn-sm" @click="emit('go-search')">去搜索项目</button>
        <button class="btn btn-sm" @click="emit('go-boards')">看看榜单</button>
      </div>
    </div>

    <template v-else>
      <!-- 本机应用 -->
      <div class="group">
        <div class="group-head">
          <h3>本机应用 <span class="tiny muted">{{ apps.length }}</span></h3>
          <span class="tiny muted">exe / msi 安装的程序</span>
        </div>

        <div v-if="!apps.length" class="group-empty tiny muted">还没有通过「安装到本机」装过程序</div>

        <article v-for="a in apps" :key="a.id" class="m-row" :class="{ busy: busyId === a.id }">
          <div class="m-ico app">▣</div>
          <div class="m-body">
            <div class="m-title">
              <strong>{{ a.displayName || a.name }}</strong>
              <span class="badge">{{ a.version || '版本未知' }}</span>
              <span v-if="a.state === 'installed'" class="badge badge-green">已安装</span>
              <span v-else-if="a.state === 'missing'" class="badge badge-red">目录已丢失</span>
              <span v-else class="badge badge-amber">待确认目录</span>
              <span v-if="a.updateAvailable" class="badge badge-accent">
                可更新 {{ a.version || '?' }} → {{ a.latestVersion }}
              </span>
            </div>
            <div class="m-sub">
              <button class="link" :title="a.fullName" @click="openRepo(a.fullName)">{{ a.fullName }}</button>
              <span class="sep">·</span>
              <span class="mono ellipsis" :title="a.installDir">{{ a.installDir || '未记录安装目录' }}</span>
              <span v-if="a.sizeMb" class="sep">·</span>
              <span v-if="a.sizeMb">{{ sizeText(a.sizeMb) }}</span>
              <span v-if="a.manual" class="sep">·</span>
              <span v-if="a.manual" class="warn-text">手动安装，路径未确认</span>
            </div>
          </div>
          <div class="m-actions">
            <span v-if="busyId === a.id" class="tiny muted busy-text">{{ busyText }}</span>
            <template v-else>
              <button v-if="a.state === 'manual' || a.state === 'missing'" class="btn btn-sm" @click="attachDir(a)">
                指定目录
              </button>
              <button v-if="a.state === 'installed'" class="btn btn-sm" @click="openItem(a)">打开目录</button>
              <button
                v-if="a.state === 'installed' && a.exePath"
                class="btn btn-sm"
                @click="run(a, 'start')"
              >
                启动
              </button>
              <button
                v-if="a.state !== 'manual'"
                class="btn btn-sm"
                :disabled="!a.updateAvailable"
                :title="a.updateAvailable ? `更新到 ${a.latestVersion}` : '已是最新版本'"
                @click="run(a, 'update')"
              >
                更新
              </button>
              <button
                v-if="a.state === 'installed'"
                class="btn btn-sm btn-danger-ghost"
                @click="run(a, 'uninstall')"
              >
                卸载
              </button>
              <button class="btn btn-sm btn-ghost" title="只删除记录，不动磁盘文件" @click="run(a, 'forget')">
                移除记录
              </button>
            </template>
          </div>
        </article>
      </div>

      <!-- Docker 服务 -->
      <div class="group">
        <div class="group-head">
          <h3>Docker 服务 <span class="tiny muted">{{ dockers.length }}</span></h3>
          <button class="tiny link" title="不限于 GitFinder 部署的，WSL 里的容器都能看" @click="emit('go-containers')">
            WSL 里全部容器 →
          </button>
        </div>

        <div v-if="!dockers.length" class="group-empty tiny muted">
          还没有通过「部署到 WSL Docker」跑过服务
        </div>

        <article v-for="d in dockers" :key="d.id" class="m-row" :class="{ busy: busyId === d.id }">
          <div class="m-ico docker" :class="stateLabel(d).cls">
            <span class="dot"></span>
          </div>
          <div class="m-body">
            <div class="m-title">
              <strong>{{ d.name }}</strong>
              <span class="state-chip" :class="stateLabel(d).cls">{{ stateLabel(d).text }}</span>
              <span class="badge">{{ modeLabel(d.mode) }}</span>
              <a class="port" href="#" @click.prevent="openItem(d)">localhost:{{ d.hostPort }}</a>
            </div>
            <div class="m-sub">
              <button class="link" :title="d.fullName" @click="openRepo(d.fullName)">{{ d.fullName }}</button>
              <span class="sep">·</span>
              <span class="mono ellipsis" :title="d.dir">{{ d.dir }}</span>
              <span v-if="d.sizeMb" class="sep">·</span>
              <span v-if="d.sizeMb">{{ sizeText(d.sizeMb) }}</span>
              <span v-if="d.statusText" class="sep">·</span>
              <span v-if="d.statusText" class="ellipsis" :title="d.statusText">{{ d.statusText }}</span>
            </div>
            <div v-if="d.containers.length" class="m-chips">
              <span v-for="c in d.containers" :key="c" class="mini-chip mono">{{ c }}</span>
            </div>
          </div>
          <div class="m-actions">
            <span v-if="busyId === d.id" class="tiny muted busy-text">{{ busyText }}</span>
            <template v-else>
              <button class="btn btn-sm" :disabled="d.state !== 'running'" @click="openItem(d)">打开</button>
              <button
                v-if="d.state !== 'running'"
                class="btn btn-sm"
                @click="run(d, 'start')"
              >
                启动
              </button>
              <button v-else class="btn btn-sm" @click="run(d, 'stop')">停止</button>
              <button class="btn btn-sm" @click="run(d, 'restart')">重启</button>
              <button class="btn btn-sm" title="拉取代码 + 重新构建镜像" @click="run(d, 'update')">更新</button>
              <button class="btn btn-sm btn-ghost" @click="showLogs(d)">日志</button>
              <button class="btn btn-sm btn-danger-ghost" @click="run(d, 'uninstall')">卸载</button>
              <button class="btn btn-sm btn-ghost" title="只删除记录，不动容器和磁盘文件" @click="run(d, 'forget')">
                移除记录
              </button>
            </template>
          </div>
        </article>
      </div>
    </template>

    <!-- 卸载确认 -->
    <div v-if="confirmItem" class="modal-mask" @click.self="confirmItem = null">
      <div class="modal confirm-modal">
        <div class="modal-head">
          <h3>确认卸载 {{ confirmItem.name }}？</h3>
          <button class="btn btn-ghost btn-sm" @click="confirmItem = null">取消</button>
        </div>
        <div class="modal-body">
          <template v-if="confirmItem.kind === 'app'">
            <p class="confirm-text">
              会调用程序自带的卸载器静默卸载，安装目录
              <span class="mono">{{ confirmItem.installDir || '（未记录）' }}</span>
              通常会被一起删除。部分程序会把配置留在 <span class="mono">AppData</span> 里，需要自己清理。
            </p>
          </template>
          <template v-else>
            <p class="confirm-text">
              会执行 <span class="mono">{{ confirmItem.mode === 'compose' ? 'docker compose down -v' : 'docker rm -f' }}</span>
              ——容器、网络和<strong>数据卷</strong>都会被删掉，然后删除项目目录
              <span class="mono">{{ confirmItem.dir }}</span>
              。项目里的数据不会保留。
            </p>
            <p class="confirm-text tip">
              如果只想先腾出内存，用「停止」就好；要保留数据只删容器，可以手动执行 <span class="mono">docker rm -f</span> 后回到这里「移除记录」。
            </p>
          </template>
          <div class="row confirm-actions">
            <div class="spacer"></div>
            <button class="btn" @click="confirmItem = null">取消</button>
            <button class="btn btn-danger" @click="confirmUninstall">确认卸载</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 输出 / 日志 -->
    <div v-if="logModal" class="modal-mask" @click.self="logModal = null">
      <div class="modal log-modal">
        <div class="modal-head">
          <h3>{{ logModal.title }}</h3>
          <button class="btn btn-ghost btn-sm" @click="logModal = null">关闭</button>
        </div>
        <div class="modal-body">
          <pre class="log-box">{{ logModal.text }}</pre>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.manage {
  flex: 1;
  overflow-y: auto;
  padding: 18px 24px 40px;
}
.m-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  max-width: 1180px;
  margin: 0 auto 16px;
}
.m-head h2 {
  font-size: 16px;
  font-weight: 650;
}
.m-head p {
  margin-top: 4px;
  line-height: 1.6;
  max-width: 720px;
}
.group {
  max-width: 1180px;
  margin: 0 auto 20px;
}
.group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 0 2px 8px;
}
.group-head h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.group-empty {
  padding: 14px 16px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
}

.m-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.m-row:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.m-row.busy {
  border-color: var(--accent);
  background: #fbfdff;
}
.m-ico {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-subtle);
  color: var(--text-3);
  font-size: 13px;
}
.m-ico.app {
  background: var(--accent-soft);
  color: var(--accent);
}
.m-ico.docker .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
}
.m-ico.docker.on {
  background: var(--green-soft);
}
.m-ico.docker.on .dot {
  background: var(--green);
  box-shadow: 0 0 0 3px rgba(26, 127, 55, 0.15);
}
.m-ico.docker.off {
  background: var(--amber-soft);
}
.m-ico.docker.off .dot {
  background: var(--amber);
}
.m-ico.docker.lost,
.m-ico.docker.unknown {
  background: var(--bg-subtle);
}

.m-body {
  flex: 1;
  min-width: 0;
}
.m-title {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.m-title strong {
  font-size: 13.5px;
  font-weight: 650;
}
.m-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-3);
  min-width: 0;
}
.m-sub .ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42ch;
}
.sep {
  color: var(--border-strong);
}
.link {
  color: var(--text-2);
  font-size: 11.5px;
}
.link:hover {
  color: var(--accent);
  text-decoration: underline;
}
.port {
  font-size: 12px;
  color: var(--accent);
  font-family: var(--mono);
}
.port:hover {
  text-decoration: underline;
}
.warn-text {
  color: var(--amber);
}
.m-chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.mini-chip {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-subtle);
  color: var(--text-3);
}
.state-chip {
  font-size: 11px;
  font-weight: 600;
  padding: 0 7px;
  border-radius: 999px;
}
.state-chip.on {
  background: var(--green-soft);
  color: var(--green);
}
.state-chip.off {
  background: var(--amber-soft);
  color: var(--amber);
}
.state-chip.lost {
  background: var(--red-soft);
  color: var(--red);
}
.state-chip.unknown {
  background: var(--bg-subtle);
  color: var(--text-3);
}

.m-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 430px;
  flex-shrink: 0;
}
.busy-text {
  padding-right: 4px;
}
.btn-danger-ghost {
  color: var(--red);
  border-color: #f3c7c3;
}
.btn-danger-ghost:hover:not(:disabled) {
  background: var(--red-soft);
  border-color: var(--red);
}

.confirm-modal {
  max-width: 560px;
}
.confirm-text {
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-2);
}
.confirm-text.tip {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  font-size: 12px;
}
.confirm-actions {
  margin-top: 18px;
}
.log-modal {
  max-width: 780px;
}
.log-box {
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 12px 14px;
  background: #1f2328;
  color: #d1d9e0;
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 空状态、骨架沿用全局风格 */
.state-box {
  max-width: 640px;
  margin: 48px auto;
  text-align: center;
}
.empty-box h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.empty-box p {
  font-size: 13px;
  line-height: 1.7;
}
.empty-icon {
  font-size: 34px;
  margin-bottom: 10px;
}
.skeleton {
  height: 64px;
  border-radius: var(--radius);
  background: linear-gradient(90deg, #eef0f3 25%, #f6f7f9 50%, #eef0f3 75%);
  background-size: 200% 100%;
  animation: shimmer 1.3s infinite;
  margin-bottom: 10px;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
.error-box {
  padding: 16px 18px;
  background: var(--red-soft);
  border: 1px solid #ffcecb;
  border-radius: var(--radius);
  text-align: left;
}
.error-box strong {
  color: var(--red);
  font-size: 13.5px;
}
.error-box p {
  margin: 6px 0 10px;
  font-size: 12.5px;
  color: #8c1d18;
  white-space: pre-wrap;
}
</style>
