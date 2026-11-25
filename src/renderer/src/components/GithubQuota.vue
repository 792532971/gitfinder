<script setup lang="ts">
/**
 * GitHub 接口配额面板。
 * core 与 search 是两个独立池子：core 管仓库详情 / README / Release，search 管搜索与榜单。
 * /rate_limit 本身不消耗配额，所以可以随手刷新。
 */
import { computed, onMounted, ref } from 'vue'
import type { QuotaBucket, QuotaInfo } from '../../../shared/types'
import { toast } from '../store'

const loading = ref(false)
const info = ref<QuotaInfo | null>(null)
const error = ref('')

const rows = computed(() => {
  if (!info.value) return [] as { key: string; label: string; desc: string; b: QuotaBucket }[]
  const all = [
    { key: 'core', label: 'core', desc: '仓库详情 / README / Release 下载', b: info.value.core },
    { key: 'search', label: 'search', desc: '搜索与榜单', b: info.value.search },
    ...(info.value.graphql
      ? [{ key: 'graphql', label: 'graphql', desc: 'GraphQL 接口', b: info.value.graphql }]
      : [])
  ]
  // 未登录时 graphql 的 limit 是 0，这一行没有意义，直接不显示
  return all.filter((r) => r.b.limit > 0)
})

function percent(b: QuotaBucket): number {
  if (!b.limit) return 0
  return Math.max(0, Math.min(100, Math.round((b.remaining / b.limit) * 100)))
}

function barClass(b: QuotaBucket): string {
  const p = percent(b)
  if (p <= 5) return 'bar-red'
  if (p <= 25) return 'bar-amber'
  return 'bar-green'
}

function resetText(b: QuotaBucket): string {
  if (!b.reset) return ''
  const diff = b.reset * 1000 - Date.now()
  if (diff <= 0) return '即将重置'
  const m = Math.ceil(diff / 60000)
  if (m < 60) return `${m} 分钟后重置`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return `${h} 小时${rest ? ` ${rest} 分` : ''}后重置`
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** core 快用完时给一句提醒：追踪榜、README、Release 都靠它 */
const lowWarn = computed(() => {
  const i = info.value
  if (!i || !i.core.limit) return ''
  if (i.core.remaining > 5) return ''
  return i.authenticated
    ? 'core 配额快用尽了，这个小时内的 README、Release、追踪榜可能失败，等重置后再试'
    : 'core 配额快用尽了。未登录每小时只有 60 次，填一个 Token 可以提到 5000 次/小时'
})

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    info.value = await window.api.github.quota()
  } catch (err: any) {
    error.value = err?.message || String(err)
    info.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)

defineExpose({ load })
</script>

<template>
  <div class="quota">
    <div class="quota-head">
      <span class="quota-title">接口配额</span>
      <span v-if="info" :class="['auth-tag', info.authenticated ? 'auth-yes' : 'auth-no']">
        {{ info.authenticated ? '已登录' : '未登录' }}
      </span>
      <button class="btn btn-ghost btn-sm" :disabled="loading" @click="load">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="error" class="quota-err">{{ error }}</div>
    <div v-else-if="!info" class="quota-loading">正在读取配额…</div>

    <div v-else class="quota-body">
      <div v-for="r in rows" :key="r.key" class="bucket">
        <div class="bucket-top">
          <span class="bucket-name">{{ r.label }}</span>
          <span class="bucket-num">
            剩余 <strong>{{ fmt(r.b.remaining) }}</strong> / {{ fmt(r.b.limit) }}
          </span>
        </div>
        <div class="bar">
          <div :class="['bar-fill', barClass(r.b)]" :style="{ width: `${percent(r.b)}%` }"></div>
        </div>
        <div class="bucket-foot">
          <span>{{ r.desc }}</span>
          <span>{{ resetText(r.b) }}</span>
        </div>
      </div>
      <p v-if="lowWarn" class="quota-warn">{{ lowWarn }}</p>
      <p class="quota-note">{{ info.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.quota {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
}
.quota-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.quota-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.quota-head .btn {
  margin-left: auto;
}
.auth-tag {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 3px;
}
.auth-yes {
  background: var(--green-soft);
  color: var(--green);
}
.auth-no {
  background: #eceff3;
  color: var(--text-3);
}
.quota-err {
  margin-top: 8px;
  font-size: 12px;
  color: var(--red);
  white-space: pre-wrap;
}
.quota-loading {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.quota-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.bucket-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-2);
}
.bucket-name {
  font-family: var(--mono);
  color: var(--text-3);
}
.bucket-num strong {
  font-weight: 600;
  color: var(--text);
}
.bar {
  margin-top: 4px;
  height: 5px;
  border-radius: 3px;
  background: #e2e6eb;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}
.bar-green {
  background: var(--green);
}
.bar-amber {
  background: #d4a72c;
}
.bar-red {
  background: var(--red);
}
.bucket-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-3);
}
.quota-note {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.55;
}
.quota-warn {
  margin-bottom: 4px;
  padding: 6px 8px;
  background: var(--amber-soft);
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--amber);
  line-height: 1.5;
}
</style>
