<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type {
  ContainerAction,
  ContainerGroup,
  ContainerInfo,
  ContainerOverview,
  ContainerPort
} from '../../../shared/types'
import { toast } from '../store'

const emit = defineEmits<{ (e: 'go-manage'): void }>()

const data = ref<ContainerOverview | null>(null)
const loading = ref(true)
const loaded = ref(false)
const error = ref('')
const distro = ref('')
const kw = ref('')
const filter = ref<'all' | 'running' | 'stopped' | 'port'>('all')
const grouped = ref(localStorage.getItem('gitfinder.containers.grouped') !== '0')

const busyName = ref('')
const busyText = ref('')
const confirmRemove = ref<ContainerInfo | null>(null)
const logModal = ref<{ title: string; text: string } | null>(null)

const allContainers = computed<ContainerInfo[]>(() =>
  (data.value?.groups || []).flatMap((g) => g.containers)
)

const imageCount = computed(() => new Set(allContainers.value.map((c) => c.image)).size)

const counts = computed(() => {
  const list = allContainers.value
  return {
    all: list.length,
    running: list.filter((c) => c.state === 'running').length,
    stopped: list.filter((c) => c.state !== 'running').length,
    port: list.filter((c) => c.ports.some((p) => p.host)).length
  }
})

const filters = computed(() => [
  { key: 'all' as const, label: '全部', n: counts.value.all },
  { key: 'running' as const, label: '运行中', n: counts.value.running },
  { key: 'stopped' as const, label: '已停止', n: counts.value.stopped },
  { key: 'port' as const, label: '有端口', n: counts.value.port }
])

const visibleGroups = computed<ContainerGroup[]>(() => {
  if (!data.value) return []
  const k = kw.value.trim().toLowerCase()
  const hit = (c: ContainerInfo): boolean => {
    if (filter.value === 'running' && c.state !== 'running') return false
    if (filter.value === 'stopped' && c.state === 'running') return false
    if (filter.value === 'port' && !c.ports.some((p) => p.host)) return false
    if (!k) return true
    const hay = [
      c.name,
      c.image,
      c.project,
      c.service,
      c.id,
      ...c.ports.map((p) => `${p.host ?? ''} ${p.container} ${p.protocol}`)
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(k)
  }

  if (!grouped.value) {
    const list = allContainers.value.filter(hit)
    if (!list.length) return []
    return [
      {
        key: '__flat__',
        name: '全部容器',
        workDir: '',
        composeFiles: '',
        containers: list,
        running: list.filter((c) => c.state === 'running').length
      }
    ]
  }

  const out: ContainerGroup[] = []
  for (const g of data.value.groups) {
    const list = g.containers.filter(hit)
    if (!list.length) continue
    out.push({ ...g, containers: list, running: list.filter((c) => c.state === 'running').length })
  }
  return out
})

const shownCount = computed(() => visibleGroups.value.reduce((n, g) => n + g.containers.length, 0))

onMounted(() => void load())

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  error.value = ''
  try {
    const res = await window.api.containers.overview(distro.value || undefined)
    data.value = res
    distro.value = res.distro
    if (res.error) error.value = res.error
    loaded.value = true
  } catch (err: any) {
    error.value = String(err?.message || err)
    if (silent) toast(`刷新失败：${error.value}`, 'error', 6000)
  } finally {
    loading.value = false
  }
}

function toggleGrouped(): void {
  grouped.value = !grouped.value
  localStorage.setItem('gitfinder.containers.grouped', grouped.value ? '1' : '0')
}

/* ---------------- 展示辅助 ---------------- */

function stateCls(c: ContainerInfo): string {
  if (c.state === 'running') return 'on'
  if (c.state === 'paused' || c.state === 'restarting') return 'wait'
  if (c.state === 'dead') return 'bad'
  return 'off'
}

function stateText(c: ContainerInfo): string {
  switch (c.state) {
    case 'running':
      return '运行中'
    case 'exited':
      return '已停止'
    case 'paused':
      return '已暂停'
    case 'restarting':
      return '重启中'
    case 'created':
      return '未启动'
    case 'dead':
      return '异常'
    default:
      return '状态未知'
  }
}

