<script setup lang="ts">
/**
 * WSL / Docker 环境诊断面板。
 * 设置页和部署弹窗共用：先跑本机只读探测，配置了 AI 再让模型结合输出分析。
 */
import { computed, ref } from 'vue'
import type { EnvReport, EnvIssue } from '../../../shared/env'
import { state, toast } from '../store'

const props = defineProps<{ compact?: boolean; autoRun?: boolean }>()
const emit = defineEmits<{
  (e: 'pick-distro', name: string): void
  (e: 'done', report: EnvReport): void
}>()

const running = ref(false)
const report = ref<EnvReport | null>(null)
const error = ref('')

const aiReady = computed(() => !!state.settings.ai.apiKey)

const buttonLabel = computed(() => {
  if (running.value) return '诊断中…'
  if (report.value) return '重新诊断'
  return aiReady.value ? 'AI 诊断环境' : '检测 WSL 环境'
})

const sourceText = computed(() => (report.value?.source === 'ai' ? 'AI 分析' : '本机规则'))

async function run(): Promise<void> {
  if (running.value) return
  running.value = true
  error.value = ''
  try {
    const r = await window.api.env.diagnose({ useAi: true })
    report.value = r
    emit('done', r)
    if (!aiReady.value && r.aiNote) toast('未配置 AI，已给出本机探测结论', 'info', 4000)
  } catch (err: any) {
    error.value = err?.message || String(err)
    report.value = null
  } finally {
    running.value = false
  }
}

function levelClass(level: EnvIssue['level']): string {
  return level === 'error' ? 'lv-error' : level === 'warn' ? 'lv-warn' : 'lv-info'
}

function levelText(level: EnvIssue['level']): string {
  return level === 'error' ? '严重' : level === 'warn' ? '注意' : '提示'
}

function dockerText(r: EnvReport): string {
  if (r.docker.available) {
    return `可用${r.docker.version ? ` ${r.docker.version}` : ''}${r.docker.compose ? '，含 compose' : '，无 compose'}`
  }
  return r.docker.note || '不可用'
}

async function copy(text?: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast('命令已复制', 'ok', 2000)
  } catch {
    toast('复制失败，请手动选中', 'error')
  }
}

if (props.autoRun) void run()
</script>

