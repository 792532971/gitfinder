<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  BoardItem,
  BoardResult,
  ProfileInput,
  ProfileUpdateEvent,
  RepoItem
} from '../../../shared/types'
import { BOARDS, BOARD_GROUPS, BOARD_LANGUAGES, BOARD_MAP } from '../../../shared/boards'
import type { BoardGroupId } from '../../../shared/boards'
import { formatNumber, timeAgo } from '../utils'
import { state, toast } from '../store'
import BoardRow from './BoardRow.vue'

const emit = defineEmits<{
  (e: 'deploy', repo: RepoItem): void
  (e: 'install', repo: RepoItem): void
  (e: 'detail', repo: RepoItem): void
  (e: 'clone', repo: RepoItem): void
  (e: 'go-search'): void
  (e: 'open-settings'): void
  (e: 'tracked-change', names: string[]): void
}>()

const STORAGE_BOARD = 'gitfinder.board'
const STORAGE_LANG = 'gitfinder.boardLang'

const boardId = ref(localStorage.getItem(STORAGE_BOARD) || 'v-daily')
if (!BOARD_MAP[boardId.value]) boardId.value = 'v-daily'
const language = ref(localStorage.getItem(STORAGE_LANG) || 'any')
const orderBy = ref<'delta' | 'stars'>('delta')
const result = ref<BoardResult | null>(null)
const loading = ref(false)
const error = ref('')
const trackedNames = ref<string[]>([])
let loadSeq = 0

/** AI 中文画像的补全进度 */
interface EnrichProgress {
  finished: number
  total: number
  error: string
}
const progress = ref<EnrichProgress | null>(null)
let unsubscribe: (() => void) | null = null

const aiReady = computed(() => !!state.settings.ai.apiKey && state.settings.ai.enrich !== false)
const enriching = computed(
  () => !!progress.value && progress.value.total > 0 && progress.value.finished < progress.value.total
)

const def = computed(() => BOARD_MAP[boardId.value] || BOARDS[0])
const trackedSet = computed(() => new Set(trackedNames.value))

const grouped = computed(() =>
  BOARD_GROUPS.map((g) => ({
    ...g,
    items: BOARDS.filter((b) => b.group === (g.id as BoardGroupId))
  })).filter((g) => g.items.length)
)

const groupName = computed(() => BOARD_GROUPS.find((g) => g.id === def.value.group)?.name || '')

/** trending 榜允许在「按涨星」和「按总星」之间切换 */
const items = computed<BoardItem[]>(() => {
  const raw = result.value?.items || []
  if (def.value.kind === 'trending' && orderBy.value === 'stars') {
    return [...raw].sort((a, b) => b.stars - a.stars)
  }
  return raw
})

const aiCount = computed(() => items.value.filter((i) => i.profile?.source === 'ai').length)
const guessedCount = computed(() => items.value.filter((i) => i.profile?.source === 'heuristic').length)
const missingCount = computed(() => items.value.filter((i) => i.profile?.source !== 'ai').length)

/** 画像状态提示，放在榜单说明行里 */
const profileHint = computed(() => {
  if (!items.value.length) return ''
  if (enriching.value && progress.value) {
    return `AI 正在生成中文用途与安装方式（${progress.value.finished}/${progress.value.total}）`
  }
  if (progress.value?.error) return `AI 生成失败：${progress.value.error}`
  if (!aiReady.value) {
    return guessedCount.value
      ? '未配置 AI：下方中文分类与安装方式是依据 topics / 语言 / 简介推测的，配置 AI 后可生成准确的中文用途'
      : ''
  }
  if (missingCount.value) return `还有 ${missingCount.value} 个项目的中文说明待生成`
  if (aiCount.value) return `中文用途与安装方式由 AI 生成，本机缓存 14 天`
  return ''
})

const updatedText = computed(() =>
  result.value ? `抓取于 ${timeAgo(new Date(result.value.fetchedAt).toISOString())}` : ''
)

const cacheHint = computed(() => (result.value?.cached ? '（来自缓存，点刷新可强制更新）' : ''))

/** 错误里提到配额/Token 时，给个直达设置的入口 */
const needToken = computed(() => /Token|配额|限流|rate limit/i.test(error.value))