function createdText(raw: string): string {
  const s = String(raw || '').trim()
  return s ? s.slice(0, 16) : ''
}

/** 优先挑一个能直接点的端口：先看 0.0.0.0/127.0.0.1，再看任意已发布端口 */
function primaryPort(c: ContainerInfo): ContainerPort | null {
  const published = c.ports.filter((p) => p.host)
  if (!published.length) return null
  return (
    published.find((p) => p.bind === '0.0.0.0' || p.bind === '127.0.0.1') || published[0]
  )
}

function portLabel(p: ContainerPort): string {
  return p.host ? `${p.host} → ${p.container}` : `${p.container}/${p.protocol}`
}

/** 已发布到宿主机的端口，做成可点的 chip */
function publishedPorts(c: ContainerInfo): ContainerPort[] {
  return c.ports.filter((p) => p.host)
}

/** 容器内端口（Dockerfile EXPOSE），点了也没用，只在副行里提一句 */
function internalPorts(c: ContainerInfo): string[] {
  return c.ports.filter((p) => !p.host).map((p) => `${p.container}/${p.protocol}`)
}

async function openPort(p: ContainerPort | null): Promise<void> {
  if (!p || !p.host) return
  try {
    // 只绑了 127.0.0.1 的也能从本机访问
    await window.api.app.openExternal(`http://localhost:${p.host}`)
  } catch (err: any) {
    toast(err?.message || '打开失败', 'error', 5000)
  }
}

async function revealDir(g: ContainerGroup): Promise<void> {
  if (!g.workDir) return
  try {
    await window.api.containers.reveal({ distro: distro.value, dir: g.workDir })
  } catch (err: any) {
    toast(err?.message || '打开目录失败', 'error', 5000)
  }
}

/* ---------------- 操作 ---------------- */

async function run(c: ContainerInfo, action: ContainerAction): Promise<void> {
  if (busyName.value) return
  busyName.value = c.name
  busyText.value =
    action === 'remove'
      ? '正在删除…'
      : action === 'restart'
        ? '正在重启…'
        : action === 'stop'
          ? '正在停止…'
          : '处理中…'
  try {
    const r = await window.api.containers.action({
      distro: distro.value,
      name: c.name,
      action
    })
    toast(r.message, 'ok', 4000)
    if (r.output && /warn|error|fail/i.test(r.output)) {
      logModal.value = { title: `${c.name} · 执行输出`, text: r.output }
    }
  } catch (err: any) {
    const msg = String(err?.message || err)
    toast(msg.split('\n')[0], 'error', 6000)
    if (msg.includes('\n')) logModal.value = { title: `${c.name} · 错误详情`, text: msg }
  } finally {
    busyName.value = ''
    busyText.value = ''
    await load(true)
  }
}

async function confirmDoRemove(): Promise<void> {
  const c = confirmRemove.value
  confirmRemove.value = null
  if (c) await run(c, 'remove')
}

async function showLogs(c: ContainerInfo): Promise<void> {
  if (busyName.value) return
  busyName.value = c.name
  busyText.value = '正在读取日志…'
  try {
    const text = await window.api.containers.logs({ distro: distro.value, name: c.name, tail: 300 })
    logModal.value = { title: `${c.name} · 最近 300 行日志`, text }
  } catch (err: any) {
    toast(err?.message || '读取日志失败', 'error', 5000)
  } finally {
    busyName.value = ''
    busyText.value = ''
  }
}
</script>

