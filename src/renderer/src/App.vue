<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import {
  state,
  loadSettings,
  runSearch,
  fetchResults,
  changePage,
  applyFilter,
  toast
} from './store'
import { LANGUAGES, SORT_OPTIONS, formatNumber } from './utils'
import type { RepoItem } from '../../shared/types'
import RepoCard from './components/RepoCard.vue'
import BoardsView from './components/BoardsView.vue'
import DeployDialog from './components/DeployDialog.vue'
import CloneDialog from './components/CloneDialog.vue'
import InstallDialog from './components/InstallDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ReadmeDialog from './components/ReadmeDialog.vue'
import Toast from './components/Toast.vue'

const tab = ref<'search' | 'boards'>(
  localStorage.getItem('gitfinder.tab') === 'boards' ? 'boards' : 'search'
)
const settingsOpen = ref(false)
const settingsFocusToken = ref(false)
const settingsFocusAi = ref(false)
const boardsRef = ref<InstanceType<typeof BoardsView> | null>(null)
const trackedNames = ref<string[]>([])
const trackedSet = computed(() => new Set(trackedNames.value))
const deployRepo = ref<RepoItem | null>(null)
const cloneRepo = ref<RepoItem | null>(null)
const installRepo = ref<RepoItem | null>(null)
const readmeRepo = ref<RepoItem | null>(null)
const queryInput = ref<HTMLTextAreaElement | null>(null)

const examples = [
  '用 Rust 写的自托管图床',
  '开源的个人笔记软件，支持 Markdown 和双向链接',
  '轻量级的 Docker 可视化管理面板',
  '能本地跑大模型的聊天界面',
  'Vue3 + TypeScript 的后台管理模板',
  '自托管的 RSS 阅读器'
]

const pageCount = computed(() => Math.min(Math.ceil(state.total / state.perPage), 34))

onMounted(async () => {
  await loadSettings()
  queryInput.value?.focus()
  try {
    trackedNames.value = await window.api.board.tracked()
  } catch {
    trackedNames.value = []
  }
})

async function toggleTrack(repo: RepoItem): Promise<void> {
  try {
    trackedNames.value = await window.api.board.toggleTrack(repo.full_name, repo.stars)
    const on = trackedNames.value.includes(repo.full_name)
    toast(on ? `已加入追踪：${repo.full_name}` : `已取消追踪：${repo.full_name}`, 'ok')
  } catch (err: any) {
    toast(err?.message || '操作失败', 'error')
  }
}

function submit(useAi: boolean): void {
  if (state.polishing || state.searching) return
  runSearch({ useAi })
}

function useExample(text: string): void {
  state.query = text
  submit(state.aiEnabled)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit(state.aiEnabled)
  }
}

async function reSearchEdited(): Promise<void> {
  if (!state.effectiveQuery.trim()) return
  state.page = 1
  await fetchResults()
}

function deployFromReadme(repo: RepoItem): void {
  readmeRepo.value = null
  deployRepo.value = repo
}

function installFromReadme(repo: RepoItem): void {
  readmeRepo.value = null
  installRepo.value = repo
}

function cloneFromReadme(repo: RepoItem): void {
  readmeRepo.value = null
  cloneRepo.value = repo
}

/** README 读不到是因为没 Token 时，直接带到设置页 */
function openSettingsFromReadme(): void {
  readmeRepo.value = null
  settingsFocusToken.value = true
  settingsOpen.value = true
}

/** 榜单里点「译成中文」但还没配 AI：带到设置页并滚到 AI 区块 */
function openSettingsForAi(): void {
  settingsFocusAi.value = true
  settingsOpen.value = true
}

function closeSettings(): void {
  settingsOpen.value = false
  settingsFocusToken.value = false
  settingsFocusAi.value = false
}

/** AI 配置动过（换模型 / 填上 Key），让榜单用新配置把中文说明重算一遍 */
function onAiChanged(): void {
  boardsRef.value?.refresh()
}

