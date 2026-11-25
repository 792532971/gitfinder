<script setup lang="ts">
import { computed } from 'vue'
import type { BoardItem, InstallOption } from '../../../shared/types'
import { formatNumber, formatDelta, timeAgo, langColor } from '../utils'
import { toast } from '../store'

const props = defineProps<{ item: BoardItem; rank: number; tracked: boolean }>()
const emit = defineEmits<{
  (e: 'deploy', repo: BoardItem): void
  (e: 'install', repo: BoardItem): void
  (e: 'detail', repo: BoardItem): void
  (e: 'clone', repo: BoardItem): void
  (e: 'track', repo: BoardItem): void
}>()

const medal = computed(() => {
  if (props.rank === 1) return '🥇'
  if (props.rank === 2) return '🥈'
  if (props.rank === 3) return '🥉'
  return ''
})

/** 中文画像 */
const profile = computed(() => props.item.profile)
const purpose = computed(() => profile.value?.purpose || '')
const installs = computed(() => profile.value?.installs || [])
const category = computed(() => profile.value?.category || '')
const level = computed(() => profile.value?.level || '')
const platforms = computed(() => profile.value?.platforms || [])
const guessed = computed(() => profile.value?.source === 'heuristic')
const deployable = computed(() => !!profile.value?.deployable)

const platformHint = computed(() =>
  platforms.value.length ? `支持平台：${platforms.value.join('、')}` : ''
)

/** 涨星口径文案 */
const deltaLabel = computed(() => {
  const w = props.item.deltaWindow || 1
  if (props.item.deltaSource === 'github') {
    return w >= 30 ? '本月' : w >= 7 ? '本周' : '今日'
  }
  return `近 ${w} 天`
})

const deltaText = computed(() => {
  const d = props.item.starDelta
  if (d === undefined || d === null) return ''
  return formatDelta(d)
})

const ageText = computed(() => {
  const a = props.item.ageDays
  if (!a) return ''
  if (a < 60) return `${a} 天前创建`
  if (a < 730) return `${Math.round(a / 30)} 个月前创建`
  return `${Math.round(a / 365)} 年前创建`
})

function openRepo(): void {
  window.api.app.openExternal(props.item.html_url)
}

/** 点安装方式复制命令，省得手敲 */
async function copyInstall(o: InstallOption): Promise<void> {
  const text = o.detail || o.label
  try {
    await navigator.clipboard.writeText(text)
    toast(`已复制：${text}`, 'ok', 2400)
  } catch {
    toast(`${o.label}：${text}`, 'ok', 4000)
  }
}
</script>

