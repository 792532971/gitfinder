<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { RepoItem } from '../../../shared/types'
import { formatNumber, timeAgo, langColor } from '../utils'

const props = defineProps<{ repo: RepoItem }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'deploy', repo: RepoItem): void
  (e: 'install', repo: RepoItem): void
  (e: 'clone', repo: RepoItem): void
}>()

const loading = ref(true)
const content = ref('')
const error = ref('')

onMounted(async () => {
  try {
    const md = await window.api.github.readme(props.repo.owner, props.repo.name)
    content.value = md || ''
    if (!md) error.value = '这个仓库没有 README，或者内容为空'
  } catch (err: any) {
    error.value = err.message || String(err)
  } finally {
    loading.value = false
  }
})

function openRepo(): void {
  window.api.app.openExternal(props.repo.html_url)
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal readme-modal">
      <div class="modal-head">
        <div style="min-width: 0">
          <h3 class="truncate">{{ repo.full_name }}</h3>
          <div class="row tiny muted" style="margin-top: 4px; gap: 12px">
            <span v-if="repo.language" class="row" style="gap: 4px">
              <i class="dot" :style="{ background: langColor(repo.language) }"></i>{{ repo.language }}
            </span>
            <span>★ {{ formatNumber(repo.stars) }}</span>
            <span>⑂ {{ formatNumber(repo.forks) }}</span>
            <span>更新于 {{ timeAgo(repo.pushed_at || repo.updated_at) }}</span>
          </div>
        </div>
        <div class="row">
          <button class="btn btn-ghost btn-sm" @click="openRepo">在 GitHub 打开</button>
          <button class="btn btn-ghost btn-sm" @click="emit('close')">关闭</button>
        </div>
      </div>

      <div class="modal-body readme-body">
        <p v-if="repo.description" class="desc-box">{{ repo.description }}</p>
        <div v-if="loading" class="hint"><span class="spin">◌</span> 正在读取 README…</div>
        <div v-else-if="error" class="hint err">{{ error }}</div>
        <pre v-else class="readme-text">{{ content }}</pre>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="emit('install', repo)">下载安装</button>
        <button class="btn" @click="emit('clone', repo)">拉取到本地</button>
        <button class="btn btn-primary" @click="emit('deploy', repo)">部署到 WSL</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.readme-modal {
  max-width: 900px;
}
.readme-body {
  padding: 0;
}
.desc-box {
  padding: 14px 20px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
  color: var(--text-2);
  font-size: 13px;
}
.readme-text {
  padding: 18px 20px;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
  margin: 0;
}
.hint {
  padding: 30px 20px;
  color: var(--text-2);
  font-size: 13px;
}
.hint.err {
  color: var(--red);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}
</style>