<template>
  <div class="env-diag" :class="{ compact }">
    <div class="diag-head">
      <button class="btn btn-sm" :disabled="running" @click="run">
        <span v-if="running" class="spin">◌</span>
        {{ buttonLabel }}
      </button>
      <span class="tiny muted">
        {{
          aiReady
            ? '先在本机跑只读探测，再把输出交给 AI 判断；AI 不会执行任何命令'
            : '当前没有配置 AI Key，只给纯规则结论；配置后可让 AI 分析探测记录'
        }}
      </span>
    </div>

    <div v-if="running" class="diag-box">
      正在检查 wsl.exe、注册表登记、LxssManager 服务和 WSL 内的 docker…
    </div>

    <div v-else-if="error" class="diag-box diag-err">诊断失败：{{ error }}</div>

    <template v-else-if="report">
      <div class="diag-box">
        <div class="diag-summary">
          <span :class="['src-tag', report.source === 'ai' ? 'src-ai' : 'src-local']">{{ sourceText }}</span>
          <span>{{ report.summary }}</span>
        </div>

        <div class="diag-row">
          <span class="row-label">发行版</span>
          <div v-if="report.distros.length" class="chips">
            <button
              v-for="d in report.distros"
              :key="d.name"
              :class="['distro-chip', { on: d.isDefault }]"
              :title="`${d.from || ''}${d.from ? ' · ' : ''}docker: ${d.docker}`"
              @click="emit('pick-distro', d.name)"
            >
              {{ d.name }}
              <span v-if="d.version" class="chip-dim">WSL{{ d.version }}</span>
              <span v-if="d.docker === 'yes'" class="dot dot-green" title="docker 可用"></span>
              <span v-else-if="d.docker === 'no'" class="dot dot-red" title="没有 docker"></span>
              <em v-if="d.isDefault" class="chip-default">默认</em>
            </button>
          </div>
          <span v-else class="tiny muted">没检测到任何发行版</span>
        </div>

        <div class="diag-row">
          <span class="row-label">Docker</span>
          <span :class="['tiny', report.docker.available ? 'val-ok' : 'val-bad']">{{ dockerText(report) }}</span>
        </div>

        <div v-if="report.aiNote" class="diag-note">{{ report.aiNote }}</div>
      </div>

      <div v-if="report.issues.length" class="issue-list">
        <div v-for="(it, i) in report.issues" :key="i" :class="['issue', levelClass(it.level)]">
          <div class="issue-head">
            <span class="issue-level">{{ levelText(it.level) }}</span>
            <strong>{{ it.title }}</strong>
          </div>
          <p v-if="it.detail" class="issue-detail">{{ it.detail }}</p>
          <div v-if="it.fix" class="issue-fix">
            <code>{{ it.fix }}</code>
            <button class="btn btn-sm btn-ghost" @click="copy(it.fix)">复制</button>
          </div>
        </div>
      </div>
      <div v-else class="diag-box diag-ok">没有发现阻碍部署的问题，可以直接去部署了。</div>

      <details class="diag-steps">
        <summary>原始探测记录（{{ report.steps.length }} 条）</summary>
        <div v-for="s in report.steps" :key="s.id" class="step">
          <div class="step-head">
            <span :class="['step-code', s.ok ? 'ok' : 'bad']">exit={{ s.code }}</span>
            <code class="step-cmd">{{ s.cmd }}</code>
          </div>
          <pre class="step-out">{{ s.out || '(无输出)' }}</pre>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.env-diag {
  margin-top: 12px;
}
.env-diag.compact {
  margin-top: 8px;
}
.diag-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.diag-box {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
}
.diag-err {
  background: var(--red-soft);
  color: var(--red);
}
.diag-ok {
  background: var(--green-soft);
  color: var(--green);
}
.diag-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--text);
}
.src-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 18px;
}
.src-ai {
  background: var(--accent-soft);
  color: var(--accent);
}
.src-local {
  background: #eceff3;
  color: var(--text-2);
}
.diag-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.row-label {
  flex: none;
  width: 46px;
  color: var(--text-3);
  font-size: 12px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.distro-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.distro-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.distro-chip.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.chip-dim {
  color: var(--text-3);
  font-size: 11px;
}
.chip-default {
  font-style: normal;
  font-size: 10.5px;
  color: var(--accent);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.dot-green {
  background: var(--green);
}
.dot-red {
  background: var(--red);
}
.val-ok {
  color: var(--green);
}
.val-bad {
  color: var(--amber);
}
.diag-note {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  color: var(--text-3);
  font-size: 12px;
}
.issue-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.issue {
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--border-strong);
  background: var(--bg-subtle);
  font-size: 12.5px;
}
.issue.lv-error {
  border-left-color: var(--red);
  background: var(--red-soft);
}
.issue.lv-warn {
  border-left-color: var(--amber);
  background: var(--amber-soft);
}
.issue.lv-info {
  border-left-color: var(--accent);
  background: var(--accent-soft);
}
.issue-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.issue-head strong {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.issue-level {
  flex: none;
  font-size: 10.5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.75);
  color: var(--text-2);
}
.issue-detail {
  margin-top: 4px;
  color: var(--text-2);
  line-height: 1.65;
}
.issue-fix {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}
.issue-fix code {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 5px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
}
.diag-steps {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-3);
}
.diag-steps summary {
  cursor: pointer;
  user-select: none;
}
.step {
  margin-top: 8px;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.step-code {
  flex: none;
  font-family: var(--mono);
  font-size: 11px;
  padding: 0 5px;
  border-radius: 3px;
}
.step-code.ok {
  background: var(--green-soft);
  color: var(--green);
}
.step-code.bad {
  background: var(--red-soft);
  color: var(--red);
}
.step-cmd {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-2);
  word-break: break-all;
}
.step-out {
  margin-top: 3px;
  padding: 7px 9px;
  max-height: 160px;
  overflow: auto;
  background: var(--bg-subtle);
  border-radius: 5px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