<template>
  <article class="board-row" :class="{ 'is-top': rank <= 3 }">
    <div class="rank" :class="`rank-${rank <= 3 ? rank : 'n'}`">
      <span v-if="medal" class="medal">{{ medal }}</span>
      <span v-else class="rank-num">{{ rank }}</span>
    </div>

    <div class="body">
      <div class="line-1">
        <button class="name" :title="item.html_url" @click="openRepo">
          <span class="owner">{{ item.owner }}</span
          ><span class="slash">/</span><span class="repo">{{ item.name }}</span>
        </button>

        <span v-if="item.starDelta" class="delta" :class="item.deltaSource === 'local' ? 'local' : 'gh'">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
            <path d="M6 1.5 10.5 7H7.5v3.5h-3V7H1.5L6 1.5Z" />
          </svg>
          {{ deltaText }}
          <em>{{ deltaLabel }}</em>
        </span>

        <span v-if="item.extra" class="badge badge-accent">{{ item.extra }}</span>
        <span v-if="item.archived" class="badge badge-amber">已归档</span>
      </div>

      <p v-if="purpose" class="purpose">{{ purpose }}</p>
      <p v-if="!purpose" class="desc">{{ item.description || '这个项目没有写简介' }}</p>
      <p v-else-if="item.description" class="desc desc-en" :title="item.description">
        {{ item.description }}
      </p>

      <div v-if="category || installs.length || level" class="tags">
        <span v-if="category" class="tag cat">{{ category }}</span>
        <button
          v-for="o in installs"
          :key="o.kind + o.label"
          class="tag inst"
          :class="`k-${o.kind}`"
          :title="o.detail ? `${o.detail}（点击复制）` : `${o.label}（点击复制）`"
          @click="copyInstall(o)"
        >
          <i class="ico"></i>{{ o.label }}
        </button>
        <span v-if="level" class="tag level" :title="platformHint">上手{{ level }}</span>
        <span
          v-if="guessed"
          class="tag guess"
          title="未配置 AI 或 AI 调用失败，这部分是按 topics / 语言 / 简介推测的，仅供参考"
          >推测</span
        >
      </div>

      <div class="meta">
        <span v-if="item.language" class="meta-item">
          <i class="dot" :style="{ background: langColor(item.language) }"></i>{{ item.language }}
        </span>
        <span class="meta-item stars">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"
            />
          </svg>
          {{ formatNumber(item.stars) }}
        </span>
        <span v-if="item.forks" class="meta-item">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"
            />
          </svg>
          {{ formatNumber(item.forks) }}
        </span>
        <span v-if="ageText" class="meta-item">{{ ageText }}</span>
        <span v-if="item.pushed_at" class="meta-item">更新于 {{ timeAgo(item.pushed_at) }}</span>
      </div>
    </div>

    <div class="row-actions">
      <button class="icon-btn" title="查看 README" @click="emit('detail', item)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M2.5 3.2c1.6-.6 3.2-.6 5.5.5 2.3-1.1 3.9-1.1 5.5-.5v9.3c-1.6-.6-3.2-.6-5.5.5-2.3-1.1-3.9-1.1-5.5-.5V3.2Z" />
          <path d="M8 3.7v9.8" />
        </svg>
      </button>
      <button
        class="icon-btn docker"
        :class="{ ready: deployable }"
        :title="deployable ? '支持 Docker，可一键部署到 WSL' : '部署到 WSL Docker'"
        @click="emit('deploy', item)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.185.185 0 0 0-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 0 0 .186-.186V3.574a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 0 0 .186-.186V6.29a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.887c0 .102.082.185.185.185m-2.93 0h2.12a.186.186 0 0 0 .184-.186V6.29a.185.185 0 0 0-.185-.185H8.1a.185.185 0 0 0-.185.185v1.887c0 .102.083.185.185.185m-2.964 0h2.119a.186.186 0 0 0 .185-.186V6.29a.185.185 0 0 0-.185-.185H5.136a.186.186 0 0 0-.186.185v1.887c0 .102.084.185.186.185m-2.93 0h2.12a.186.186 0 0 0 .184-.186V6.29a.185.185 0 0 0-.185-.185H2.206a.185.185 0 0 0-.185.185v1.887c0 .102.082.185.185.185m0 2.715h2.12a.185.185 0 0 0 .184-.185V9.006a.185.185 0 0 0-.185-.186H2.206a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.12a.185.185 0 0 0 .184-.186v-1.887a.186.186 0 0 0-.185-.186H2.206a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m2.93 0h2.12a.186.186 0 0 0 .184-.186v-1.887a.185.185 0 0 0-.185-.186H5.136a.185.185 0 0 0-.185.185v1.888c0 .102.084.185.186.185m2.964 0h2.119a.186.186 0 0 0 .185-.186v-1.887a.185.185 0 0 0-.185-.186H8.1a.186.186 0 0 0-.186.186v1.887c0 .102.083.185.185.185m2.93 0h2.119a.186.186 0 0 0 .186-.186v-1.887a.185.185 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m2.954 0h2.118a.186.186 0 0 0 .186-.186v-1.887a.186.186 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m0-2.716h2.118a.185.185 0 0 0 .186-.185V9.006a.185.185 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185"
          />
        </svg>
      </button>
      <button class="icon-btn" title="git clone 到指定目录" @click="emit('clone', item)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M1.75 2.5a.75.75 0 0 0-.75.75v7.5c0 .414.336.75.75.75h4.19a.75.75 0 0 1 .53.22l.98.98a.75.75 0 0 0 .53.22h5.27a.75.75 0 0 0 .75-.75V8a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 1-.53-.22l-.98-.98a.75.75 0 0 0-.53-.22H1.75Z"
          />
        </svg>
      </button>
      <button class="icon-btn" title="下载安装（Windows）" @click="emit('install', item)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 11.25 14Zm5.72-11.28a.75.75 0 0 1 1.06 0l3 3a.75.75 0 1 1-1.06 1.06L8.75 4.06v6.69a.75.75 0 0 1-1.5 0V4.06L4.53 6.78a.75.75 0 0 1-1.06-1.06Z"
          />
        </svg>
      </button>
      <button
        class="icon-btn track"
        :class="{ on: tracked }"
        :title="tracked ? '取消追踪' : '加入我的追踪榜'"
        @click="emit('track', item)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" :fill="tracked ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.4">
          <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8Z" />
        </svg>
      </button>
    </div>
  </article>
