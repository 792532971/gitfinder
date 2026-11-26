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

const emit = defineEmits<{ (e: 'need-token'): void }>()

/** GitHub 不走账号密码，只认 Personal Access Token */
function openTokenPage(): void {
  window.api.app.openExternal('https://github.com/settings/tokens/new?description=GitFinder')
}

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

async function load(): Promise<{ info: QuotaInfo | null; error: string }> {
  if (loading.value) return { info: info.value, error: error.value }
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
  return { info: info.value, error: error.value }
}

onMounted(load)

defineExpose({ load })
</script>

<template>
  <div class="quota">
    <div class="quota-head">
      <span class="quota-title">接口配额</span>
      <button
        v-if="info"
        :class="[
          'auth-tag',
          info.authenticated ? 'auth-yes' : info.tokenInvalid ? 'auth-bad' : 'auth-no',
          info.authenticated ? '' : 'auth-clickable'
        ]"
        :disabled="info.authenticated"
        :title="info.authenticated ? '已通过 Token 认证' : '点击填写 Token'"
        @click="emit('need-token')"
      >
        {{
          info.authenticated
            ? '已登录'
            : info.tokenInvalid
              ? 'Token 未生效 · 点此重填'
              : '未登录 · 点此填 Token'
        }}
      </button>
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
      <div v-if="!info.authenticated" class="auth-guide">
        <p class="guide-title">
          {{
            info.tokenInvalid
              ? 'Token 填了但没生效'
              : '「登录」在这里指的是填一个 Personal Access Token'
          }}
        </p>
        <p class="guide-body">
          <template v-if="info.tokenInvalid">
            GitHub 没有认这个 Token（401），服务端仍按未登录给你额度。
            常见原因是复制时少了字符、只复制了前缀、Token 已被删除或已过期。
            注意：Token 只在创建时显示一次，忘了就只能重新生成。
          </template>
          <template v-else>
            GitHub 不支持用账号密码调用接口，只认 Token。不填的话 core 只有 60 次/小时，
            浏览两三个榜单就耗尽，之后 README、Release、追踪榜都会失败；
            填上之后提升到 5000 次/小时。
          </template>
        </p>
        <p v-if="info.tokenInvalid && info.note" class="guide-note">{{ info.note }}</p>
        <div class="row" :style="{ gap: '8px', marginTop: '8px' }">
          <button class="btn btn-sm btn-primary" @click="openTokenPage">去 GitHub 创建 Token</button>
          <button class="btn btn-sm" @click="emit('need-token')">
            {{ info.tokenInvalid ? '重新填写' : '已经有了，去填写' }}
          </button>
        </div>
      </div>
      <p v-if="lowWarn" class="quota-warn">{{ lowWarn }}</p>
      <!-- 未登录时上面的引导块已经把话说完了，这句 note 会重复 -->
      <p v-if="info.authenticated" class="quota-note">{{ info.note }}</p>
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
  border: 1px solid transparent;
  font-family: inherit;
}
.auth-clickable {
  cursor: pointer;
  border-style: dashed;
}
.auth-clickable:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.auth-yes {
  background: var(--green-soft);
  color: var(--green);
}
.auth-no {
  background: #eceff3;
  color: var(--text-3);
}
.auth-bad {
  background: var(--red-soft);
  color: var(--red);
}
.auth-guide {
  padding: 8px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.guide-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
}
.guide-body {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.6;
}
.guide-note {
  margin-top: 4px;
  font-size: 11px;
  color: var(--red);
  line-height: 1.55;
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
