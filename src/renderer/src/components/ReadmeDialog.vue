<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import type { RepoItem, ReadmeResult } from '../../../shared/types'
import { formatNumber, timeAgo, langColor } from '../utils'

const props = defineProps<{ repo: RepoItem }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'deploy', repo: RepoItem): void
  (e: 'install', repo: RepoItem): void
  (e: 'clone', repo: RepoItem): void
  (e: 'open-settings'): void
}>()

const loading = ref(true)
const content = ref('')
const error = ref('')
const errorHint = ref('')
const errorCode = ref<ReadmeResult['code']>('')
const source = ref<ReadmeResult['source']>('')
const fileName = ref('')

const translated = ref('')
const showTranslated = ref(false)
const translating = ref(false)
const translateMsg = ref('')

const shown = computed(() => (showTranslated.value && translated.value ? translated.value : content.value))

onMounted(async () => {
  try {
    const res = await window.api.github.readme(
      props.repo.owner,
      props.repo.name,
      props.repo.default_branch
    )
    if (res?.ok) {
      content.value = res.text
      source.value = res.source
      fileName.value = res.fileName
    } else {
      error.value = res?.message || '读取 README 失败'
      errorHint.value = res?.hint || ''
      errorCode.value = res?.code || 'network'
    }
  } catch (err: any) {
    error.value = err.message || String(err)
    errorCode.value = 'network'
  } finally {
    loading.value = false
  }
})

async function doTranslate(): Promise<void> {
  if (translating.value || !content.value) return
  translating.value = true
  translateMsg.value = ''
  try {
    const res = await window.api.ai.translate({
      text: content.value,
      fullName: props.repo.full_name
    })
    if (res?.ok) {
      translated.value = res.text
      showTranslated.value = true
      translateMsg.value = res.cached
        ? '命中本地缓存，没有消耗 token'
        : res.message || (res.chunks > 1 ? `分 ${res.chunks} 段翻译完成` : '')
    } else {
      translateMsg.value = res?.message || '翻译失败'
    }
  } catch (err: any) {
    translateMsg.value = err?.message || String(err)
  } finally {
    translating.value = false
  }
}

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

      <!-- README 工具条：来源 + 翻译开关 -->
      <div v-if="content && !loading" class="readme-bar">
        <span class="pill">{{ fileName || 'README' }}</span>
        <span v-if="source" class="pill pill-quiet">
          {{ source === 'raw' ? '免配额读取' : '接口读取' }}
        </span>
        <span v-if="showTranslated" class="pill pill-on">中文译文</span>
        <div style="margin-left: auto" class="row" :style="{ gap: '8px' }">
          <span v-if="translateMsg" class="tiny muted truncate" style="max-width: 260px">
            {{ translateMsg }}
          </span>
          <button
            v-if="translated"
            class="btn btn-sm"
            @click="showTranslated = !showTranslated"
          >
            {{ showTranslated ? '看原文' : '看译文' }}
          </button>
          <button
            v-else
            class="btn btn-sm btn-primary"
            :disabled="translating"
            @click="doTranslate"
          >
            <span v-if="translating" class="spin">◌</span>
            {{ translating ? '翻译中…' : '译成中文' }}
          </button>
        </div>
      </div>

      <div class="modal-body readme-body">
        <p v-if="repo.description" class="desc-box">{{ repo.description }}</p>
        <div v-if="loading" class="hint"><span class="spin">◌</span> 正在读取 README…</div>

        <div v-else-if="error" class="hint err">
          <p class="err-title">{{ error }}</p>
          <p v-if="errorHint" class="err-hint">{{ errorHint }}</p>
          <div class="row" style="gap: 8px; margin-top: 14px">
            <button class="btn btn-sm" @click="openRepo">在 GitHub 打开仓库</button>
            <button
              v-if="errorCode === 'rate-limit' || errorCode === 'auth'"
              class="btn btn-sm btn-primary"
              @click="emit('open-settings')"
            >
              去配置 GitHub Token
            </button>
          </div>
        </div>

        <div v-else-if="translating && !translated" class="hint">
          <span class="spin">◌</span> AI 正在翻译，长文档需要一会儿…
        </div>

        <pre v-else class="readme-text">{{ shown }}</pre>
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
.readme-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
}
.pill {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-2);
  white-space: nowrap;
}
.pill-quiet {
  opacity: 0.75;
}
.pill-on {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
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
  color: var(--text);
}
.err-title {
  color: var(--red);
  font-weight: 600;
  margin: 0;
}
.err-hint {
  margin: 8px 0 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}
</style>