async function load(refresh = false): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const r = await window.api.board.fetch({
      boardId: boardId.value,
      language: language.value,
      refresh
    })
    // 期间用户又切了榜单，丢掉这次的结果
    if (seq !== loadSeq) return
    result.value = r
    void requestProfiles(r.items)
  } catch (err: any) {
    if (seq !== loadSeq) return
    error.value = err?.message || String(err)
    result.value = null
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

/** 只把 AI 真正需要的字段发过去，别把整条榜单塞进 IPC */
function toInputs(list: BoardItem[]): ProfileInput[] {
  return list.map((i) => ({
    full_name: i.full_name,
    description: i.description || '',
    language: i.language || '',
    topics: i.topics || [],
    stars: i.stars || 0,
    archived: !!i.archived,
    pushed_at: i.pushed_at || ''
  }))
}

async function requestProfiles(list: BoardItem[], force = false): Promise<void> {
  if (!aiReady.value || !list.length) {
    progress.value = null
    return
  }
  if (!force && !list.some((i) => i.profile?.source !== 'ai')) {
    progress.value = null
    return
  }
  const scope = boardId.value
  try {
    const r = await window.api.board.enrich({ items: toInputs(list), scope, force })
    if (scope !== boardId.value) return
    progress.value = r.pending > 0 ? { finished: 0, total: r.pending, error: '' } : null
  } catch (err: any) {
    progress.value = { finished: 0, total: 0, error: err?.message || '请求失败' }
  }
}

/** 手动补全 / 重新生成 */
async function enrichNow(): Promise<void> {
  if (!aiReady.value) {
    emit('open-settings')
    return
  }
  if (enriching.value) return
  const force = missingCount.value === 0
  await requestProfiles(items.value, force)
  if (force) toast('正在重新生成中文说明', 'ok', 2000)
}

/**
 * 单条补中文（卡片上「推测 · 译成中文」按钮）。
 * 没配 AI 时翻译无从谈起，直接把用户送去设置页；配了就只把这一个仓库塞进队列，
 * 不重跑整榜——长榜单里补一条只花一条的 token。
 */
async function translateOne(item: BoardItem): Promise<void> {
  if (!aiReady.value) {
    toast('生成中文说明需要先配置 AI', 'warn', 4000)
    emit('open-settings')
    return
  }
  if (enriching.value) return
  await requestProfiles([item], true)
  toast('正在生成中文说明…', 'ok', 2000)
}

defineExpose({ refresh: () => load(false) })

/** 主进程分批回传，按 full_name 合并进当前榜单 */
function onProfiles(e: ProfileUpdateEvent): void {
  if (e.scope && e.scope !== boardId.value) return
  const cur = result.value
  if (cur) {
    let hit = false
    const list = cur.items.map((it) => {
      const p = e.profiles[it.full_name]
      if (!p) return it
      hit = true
      return { ...it, profile: p }
    })
    if (hit) result.value = { ...cur, items: list }
  }
  progress.value = { finished: e.finished, total: e.total, error: e.error || '' }
  if (e.done && !e.error) {
    // 完成后保留一小会儿提示，然后交给 profileHint 的常驻文案
    setTimeout(() => {
      if (!enriching.value) progress.value = null
    }, 2500)
  }
}

function selectBoard(id: string): void {
  if (boardId.value === id) return
  boardId.value = id
  localStorage.setItem(STORAGE_BOARD, id)
  result.value = null
  void load(false)
}

function onLanguageChange(): void {
  localStorage.setItem(STORAGE_LANG, language.value)
  void load(false)
}

async function toggleTrack(item: BoardItem): Promise<void> {
  try {
    trackedNames.value = await window.api.board.toggleTrack(item.full_name, item.stars)
    emit('tracked-change', trackedNames.value)
    const on = trackedNames.value.includes(item.full_name)
    toast(on ? `已加入追踪：${item.full_name}` : `已取消追踪：${item.full_name}`, 'ok')
    if (boardId.value === 'm-tracked') await load(true)
  } catch (err: any) {
    toast(err?.message || '操作失败', 'error')
  }
}

async function clearCache(): Promise<void> {
  try {
    const n = await window.api.board.clearCache()
    toast(`已清空 ${n} 条榜单缓存`, 'ok')
    await load(true)
  } catch (err: any) {
    toast(err?.message || '清空缓存失败', 'error')
  }
}

async function loadTracked(): Promise<void> {
  try {
    trackedNames.value = await window.api.board.tracked()
  } catch {
    trackedNames.value = []
  }
}

let langTimer: ReturnType<typeof setTimeout> | null = null
watch(language, () => {
  if (langTimer) clearTimeout(langTimer)
  langTimer = setTimeout(() => onLanguageChange(), 120)
})

/** 设置是挂载后才读到的，AI 可用性变化时补一次生成 */
watch(aiReady, (ready) => {
  if (ready && items.value.length) void requestProfiles(items.value)
})

onMounted(async () => {
  unsubscribe = window.api.events.onBoardProfiles(onProfiles)
  await loadTracked()
  await load(false)
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <div class="boards">
    <aside class="board-nav">
      <div v-for="g in grouped" :key="g.id" class="nav-group">
        <div class="nav-title">{{ g.name }}</div>
        <button
          v-for="b in g.items"
          :key="b.id"
          class="nav-item"
          :class="{ active: b.id === boardId }"
          @click="selectBoard(b.id)"
        >
          <span class="nav-name">{{ b.name }}</span>
          <span v-if="b.kind === 'trending'" class="nav-dot" title="含官方涨星数据"></span>
        </button>
      </div>
      <div class="nav-foot tiny">
        <p>共 {{ BOARDS.length }} 个榜单</p>
        <p>涨星数据来自 GitHub 官方 Trending，其余由搜索接口组合而成</p>
      </div>
    </aside>

    <section class="board-main">
      <header class="board-head">
        <div class="head-left">
          <div class="crumb tiny">{{ groupName }}<span class="sep"> /</span></div>
          <h2>{{ def.name }}</h2>
          <p class="tiny muted">{{ def.desc }}</p>
        </div>
        <div class="head-actions">
          <select
            v-if="def.followLanguage"
            v-model="language"
            class="select compact"
            title="按语言筛选"
          >
            <option v-for="l in BOARD_LANGUAGES" :key="l.value" :value="l.value">
              {{ l.label }}
            </option>
          </select>

          <div v-if="def.kind === 'trending'" class="seg">
            <button :class="{ on: orderBy === 'delta' }" @click="orderBy = 'delta'">按涨星</button>
            <button :class="{ on: orderBy === 'stars' }" @click="orderBy = 'stars'">按总星</button>
          </div>

          <button class="btn btn-sm" :disabled="loading" @click="load(true)">
            <span v-if="loading" class="spin">◌</span>
            <span v-else>↻</span>
            刷新
          </button>
          <button class="btn btn-sm" :disabled="enriching" :title="aiReady ? '为这一榜的项目生成中文用途与安装方式' : '需要先在设置里配置 AI'" @click="enrichNow">
            <span v-if="enriching">AI {{ progress?.finished }}/{{ progress?.total }}</span>
            <span v-else-if="!aiReady">配置 AI 说明</span>
            <span v-else-if="missingCount">AI 生成说明</span>
            <span v-else>重新生成</span>
          </button>
          <button class="btn btn-sm btn-ghost" title="清空所有榜单缓存" @click="clearCache">
            清缓存
          </button>
        </div>
      </header>

      <div class="board-note tiny">
        <span class="note-text">{{ result?.note || def.note || '' }}</span>
        <span v-if="updatedText" class="sep">·</span>
        <span v-if="updatedText">{{ updatedText }}</span>
        <span class="sep">·</span>
        <span v-if="!error">共 {{ formatNumber(items.length) }} 个</span>
        <span v-else>加载失败</span>
        <span v-if="result?.rateRemaining !== null && result?.rateRemaining !== undefined" class="sep">
          · 接口剩余 {{ result.rateRemaining }} 次
        </span>
        <span v-if="result?.cached" class="cache-tag">缓存</span>
        <span class="spacer"></span>
        <span v-if="trackedNames.length" class="tiny">已追踪 {{ trackedNames.length }} 个</span>
      </div>

      <div v-if="profileHint" class="ai-note tiny">
        <span class="ai-badge">AI</span>
        <span class="ai-text">{{ profileHint }}</span>
        <button v-if="!aiReady" class="link" @click="emit('open-settings')">去设置</button>
      </div>

      <div v-if="error" class="state-box error-box">
        <strong>榜单加载失败</strong>
        <p>{{ error }}</p>
        <button v-if="needToken" class="btn btn-sm" @click="emit('open-settings')">
          去设置填 Token
        </button>
      </div>

      <div v-else-if="loading && !items.length" class="list">
        <div v-for="i in 6" :key="i" class="skeleton"></div>
      </div>

      <div v-else-if="!items.length" class="state-box empty-box">
        <div class="empty-icon">{{ def.kind === 'tracked' ? '⭐' : '🫧' }}</div>
        <h3>{{ def.kind === 'tracked' ? '还没有追踪任何项目' : '这个榜单暂时没有数据' }}</h3>
        <p class="muted">
          {{
            def.kind === 'tracked'
              ? '在榜单或搜索结果里点右侧的星标按钮，把项目加进来。之后每次打开，都会用本机采样记录它的星标变化，算出真实涨星速度。'
              : '换个语言或时间窗口试试，GitHub 那边可能暂时没有符合条件的结果。'
          }}
        </p>
        <button v-if="def.kind === 'tracked'" class="btn btn-sm" @click="emit('go-search')">
          去搜索页挑几个项目
        </button>
      </div>

      <div v-else class="list">
        <BoardRow
          v-for="(item, i) in items"
          :key="item.full_name"
          :item="item"
          :rank="i + 1"
          :tracked="trackedSet.has(item.full_name)"
          @deploy="emit('deploy', $event)"
          @install="emit('install', $event)"
          @detail="emit('detail', $event)"
          @clone="emit('clone', $event)"
          @translate="translateOne"
          @track="toggleTrack"
        />
        <p v-if="def.kind === 'tracked' && !items.some((i) => i.starDelta)" class="foot-hint tiny">
          涨星要用本机采样算：同一个仓库至少要有两次采样、且间隔 2 小时以上才会显示。刚加进来时只能看到总星数，过几小时或明天再来刷新就有了。
        </p>
        <p v-else-if="def.kind === 'trending'" class="foot-hint tiny">
          GitHub 官方 Trending 只公布每个时间窗口内涨幅靠前的一批项目（通常 25 个），所以这里是「头部项目里的涨星榜」；想看任意项目的涨星，把它加入追踪榜即可。
        </p>
        <p v-else class="foot-hint tiny">
          {{ cacheHint || '数据来自 GitHub 搜索接口，同一榜单 1~4 小时内复用缓存，刷新按钮可强制更新。' }}
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.boards {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.board-nav {
  width: 186px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-elev);
  padding: 12px 8px;
  overflow-y: auto;
}
.nav-group + .nav-group {
  margin-top: 14px;
}
.nav-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.4px;
  padding: 0 10px 6px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text-2);
  text-align: left;
  transition: background 0.12s, color 0.12s;
}
.nav-item:hover {
  background: var(--bg-subtle);
  color: var(--text);
}
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.nav-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #2da44e;
  flex-shrink: 0;
}
.nav-foot {
  margin-top: 18px;
  padding: 10px;
  border-top: 1px dashed var(--border);
  color: var(--text-3);
  line-height: 1.6;
}
.nav-foot p + p {
  margin-top: 4px;
}