<template>
  <section class="containers">
    <div class="c-head">
      <div>
        <h2>WSL 容器</h2>
        <p class="tiny muted">
          直接读 WSL 里的 docker，把<strong>全部容器</strong>列出来（含已停止的），按 compose
          项目分组。这里的不一定都由 GitFinder 部署，可以照样启停、看日志。
        </p>
      </div>
      <div class="row">
        <select v-if="(data?.distros?.length || 0) > 1" v-model="distro" class="distro-select" @change="load()">
          <option v-for="d in data?.distros || []" :key="d" :value="d">{{ d }}</option>
        </select>
        <span v-if="distro && (data?.distros?.length || 0) <= 1" class="badge mono">{{ distro }}</span>
        <button class="btn btn-sm" :disabled="loading" @click="load()">
          <span v-if="loading" class="spin">◌</span>
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- docker 没装 / 没启动 / 读取失败 -->
    <div v-if="error && !allContainers.length" class="state-box error-box">
      <strong>{{ data?.docker === false && !error.includes('没有安装') ? '读不到容器列表' : 'Docker 不可用' }}</strong>
      <p>{{ error }}</p>
      <div class="row" style="margin-top: 4px">
        <button class="btn btn-sm" @click="load()">重试</button>
      </div>
    </div>

    <div v-else-if="loading && !loaded" class="state-box">
      <div v-for="i in 3" :key="i" class="skeleton"></div>
    </div>

    <template v-else>
      <div class="c-toolbar">
        <div class="c-search">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" stroke-linecap="round" />
          </svg>
          <input v-model="kw" placeholder="搜容器名 / 镜像 / 项目 / 端口" spellcheck="false" />
          <button v-if="kw" class="clear-x" title="清空" @click="kw = ''">×</button>
        </div>

        <div class="seg">
          <button
            v-for="f in filters"
            :key="f.key"
            class="seg-btn"
            :class="{ on: filter === f.key }"
            @click="filter = f.key"
          >
            {{ f.label }}<span class="seg-n">{{ f.n }}</span>
          </button>
        </div>

        <button class="btn btn-sm btn-ghost" :class="{ 'is-on': grouped }" @click="toggleGrouped">
          {{ grouped ? '按项目分组' : '平铺列表' }}
        </button>
      </div>

      <div class="c-stats">
        <span class="stat on"><i></i>{{ data?.running ?? 0 }} 运行中</span>
        <span class="stat">{{ data?.stopped ?? 0 }} 已停止</span>
        <span class="stat">{{ counts.all }} 个容器 · {{ imageCount }} 个镜像 · {{ data?.exposedPorts ?? 0 }} 个端口</span>
        <span v-if="data?.version" class="stat mono">docker {{ data.version }}</span>
        <span v-if="shownCount !== counts.all" class="stat filtered">筛出 {{ shownCount }} 个</span>
      </div>

      <div v-if="error && allContainers.length" class="warn-bar tiny">
        {{ error }}
      </div>

      <div v-if="!counts.all" class="state-box empty-box">
        <div class="empty-icon">🐳</div>
        <h3>这个发行版里还没有容器</h3>
        <p class="muted">
          在 WSL 里 <span class="mono">docker run</span> 或
          <span class="mono">docker compose up -d</span> 起来的容器会自动出现在这里，不用先经过 GitFinder 部署。
        </p>
        <div class="row" style="justify-content: center; margin-top: 14px">
          <button class="btn btn-primary btn-sm" @click="emit('go-manage')">去管理页看已部署的服务</button>
        </div>
      </div>

      <div v-else-if="!shownCount" class="state-box empty-box">
        <h3>没有匹配的容器</h3>
        <p class="muted">换个关键词，或把筛选切回「全部」。</p>
      </div>

      <template v-else>
        <div v-for="g in visibleGroups" :key="g.key" class="cgroup">
          <div class="cgroup-head">
            <div class="cgroup-name">
              <h3>{{ g.name }}</h3>
              <span class="badge">{{ g.containers.length }}</span>
              <span v-if="g.key && g.running < g.containers.length" class="tiny muted">
                {{ g.running }}/{{ g.containers.length }} 运行中
              </span>
            </div>
            <button
              v-if="g.workDir"
              class="dir-link mono"
              :title="`在资源管理器打开 ${g.workDir}`"
              @click="revealDir(g)"
            >
              {{ g.workDir }}
            </button>
          </div>

          <article
            v-for="c in g.containers"
            :key="c.name"
            class="crow"
            :class="{ busy: busyName === c.name }"
          >
            <span class="dot" :class="stateCls(c)"></span>

            <div class="cbody">
              <div class="ctitle">
                <strong class="mono">{{ c.name }}</strong>
                <span class="state-chip" :class="stateCls(c)">{{ stateText(c) }}</span>
                <span v-if="c.managed" class="badge badge-green" title="这条容器对得上管理页的记录">GitFinder</span>
                <span v-if="c.service" class="badge">{{ c.service }}</span>
              </div>

              <div class="csub">
                <span class="mono ellipsis" :title="c.image">{{ c.image }}</span>
                <span class="sep">·</span>
                <span class="ellipsis" :title="c.status">{{ c.status || '—' }}</span>
                <template v-if="createdText(c.createdAt)">
                  <span class="sep">·</span>
                  <span>创建于 {{ createdText(c.createdAt) }}</span>
                </template>
                <template v-if="internalPorts(c).length">
                  <span class="sep">·</span>
                  <span class="mono" title="只在容器网络内可用，没有映射到宿主机">
                    内部 {{ internalPorts(c).join(' / ') }}
                  </span>
                </template>
              </div>

              <div v-if="publishedPorts(c).length" class="cports">
                <button
                  v-for="p in publishedPorts(c)"
                  :key="`${p.container}-${p.protocol}`"
                  class="port-chip"
                  :title="`打开 http://localhost:${p.host}`"
                  @click="openPort(p)"
                >
                  <span class="port-dot"></span>{{ portLabel(p) }}
                </button>
              </div>
            </div>

            <div class="c-actions">
              <span v-if="busyName === c.name" class="tiny muted busy-text">{{ busyText }}</span>
              <template v-else>
                <button
                  v-if="c.state === 'running' && primaryPort(c)"
                  class="btn btn-sm"
                  @click="openPort(primaryPort(c))"
                >
                  打开
                </button>
                <button v-if="c.state === 'paused'" class="btn btn-sm" @click="run(c, 'unpause')">
                  恢复
                </button>
                <button v-else-if="c.state !== 'running'" class="btn btn-sm" @click="run(c, 'start')">
                  启动
                </button>
                <button v-else class="btn btn-sm" @click="run(c, 'stop')">停止</button>
                <button class="btn btn-sm btn-ghost" @click="run(c, 'restart')">重启</button>
                <button class="btn btn-sm btn-ghost" @click="showLogs(c)">日志</button>
                <button class="btn btn-sm btn-danger-ghost" @click="confirmRemove = c">删除</button>
              </template>
            </div>
          </article>
        </div>
      </template>
    </template>

    <!-- 删除确认 -->
    <div v-if="confirmRemove" class="modal-mask" @click.self="confirmRemove = null">
      <div class="modal confirm-modal">
        <div class="modal-head">
          <h3>删除容器 {{ confirmRemove.name }}？</h3>
          <button class="btn btn-ghost btn-sm" @click="confirmRemove = null">取消</button>
        </div>
        <div class="modal-body">
          <p class="confirm-text">
            会执行 <span class="mono">docker rm -f {{ confirmRemove.name }}</span>
            ——容器被强制停止并删除。<strong>镜像和数据卷不会动</strong>，数据卷里的数据还在，但容器内的临时文件会丢。
          </p>
          <p v-if="confirmRemove.project" class="confirm-text tip">
            这个容器属于 compose 项目「{{ confirmRemove.project }}」。如果整套服务都不要了，去「管理」页卸载更干净
            （会 `docker compose down -v` 并删掉项目目录）；只在命令行里删容器，下次
            <span class="mono">compose up</span> 还会把它建回来。
          </p>
          <div class="row confirm-actions">
            <div class="spacer"></div>
            <button class="btn" @click="confirmRemove = null">取消</button>
            <button class="btn btn-danger" @click="confirmDoRemove">确认删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 日志 / 输出 -->
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
.containers {
  flex: 1;
  overflow-y: auto;
  padding: 18px 24px 40px;
}
.c-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  max-width: 1180px;
  margin: 0 auto 14px;
}
.c-head h2 {
  font-size: 16px;
  font-weight: 650;
}
.c-head p {
  margin-top: 4px;
  line-height: 1.6;
  max-width: 720px;
}
.distro-select {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  color: var(--text-2);
  font-size: 12px;
  max-width: 180px;
}

