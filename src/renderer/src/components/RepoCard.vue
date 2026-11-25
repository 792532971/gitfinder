<script setup lang="ts">
import type { RepoItem } from '../../../shared/types'
import { formatNumber, timeAgo, langColor } from '../utils'

const props = defineProps<{ repo: RepoItem; index: number; tracked?: boolean }>()
const emit = defineEmits<{
  (e: 'deploy', repo: RepoItem): void
  (e: 'install', repo: RepoItem): void
  (e: 'detail', repo: RepoItem): void
  (e: 'track', repo: RepoItem): void
  (e: 'clone', repo: RepoItem): void
}>()

function openRepo(): void {
  window.api.app.openExternal(props.repo.html_url)
}
</script>

<template>
  <article class="repo-card">
    <div class="card-head">
      <div class="title-line">
        <span class="idx">{{ index }}</span>
        <button class="repo-name" @click="openRepo" :title="repo.html_url">
          <span class="owner">{{ repo.owner }}</span
          ><span class="slash">/</span><span class="name">{{ repo.name }}</span>
        </button>
        <span v-if="repo.archived" class="badge badge-amber">已归档</span>
        <span v-if="repo.stars > 5000" class="badge badge-green">热门</span>
      </div>
      <div class="stars">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"
          />
        </svg>
        <strong>{{ formatNumber(repo.stars) }}</strong>
      </div>
    </div>

    <p class="desc">{{ repo.description || '这个项目没有写简介' }}</p>

    <div v-if="repo.topics.length" class="topics">
      <span v-for="t in repo.topics.slice(0, 6)" :key="t" class="badge topic">{{ t }}</span>
    </div>

    <div class="meta">
      <span v-if="repo.language" class="meta-item">
        <i class="dot" :style="{ background: langColor(repo.language) }"></i>
        {{ repo.language }}
      </span>
      <span class="meta-item">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"
          />
        </svg>
        {{ formatNumber(repo.forks) }}
      </span>
      <span class="meta-item">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0ZM8 3.5a.75.75 0 0 1 .75.75v3.19l2.28 1.32a.75.75 0 0 1-.75 1.299L7.25 8.28a.75.75 0 0 1-.375-.65V4.25A.75.75 0 0 1 8 3.5Z"
          />
        </svg>
        更新于 {{ timeAgo(repo.pushed_at || repo.updated_at) }}
      </span>
      <span v-if="repo.license && repo.license !== 'NOASSERTION'" class="meta-item">
        {{ repo.license }}
      </span>
    </div>

    <div class="actions">
      <button
        class="btn btn-sm btn-track"
        :class="{ on: tracked }"
        :title="tracked ? '从我的追踪榜移除' : '加入我的追踪榜，记录涨星'"
        @click="emit('track', repo)"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          :fill="tracked ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.4"
        >
          <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8Z" />
        </svg>
        {{ tracked ? '已追踪' : '追踪' }}
      </button>
      <button class="btn btn-sm" @click="emit('detail', repo)">查看 README</button>
      <button class="btn btn-sm" title="git clone 到指定目录" @click="emit('clone', repo)">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M1.75 2.5a.75.75 0 0 0-.75.75v7.5c0 .414.336.75.75.75h4.19a.75.75 0 0 1 .53.22l.98.98a.75.75 0 0 0 .53.22h5.27a.75.75 0 0 0 .75-.75V8a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 1-.53-.22l-.98-.98a.75.75 0 0 0-.53-.22H1.75Z"
          />
        </svg>
        拉取到本地
      </button>
      <button class="btn btn-sm btn-deploy" @click="emit('deploy', repo)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.185.185 0 0 0-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 0 0 .186-.186V3.574a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 0 0 .186-.186V6.29a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.887c0 .102.082.185.185.185m-2.93 0h2.12a.186.186 0 0 0 .184-.186V6.29a.185.185 0 0 0-.185-.185H8.1a.185.185 0 0 0-.185.185v1.887c0 .102.083.185.185.185m-2.964 0h2.119a.186.186 0 0 0 .185-.186V6.29a.185.185 0 0 0-.185-.185H5.136a.186.186 0 0 0-.186.185v1.887c0 .102.084.185.186.185m-2.93 0h2.12a.186.186 0 0 0 .184-.186V6.29a.185.185 0 0 0-.185-.185H2.206a.185.185 0 0 0-.185.185v1.887c0 .102.082.185.185.185m0 2.715h2.12a.185.185 0 0 0 .184-.185V9.006a.185.185 0 0 0-.185-.186H2.206a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.12a.185.185 0 0 0 .184-.186v-1.887a.186.186 0 0 0-.185-.186H2.206a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m2.93 0h2.12a.186.186 0 0 0 .184-.186v-1.887a.185.185 0 0 0-.185-.186H5.136a.185.185 0 0 0-.185.185v1.888c0 .102.084.185.186.185m2.964 0h2.119a.186.186 0 0 0 .185-.186v-1.887a.185.185 0 0 0-.185-.186H8.1a.186.186 0 0 0-.186.186v1.887c0 .102.083.185.185.185m2.93 0h2.119a.186.186 0 0 0 .186-.186v-1.887a.185.185 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m2.954 0h2.118a.186.186 0 0 0 .186-.186v-1.887a.186.186 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m0-2.716h2.118a.185.185 0 0 0 .186-.185V9.006a.185.185 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185"
          />
        </svg>
        部署到 WSL
      </button>
      <button class="btn btn-sm" @click="emit('install', repo)">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path
            d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 11.25 14Zm5.72-11.28a.75.75 0 0 1 1.06 0l3 3a.75.75 0 1 1-1.06 1.06L8.75 4.06v6.69a.75.75 0 0 1-1.5 0V4.06L4.53 6.78a.75.75 0 0 1-1.06-1.06Z"
          />
        </svg>
        下载安装
      </button>
    </div>
  </article>
</template>

<style scoped>
.repo-card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.repo-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.idx {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  min-width: 16px;
}
.repo-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--accent);
  display: flex;
  align-items: baseline;
  min-width: 0;
  text-align: left;
}
.repo-name:hover {
  text-decoration: underline;
}
.owner {
  color: var(--text-2);
  font-weight: 500;
}
.slash {
  color: var(--text-3);
  margin: 0 1px;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stars {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #9a6700;
  font-size: 13px;
  flex-shrink: 0;
}
.desc {
  margin-top: 6px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.topics {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;
}
.topic {
  font-size: 11.5px;
  padding: 1px 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.btn-deploy {
  margin-left: auto;
  color: #0a6b9b;
  border-color: #b6e0f0;
  background: #eef8fc;
}
.btn-deploy:hover {
  background: #ddf1fa;
  border-color: #7fcfeb;
}
.btn-track.on {
  color: #9a6700;
  background: var(--amber-soft);
  border-color: #eedc82;
}
</style>
