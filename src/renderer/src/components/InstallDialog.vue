<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { RepoItem, ReleaseInfo, ReleaseAsset } from '../../../shared/types'
import { toast, state } from '../store'
import { formatBytes, timeAgo } from '../utils'

const props = defineProps<{ repo: RepoItem }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const loading = ref(true)
const release = ref<ReleaseInfo | null>(null)
const error = ref('')
const selected = ref<ReleaseAsset | null>(null)
const installDir = ref('')
const mode = ref<'manual' | 'silent'>('manual')

const downloading = ref(false)
const percent = ref(0)
const received = ref(0)
const total = ref(0)
const phase = ref<'download' | 'install' | 'done'>('download')
const result = ref<{ ok: boolean; message: string } | null>(null)
const taskId = ref('')

let offProgress: (() => void) | null = null
let offDone: (() => void) | null = null

const hasExe = computed(() => !!release.value?.assets.some((a) => /\.(exe|msi)$/i.test(a.name)))

onMounted(async () => {
  offProgress = window.api.events.onInstallProgress((e) => {
    if (e.taskId !== taskId.value) return
    percent.value = e.percent
    received.value = e.received
    total.value = e.total
    phase.value = e.phase
  })
  offDone = window.api.events.onInstallDone((e) => {
    if (e.taskId !== taskId.value) return
    downloading.value = false
    result.value = { ok: e.ok, message: e.message }
    if (e.ok) toast('安装流程已完成', 'ok')
  })

  // 默认安装目录：%LOCALAPPDATA%\Programs\<repo>
  if (state.settings.installDir) {
    installDir.value = state.settings.installDir
  } else {
    try {
      const info = await window.api.app.info()
      const base = info.userData.replace(/Roaming[\\/][^\\/]+$/i, 'Local\\Programs')
      installDir.value = base === info.userData ? `${info.userData}\\apps` : `${base}\\${props.repo.name}`
    } catch {
      installDir.value = ''
    }
  }
  mode.value = state.settings.installMode || 'manual'

  try {
    const r = await window.api.github.releases(props.repo.owner, props.repo.name)
    release.value = r
    if (r?.assets.length) {
      selected.value = r.assets.find((a) => a.recommended) || r.assets[0]
    }
  } catch (err: any) {
    error.value = err.message || String(err)
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  offProgress?.()
  offDone?.()
})

async function pickDir(): Promise<void> {
  const dir = await window.api.settings.pickDir('选择安装目录')
  if (dir) installDir.value = dir
}

function kindLabel(a: ReleaseAsset): string {
  if (a.kind === 'installer') return '安装包'
  if (a.kind === 'portable') return '免安装'
  if (a.kind === 'archive') return '压缩包'
  return '文件'
}

async function start(): Promise<void> {
  if (!selected.value) return
  if (mode.value === 'silent' && !installDir.value.trim()) {
    toast('静默安装需要先选择安装目录', 'warn')
    return
  }
  result.value = null
  percent.value = 0
  received.value = 0
  total.value = selected.value.size
  phase.value = 'download'
  downloading.value = true
  try {
    const { taskId: id } = await window.api.install.download({
      url: selected.value.downloadUrl,
      fileName: selected.value.name,
      mode: mode.value,
      installDir: installDir.value.trim(),
      // 这三个字段用于写管理台账：装完之后可以在「管理」页更新 / 卸载
      fullName: props.repo.full_name,
      name: props.repo.name,
      version: release.value?.tagName || ''
    })
    taskId.value = id
  } catch (err: any) {
    downloading.value = false
    toast(`启动下载失败：${err.message}`, 'error', 6000)
  }
}

async function cancel(): Promise<void> {
  if (taskId.value) await window.api.install.cancel(taskId.value)
  downloading.value = false
  toast('已取消', 'info')
}

function openReleasePage(): void {
  const url = release.value?.htmlUrl || `https://github.com/${props.repo.owner}/${props.repo.name}/releases`
  window.api.app.openExternal(url)
}

function openFile(): void {
  if (result.value?.message) {
    const m = result.value.message.match(/([A-Za-z]:\\[^\s，,]+\.(exe|msi))/i)
    if (m) window.api.app.openPath(m[1])
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="!downloading && emit('close')">
    <div class="modal install-modal">
      <div class="modal-head">
        <div>
          <h3>下载并安装到本机</h3>
          <p class="tiny muted" style="margin-top: 2px">{{ repo.full_name }}</p>
        </div>
        <button class="btn btn-ghost btn-sm" :disabled="downloading" @click="emit('close')">
          关闭
        </button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="hint-box"><span class="spin">◌</span> 正在获取 Release 信息…</div>
        <div v-else-if="error" class="hint-box err">获取失败：{{ error }}</div>

        <template v-else-if="release">
          <div class="release-head">
            <div class="row">
              <span class="badge badge-accent">{{ release.tagName || 'latest' }}</span>
              <span class="tiny muted" v-if="release.publishedAt">
                发布于 {{ timeAgo(release.publishedAt) }}
              </span>
            </div>
            <button class="btn btn-ghost btn-sm" @click="openReleasePage">打开 Release 页面</button>
          </div>

          <div v-if="!release.assets.length" class="hint-box warn">
            这个版本没有可下载的文件，可能只在 Release 页面提供源码压缩包。
          </div>

          <template v-else>
            <div class="section-title">选择安装文件</div>
            <div class="asset-list">
              <label
                v-for="a in release.assets"
                :key="a.name"
                :class="['asset', { active: selected?.name === a.name }]"
              >
                <input v-model="selected" type="radio" :value="a" name="asset" :disabled="downloading" />
                <div class="asset-main">
                  <div class="asset-name">
                    <span class="mono">{{ a.name }}</span>
                    <span v-if="a.recommended" class="badge badge-green">推荐</span>
                    <span class="badge">{{ kindLabel(a) }}</span>
                  </div>
                  <div class="tiny muted">
                    {{ formatBytes(a.size) }}
                    <template v-if="!a.name.toLowerCase().endsWith('.exe') && !a.name.toLowerCase().endsWith('.msi')">
                      · 非 exe，需要自行解压
                    </template>
                  </div>
                </div>
              </label>
            </div>

            <div v-if="!hasExe" class="hint-box warn">
              这个项目没有提供 .exe / .msi 安装包，只能下载压缩包后手动解压使用。
            </div>
          </template>

          <div class="section-title">安装方式</div>
          <div class="mode-row">
            <label :class="['radio-card', { active: mode === 'manual' }]">
              <input v-model="mode" type="radio" value="manual" :disabled="downloading" />
              <div>
                <strong>手动安装</strong>
                <span>下载完自动打开安装向导，自己点下一步</span>
              </div>
            </label>
            <label :class="['radio-card', { active: mode === 'silent' }]">
              <input v-model="mode" type="radio" value="silent" :disabled="downloading" />
              <div>
                <strong>静默安装到指定目录</strong>
                <span>NSIS 安装包支持 /S /D，一步到位</span>
              </div>
            </label>
          </div>

          <div v-if="mode === 'silent'" class="field" style="margin-top: 12px">
            <label>安装目录</label>
            <div class="row">
              <input v-model="installDir" class="input mono" :disabled="downloading" />
              <button class="btn" :disabled="downloading" @click="pickDir">浏览</button>
            </div>
            <span class="desc">
              路径建议不要带空格，部分 NSIS 安装包对空格路径支持不好。不是 NSIS 的安装包可能忽略这个目录。
            </span>
          </div>

          <!-- 进度 -->
          <div v-if="downloading || result" class="progress-wrap">
            <div class="row tiny muted" style="margin-bottom: 6px">
              <span v-if="phase === 'download'">正在下载…</span>
              <span v-else-if="phase === 'install'">下载完成，正在安装…</span>
              <span v-else>处理完成</span>
              <div class="spacer"></div>
              <span class="mono">{{ formatBytes(received) }} / {{ formatBytes(total) }}</span>
            </div>
            <div class="progress">
              <div
                class="bar"
                :class="{ installing: phase !== 'download' }"
                :style="{ width: `${
                  phase === 'download' ? percent : phase === 'install' ? 100 : 100
                }%` }"
              ></div>
            </div>
            <div v-if="result" :class="['result-box', result.ok ? 'ok' : 'err']">
              {{ result.message }}
              <button
                v-if="result.ok && /[A-Za-z]:\\/.test(result.message)"
                class="btn btn-sm"
                style="margin-left: 8px"
                @click="openFile"
              >
                打开所在目录
              </button>
            </div>
          </div>
        </template>

        <div v-else class="hint-box warn">
          没有找到 Release 记录，这个项目可能没有发布过版本。
        </div>
      </div>

      <div class="modal-foot">
        <button v-if="downloading" class="btn btn-danger" @click="cancel">取消下载</button>
        <div class="spacer"></div>
        <button class="btn" :disabled="downloading" @click="emit('close')">关闭</button>
        <button
          class="btn btn-primary"
          :disabled="downloading || !selected"
          @click="start"
        >
          {{ downloading ? '处理中…' : '下载并安装' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.install-modal {
  max-width: 720px;
}
.hint-box {
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.hint-box.err {
  background: var(--red-soft);
  color: var(--red);
}
.hint-box.warn {
  background: var(--amber-soft);
  color: var(--amber);
  margin-top: 10px;
}
.release-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.section-title {
  margin: 18px 0 10px;
  font-size: 13px;
  font-weight: 600;
}
.asset-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}
.asset {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.asset:hover {
  background: var(--bg-subtle);
}
.asset.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.asset input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.asset-main {
  min-width: 0;
  flex: 1;
}
.asset-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
}
.mode-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.radio-card {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.radio-card:hover {
  background: var(--bg-subtle);
}
.radio-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.radio-card input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.radio-card strong {
  display: block;
  font-size: 13px;
}
.radio-card span {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.45;
}
.progress-wrap {
  margin-top: 18px;
}
.progress {
  height: 6px;
  background: var(--bg-subtle);
  border-radius: 999px;
  overflow: hidden;
}
.bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.bar.installing {
  background: var(--green);
}
.result-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.result-box.ok {
  background: var(--green-soft);
  color: var(--green);
}
.result-box.err {
  background: var(--red-soft);
  color: var(--red);
}
</style>