/* 工具条 */
.c-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  max-width: 1180px;
  margin: 0 auto 10px;
}
.c-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  min-width: 260px;
  flex: 1;
  max-width: 380px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  color: var(--text-3);
}
.c-search:focus-within {
  border-color: var(--accent);
}
.c-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 12.5px;
  color: var(--text);
}
.clear-x {
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
}
.seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.seg-btn.on {
  background: var(--bg-elev);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
.seg-n {
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.btn-ghost.is-on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 统计条 */
.c-stats {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  max-width: 1180px;
  margin: 0 auto 14px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  font-size: 11.5px;
  color: var(--text-3);
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.stat.on {
  color: var(--green);
  font-weight: 600;
}
.stat.on i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 3px rgba(26, 127, 55, 0.14);
}
.stat.filtered {
  color: var(--accent);
}
.warn-bar {
  max-width: 1180px;
  margin: 0 auto 12px;
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  background: var(--amber-soft);
  color: var(--amber);
  white-space: pre-wrap;
  word-break: break-all;
}

/* 分组 */
.cgroup {
  max-width: 1180px;
  margin: 0 auto 16px;
}
.cgroup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 2px 7px;
}
.cgroup-name {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.cgroup-name h3 {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-2);
}
.dir-link {
  max-width: 42ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  background: transparent;
  padding: 0;
  font-size: 11px;
  color: var(--text-3);
  cursor: pointer;
}
.dir-link:hover {
  color: var(--accent);
  text-decoration: underline;
}

/* 容器行 */
.crow {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 11px 14px;
  margin-bottom: 7px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.crow:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.crow.busy {
  border-color: var(--accent);
  background: #fbfdff;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 7px;
  flex-shrink: 0;
  background: var(--text-3);
}
.dot.on {
  background: var(--green);
  box-shadow: 0 0 0 3px rgba(26, 127, 55, 0.14);
}
.dot.off {
  background: #b9c2cc;
}
.dot.wait {
  background: var(--amber);
}
.dot.bad {
  background: var(--red);
}

.cbody {
  flex: 1;
  min-width: 0;
}
.ctitle {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.ctitle strong {
  font-size: 13px;
  font-weight: 650;
  word-break: break-all;
}
.csub {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-3);
  min-width: 0;
}
.csub .ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 34ch;
}
.sep {
  color: var(--border-strong);
}
.state-chip {
  font-size: 10.5px;
  font-weight: 600;
  padding: 0 7px;
  border-radius: 999px;
  white-space: nowrap;
}
.state-chip.on {
  background: var(--green-soft);
  color: var(--green);
}
.state-chip.off {
  background: var(--bg-subtle);
  color: var(--text-3);
}
.state-chip.wait {
  background: var(--amber-soft);
  color: var(--amber);
}
.state-chip.bad {
  background: var(--red-soft);
  color: var(--red);
}

.cports {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.port-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border: 1px solid #cfe0fb;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 10.5px;
  cursor: pointer;
}
.port-chip:hover:not(:disabled) {
  border-color: var(--accent);
}
.port-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}

.c-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 400px;
  flex-shrink: 0;
  padding-top: 2px;
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

/* 弹窗 */
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

/* 状态盒 */
.state-box {
  max-width: 640px;
  margin: 40px auto;
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
  height: 62px;
  border-radius: var(--radius);
  background: linear-gradient(90deg, #eef0f3 25%, #f6f7f9 50%, #eef0f3 75%);
  background-size: 200% 100%;
  animation: shimmer 1.3s infinite;
  margin-bottom: 8px;
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
  word-break: break-all;
}
</style>