</template>

<style scoped>
.board-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 14px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.board-row:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.board-row.is-top {
  border-left: 3px solid var(--accent);
}
.rank {
  width: 30px;
  flex-shrink: 0;
  text-align: center;
  padding-top: 2px;
}
.medal {
  font-size: 17px;
  line-height: 1;
}
.rank-num {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.body {
  flex: 1;
  min-width: 0;
}
.line-1 {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.name {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
  display: inline-flex;
  align-items: baseline;
  max-width: 100%;
}
.name:hover {
  text-decoration: underline;
}
.owner {
  color: var(--text-2);
  font-weight: 500;
}
.slash {
  color: var(--text-3);
}
.repo {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.delta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.delta em {
  font-style: normal;
  font-weight: 400;
  opacity: 0.8;
  font-size: 10.5px;
}
.delta.gh {
  background: var(--green-soft);
  color: var(--green);
}
.delta.local {
  background: var(--accent-soft);
  color: var(--accent);
}
.purpose {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.desc {
  margin-top: 3px;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.desc-en {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 2px;
  -webkit-line-clamp: 1;
  line-clamp: 1;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-2);
  white-space: nowrap;
}
.tag .ico {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.65;
}
.tag.cat {
  background: var(--accent-soft);
  border-color: #cfe0fd;
  color: var(--accent);
  font-weight: 600;
}
.tag.inst {
  cursor: pointer;
  background: var(--bg-elev);
  transition: border-color 0.12s, box-shadow 0.12s;
}
.tag.inst:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.k-docker,
.k-compose {
  color: #0b6ab0;
  border-color: #b9dcf2;
  background: #eef8fd;
}
.k-installer,
.k-portable {
  color: var(--green);
  border-color: #c3e6cd;
  background: var(--green-soft);
}
.k-package {
  color: #6b3fa0;
  border-color: #ded0f0;
  background: #f7f1fd;
}
.k-hosted {
  color: #0d7a72;
  border-color: #bfe5e0;
  background: #eafaf8;
}
.k-plugin {
  color: var(--amber);
  border-color: #f0dfa8;
  background: var(--amber-soft);
}
.k-library,
.k-source {
  color: var(--text-2);
}
.tag.level {
  border-color: transparent;
  background: transparent;
  color: var(--text-3);
}
.tag.guess {
  border-style: dashed;
  border-color: var(--border-strong);
  background: transparent;
  color: var(--text-3);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-3);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.meta-item.stars {
  color: #9a6700;
  font-weight: 500;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0.55;
  transition: opacity 0.15s;
}
.board-row:hover .row-actions {
  opacity: 1;
}
.icon-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  transition: all 0.15s;
}
.icon-btn:hover {
  background: var(--bg-subtle);
  color: var(--text);
}
.icon-btn.track.on {
  color: #bf8700;
}
.icon-btn.docker.ready {
  color: #0b6ab0;
}
</style>