function switchTab(next: 'search' | 'boards'): void {
  tab.value = next
  localStorage.setItem('gitfinder.tab', next)
  if (next === 'search') {
    setTimeout(() => queryInput.value?.focus(), 60)
  }
}
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">
        <div class="logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2 3 6.5v11L12 22l9-4.5v-11L12 2Z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path d="M12 7v10M7.5 9.5 12 12l4.5-2.5" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </div>
        <div class="brand-text">
          <h1>GitFinder</h1>
          <p>一句话描述，找到项目并跑起来</p>
        </div>
      </div>

      <div class="tabs">
        <button class="tab" :class="{ on: tab === 'search' }" @click="switchTab('search')">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" stroke-linecap="round" />
          </svg>
          搜索
        </button>
        <button class="tab" :class="{ on: tab === 'boards' }" @click="switchTab('boards')">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="9" width="2.8" height="5" rx="1" />
            <rect x="6.6" y="5.5" width="2.8" height="8.5" rx="1" />
            <rect x="11.2" y="2" width="2.8" height="12" rx="1" />
          </svg>
          榜单
        </button>
      </div>

      <div class="topbar-right">
        <span v-if="state.rateRemaining !== null" class="badge" :class="{
          'badge-red': state.rateRemaining <= 0,
          'badge-amber': state.rateRemaining > 0 && state.rateRemaining <= 3
        }">
          接口剩余 {{ state.rateRemaining }} 次
        </span>
        <button class="btn btn-sm" @click="settingsOpen = true">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          >
            <path d="M2.5 4.75h11M2.5 11.25h11" />
            <circle cx="5.5" cy="4.75" r="1.9" fill="var(--bg-elev)" />
            <circle cx="10.5" cy="11.25" r="1.9" fill="var(--bg-elev)" />
          </svg>
          设置
        </button>
      </div>
    </header>

    <section v-show="tab === 'search'" class="search-area">
      <div class="search-box">
        <textarea
          ref="queryInput"
          v-model="state.query"
          class="search-input"
          rows="2"
          placeholder="例如：用 Go 写的、能自托管的轻量级监控面板，最好带 Web UI"
          @keydown="onKeydown"
        ></textarea>
        <div class="search-actions">
          <button
            class="btn btn-primary search-btn"
            :disabled="state.searching || state.polishing"
            @click="submit(state.aiEnabled)"
          >
            <span v-if="state.polishing || state.searching" class="spin">◌</span>
            <span v-else>✨</span>
            {{ state.polishing ? 'AI 理解中…' : state.searching ? '搜索中…' : '搜索' }}
          </button>
        </div>
      </div>

      <div class="filter-bar">
        <label class="switch">
          <input v-model="state.aiEnabled" type="checkbox" />
          <span class="track"></span>
          <span class="tiny">AI 润色描述</span>
        </label>

        <select v-model="state.language" class="select compact" @change="applyFilter">
          <option v-for="l in LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>

        <select v-model="state.sort" class="select compact" @change="applyFilter">
          <option v-for="s in SORT_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>

        <button class="btn btn-ghost btn-sm" @click="submit(false)">跳过 AI 直接搜</button>

        <div class="spacer"></div>
        <span v-if="state.total" class="tiny muted">共 {{ formatNumber(state.total) }} 个仓库</span>
      </div>

      <!-- AI 改写结果 -->
      <div v-if="state.aiResult" class="ai-result">
        <div class="ai-head">
          <span class="ai-tag">✨ AI 改写</span>
          <span class="tiny muted">{{ state.aiResult.explain }}</span>
        </div>
        <div class="row" style="margin-top: 6px">
          <input v-model="state.effectiveQuery" class="input mono ai-query" />
          <button class="btn btn-sm" @click="reSearchEdited">用这个再搜</button>
        </div>
        <div v-if="state.aiResult.keywords.length" class="ai-keywords">
          <span v-for="k in state.aiResult.keywords" :key="k" class="badge">{{ k }}</span>
        </div>
      </div>
    </section>

    <main v-show="tab === 'search'" class="results">
      <!-- 错误 -->
      <div v-if="state.error" class="state-box error-box">
        <strong>搜索失败</strong>
        <p>{{ state.error }}</p>
        <button class="btn btn-sm" @click="settingsOpen = true">去设置检查 Token / 代理</button>
      </div>

      <!-- 首屏 -->
      <div v-else-if="!state.searched" class="state-box empty-box">
        <div class="empty-icon">🔍</div>
        <h2>说说你想找什么样的项目</h2>
        <p class="muted">
          用日常语言描述就行，AI 会把它翻译成 GitHub 能听懂的搜索语法。找到之后可以把代码克隆到任意目录，
          直接部署到 WSL 的 Docker，或者下载 exe 装到本机。
        </p>
        <div class="examples">
          <button v-for="ex in examples" :key="ex" class="example-chip" @click="useExample(ex)">
            {{ ex }}
          </button>
        </div>
      </div>

      <!-- 加载 -->
      <div v-else-if="state.searching && !state.results.length" class="state-box">
        <div class="skeleton" v-for="i in 4" :key="i"></div>
      </div>

      <!-- 空结果 -->
      <div v-else-if="!state.results.length" class="state-box empty-box">
        <div class="empty-icon">🤔</div>
        <h2>没搜到匹配的项目</h2>
        <p class="muted">
          试试换个说法，或者关掉 AI 润色直接用英文关键词；也可以把语言筛选改成「不限语言」。
        </p>
      </div>

      <!-- 结果列表 -->
      <div v-else class="list">
        <RepoCard
          v-for="(repo, i) in state.results"
          :key="repo.id"
          :repo="repo"
          :index="(state.page - 1) * state.perPage + i + 1"
          :tracked="trackedSet.has(repo.full_name)"
          @deploy="deployRepo = $event"
          @install="installRepo = $event"
          @detail="readmeRepo = $event"
          @clone="cloneRepo = $event"
          @track="toggleTrack"
        />
        <div class="pager">
          <button class="btn btn-sm" :disabled="state.page <= 1" @click="changePage(-1)">
            上一页
          </button>
          <span class="tiny muted">第 {{ state.page }} / {{ pageCount || 1 }} 页</span>
          <button
            class="btn btn-sm"
            :disabled="state.page >= pageCount"
            @click="changePage(1)"
          >
            下一页
          </button>
        </div>
      </div>
    </main>

    <BoardsView
      v-if="tab === 'boards'"
      ref="boardsRef"
      @deploy="deployRepo = $event"
      @install="installRepo = $event"
      @detail="readmeRepo = $event"
      @clone="cloneRepo = $event"
      @go-search="switchTab('search')"
      @open-settings="openSettingsForAi"
      @tracked-change="trackedNames = $event"
    />

    <SettingsDialog
      v-if="settingsOpen"
      :focus-token="settingsFocusToken"
      :focus-ai="settingsFocusAi"
      @close="closeSettings"
      @ai-changed="onAiChanged"
    />
    <DeployDialog v-if="deployRepo" :repo="deployRepo" @close="deployRepo = null" />
    <CloneDialog v-if="cloneRepo" :repo="cloneRepo" @close="cloneRepo = null" />
    <InstallDialog v-if="installRepo" :repo="installRepo" @close="installRepo = null" />
    <ReadmeDialog
      v-if="readmeRepo"
      :repo="readmeRepo"
      @close="readmeRepo = null"
      @deploy="deployFromReadme"
      @install="installFromReadme"
      @clone="cloneFromReadme"
      @open-settings="openSettingsFromReadme"
    />
    <Toast />
  </div>