.board-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 24px 32px;
}
.board-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  max-width: 1180px;
  width: 100%;
  margin: 0 auto;
  flex-wrap: wrap;
}
.head-left h2 {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.2px;
  margin-top: 2px;
}
.crumb {
  color: var(--text-3);
}
.crumb .sep {
  color: var(--border-strong);
}
.head-left p {
  margin-top: 2px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.select.compact {
  width: auto;
  padding: 4px 26px 4px 10px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
}
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.seg button {
  padding: 4px 10px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--bg-elev);
  transition: all 0.12s;
}
.seg button + button {
  border-left: 1px solid var(--border);
}
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.board-note {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  max-width: 1180px;
  width: 100%;
  margin: 10px auto 12px;
  color: var(--text-3);
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--border);
}
.note-text {
  color: var(--text-2);
}
.sep {
  color: var(--border-strong);
}
.cache-tag {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--bg-subtle);
  color: var(--text-3);
}
.ai-note {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  max-width: 1180px;
  width: 100%;
  margin: -2px auto 12px;
  color: var(--text-3);
}
.ai-badge {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
}
.ai-text {
  color: var(--text-2);
}
.ai-note .link {
  color: var(--accent);
  text-decoration: underline;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 1180px;
  width: 100%;
  margin: 0 auto;
}
.foot-hint {
  color: var(--text-3);
  line-height: 1.7;
  padding: 10px 2px 0;
}
.state-box {
  max-width: 620px;
  margin: 48px auto;
  text-align: center;
}
.empty-box h3 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}
.empty-box p {
  font-size: 13px;
  line-height: 1.7;
}
.empty-box .btn {
  margin-top: 14px;
}
.empty-icon {
  font-size: 32px;
  margin-bottom: 10px;
}
.error-box {
  padding: 16px 18px;
  background: var(--red-soft);
  border: 1px solid #ffcecb;
  border-radius: var(--radius);
  text-align: left;
  max-width: 720px;
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
.error-box .btn {
  margin-top: 12px;
}
.skeleton {
  height: 84px;
  border-radius: var(--radius);
  background: linear-gradient(90deg, #eef0f3 25%, #f6f7f9 50%, #eef0f3 75%);
  background-size: 200% 100%;
  animation: shimmer 1.3s infinite;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
</style>