</template>

<style scoped>
.layout {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.logo {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: linear-gradient(135deg, #1f6feb, #0a4bab);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(31, 111, 235, 0.3);
}
.brand-text h1 {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.2px;
}
.brand-text p {
  font-size: 11.5px;
  color: var(--text-3);
}
.topbar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-subtle);
  border-radius: 8px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 15px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-2);
  transition: all 0.15s;
}
.tab:hover {
  color: var(--text);
}
.tab.on {
  background: var(--bg-elev);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.search-area {
  padding: 16px 24px 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.search-box {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.search-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  resize: none;
  outline: none;
  line-height: 1.55;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.search-input:focus {
  border-color: var(--accent);
  background: var(--bg-elev);
  box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.12);
}
.search-actions {
  display: flex;
  align-items: stretch;
}
.search-btn {
  padding: 0 22px;
  border-radius: var(--radius);
  font-weight: 600;
}
.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.select.compact {
  width: auto;
  padding: 5px 26px 5px 10px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
}
.ai-result {
  margin-top: 10px;
  padding: 10px 12px;
  background: #f2f7ff;
  border: 1px solid #cfe0fb;
  border-radius: var(--radius-sm);
}
.ai-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ai-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.ai-query {
  font-size: 12.5px;
  padding: 6px 10px;
  background: #fff;
}
.ai-keywords {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.ai-keywords .badge {
  font-size: 11px;
  background: #fff;
  border-color: #cfe0fb;
  color: var(--accent);
}

.results {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px 32px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 1180px;
  margin: 0 auto;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 18px 0 4px;
}

.state-box {
  max-width: 720px;
  margin: 40px auto;
  text-align: center;
}
.empty-box h2 {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 8px;
}
.empty-box p {
  font-size: 13px;
  line-height: 1.7;
}
.empty-icon {
  font-size: 36px;
  margin-bottom: 12px;
}
.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 20px;
}
.example-chip {
  padding: 6px 13px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
  font-size: 12.5px;
  color: var(--text-2);
  transition: all 0.15s;
}
.example-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
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
  margin-top: 6px;
  font-size: 12.5px;
  color: #8c1d18;
  white-space: pre-wrap;
}
.skeleton {
  height: 92px;
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
</style>
