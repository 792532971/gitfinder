<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { Settings } from '../../../shared/types'
import type { EnvReport } from '../../../shared/env'
import { state, saveSettings, toast } from '../store'
import EnvDiagnose from './EnvDiagnose.vue'
import GithubQuota from './GithubQuota.vue'

const props = defineProps<{ focusToken?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const form = ref<Settings>(JSON.parse(JSON.stringify(state.settings)))
const distros = ref<string[]>([])
const distroLoading = ref(false)
const testingAi = ref(false)
const testingProxy = ref(false)
const saving = ref(false)
const clearingProfiles = ref(false)
const quotaRef = ref<InstanceType<typeof GithubQuota> | null>(null)
const tokenInput = ref<HTMLInputElement | null>(null)
const initialToken = (state.settings.githubToken || '').trim()

/** 配额面板点「未登录」时把光标带到 Token 输入框 */
function focusToken(): void {
  tokenInput.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  tokenInput.value?.focus()
}

async function clearProfiles(): Promise<void> {
  clearingProfiles.value = true
  try {
    const n = await window.api.board.clearProfiles()
    toast(n ? `已清除 ${n} 条中文说明缓存` : '还没有缓存的中文说明', 'ok')
  } catch (err: any) {
    toast(`清除失败：${err.message}`, 'error')
  } finally {
    clearingProfiles.value = false
  }
}

async function loadDistros(): Promise<void> {
  distroLoading.value = true
  try {
    distros.value = await window.api.deploy.wslDistros()
  } catch {
    distros.value = []
  } finally {
    distroLoading.value = false
  }
}

/** AI 诊断出结果后，把发行版列表同步进下拉候选 */
function onDiagnosed(r: EnvReport): void {
  const names = r.distros.map((d) => d.name)
  if (names.length) distros.value = [...new Set([...distros.value, ...names])]
}

onMounted(() => {
  void loadDistros()
  // 从 README 的「去配置 Token」跳过来时，直接把光标放进输入框
  if (props.focusToken) setTimeout(focusToken, 250)
})

async function pickInstallDir(): Promise<void> {
  const dir = await window.api.settings.pickDir('选择默认安装目录')
  if (dir) form.value.installDir = dir
}

async function testAi(): Promise<void> {
  testingAi.value = true
  try {
    await saveSettings(form.value)
    const r = await window.api.ai.test()
    toast(r.message, r.ok ? 'ok' : 'error', r.ok ? 4000 : 7000)
  } catch (err: any) {
    toast(`测试失败：${err.message}`, 'error', 6000)
  } finally {
    testingAi.value = false
  }
}

async function testProxy(): Promise<void> {
  testingProxy.value = true
  try {
    await saveSettings(form.value)
    const r = await window.api.settings.applyProxy()
    toast(r.message, r.ok ? 'ok' : 'error')
  } catch (err: any) {
    toast(`代理设置失败：${err.message}`, 'error')
  } finally {
    testingProxy.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await saveSettings(form.value)
    // Token 变了，配额要按新身份重新查
    if ((form.value.githubToken || '').trim() !== initialToken) void quotaRef.value?.load()
    toast('设置已保存', 'ok')
    emit('close')
  } catch (err: any) {
    toast(`保存失败：${err.message}`, 'error')
  } finally {
    saving.value = false
  }
}

function openTokenPage(): void {
  // 只读公开数据，不需要勾任何 scope，避免多给写权限
  window.api.app.openExternal('https://github.com/settings/tokens/new?description=GitFinder')
}

function openProxyHint(): void {
  window.api.app.openExternal('https://github.com/search?q=github+proxy+mirror&type=repositories')
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal settings-modal">
      <div class="modal-head">
        <h3>设置</h3>
        <button class="btn btn-ghost btn-sm" @click="emit('close')">关闭</button>
      </div>

      <div class="modal-body">
        <!-- GitHub -->
        <div class="group">
          <div class="group-title">
            GitHub
            <button class="btn btn-ghost btn-sm" @click="openTokenPage">去创建 Token</button>
          </div>
          <div class="field">
            <label>Personal Access Token</label>
            <input
              ref="tokenInput"
              v-model="form.githubToken"
              class="input mono"
              type="password"
              placeholder="ghp_xxxxxxxxxxxx"
            />
            <span class="desc">
              GitHub 不支持账号密码调用接口，「登录」就是填这个 Token。
              <strong>不填：core 60 次/小时、搜索 10 次/分钟</strong>，浏览几个榜单就耗尽；
              <strong>填了：core 5000 次/小时、搜索 30 次/分钟</strong>。
              创建时<strong>不用勾任何权限</strong>（只读公开数据就够），有效期建议选 90 天。
            </span>
          </div>

          <GithubQuota ref="quotaRef" @need-token="focusToken" />

          <label class="switch" style="margin-top: 10px">
            <input v-model="form.githubFallback" type="checkbox" />
            <span class="track"></span>
            <span class="tiny">
              core 配额用尽时改用搜索接口兜底（两个配额池独立，搜索按分钟重置；关掉后遇到配额问题会直接报错）
            </span>
          </label>
        </div>

        <!-- 网络 -->
        <div class="group">
          <div class="group-title">
            网络代理
            <button class="btn btn-ghost btn-sm" :disabled="testingProxy" @click="testProxy">
              {{ testingProxy ? '应用中…' : '应用并测试' }}
            </button>
          </div>
          <div class="field">
            <label>代理地址</label>
            <input
              v-model="form.proxy"
              class="input mono"
              placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891"
            />
            <span class="desc">
              留空则跟随系统代理。所有 GitHub API 请求、Release 下载都会走这里；WSL 里的 git clone
              也会自动带上同样的代理。
            </span>
          </div>
        </div>

        <!-- AI -->
        <div class="group">
          <div class="group-title">
            AI 润色
            <div class="row">
              <button class="btn btn-ghost btn-sm" :disabled="testingAi" @click="testAi">
                {{ testingAi ? '测试中…' : '测试连接' }}
              </button>
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>接口地址（OpenAI 兼容）</label>
              <input v-model="form.ai.baseUrl" class="input mono" placeholder="https://api.deepseek.com" />
              <span class="desc">DeepSeek / Kimi / 硅基流动 / 本地 Ollama 都行</span>
            </div>
            <div class="field">
              <label>模型名称</label>
              <input v-model="form.ai.model" class="input mono" placeholder="deepseek-chat" />
              <span class="desc">如 deepseek-chat、gpt-4o-mini、qwen-plus</span>
            </div>
          </div>
          <div class="field" style="margin-top: 12px">
            <label>API Key</label>
            <input
              v-model="form.ai.apiKey"
              class="input mono"
              type="password"
              placeholder="sk-xxxxxxxx"
            />
            <span class="desc">
              只存在本机的设置文件里，不会上传。默认值指向 DeepSeek 官方接口。
            </span>
          </div>
          <label class="switch" style="margin-top: 12px">
            <input v-model="form.ai.enabled" type="checkbox" />
            <span class="track"></span>
            <span class="tiny">默认启用 AI 润色（搜索前先把描述改写成 GitHub 搜索语法）</span>
          </label>
          <label class="switch" style="margin-top: 8px">
            <input v-model="form.ai.enrich" type="checkbox" />
            <span class="track"></span>
            <span class="tiny">
              榜单自动生成中文用途与安装方式（每榜最多 40 个项目，结果缓存在本机 14 天，重复浏览不再消耗额度）
            </span>
          </label>
          <div class="row" style="margin-top: 10px">
            <button class="btn btn-sm btn-ghost" :disabled="clearingProfiles" @click="clearProfiles">
              {{ clearingProfiles ? '清理中…' : '清除中文说明缓存' }}
            </button>
            <span class="tiny muted">换模型或发现说明不准时点这里</span>
          </div>
        </div>

        <!-- WSL -->
        <div class="group">
          <div class="group-title">
            WSL 部署
            <button class="btn btn-ghost btn-sm" :disabled="distroLoading" @click="loadDistros">
              {{ distroLoading ? '检测中…' : '重新检测' }}
            </button>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>WSL 发行版</label>
              <input v-model="form.wslDistro" class="input" list="distro-list" placeholder="留空使用默认发行版" />
              <datalist id="distro-list">
                <option v-for="d in distros" :key="d" :value="d" />
              </datalist>
              <span class="desc">
                {{ distros.length ? `检测到：${distros.join('、')}` : '没检测到发行版，可以直接手填名称（如 Ubuntu）' }}
              </span>
            </div>
            <div class="field">
              <label>项目存放目录（WSL 内路径）</label>
              <input v-model="form.wslWorkDir" class="input mono" placeholder="~/gitfinder-apps" />
              <span class="desc">留空默认为 ~/gitfinder-apps</span>
            </div>
          </div>

          <EnvDiagnose @pick-distro="form.wslDistro = $event" @done="onDiagnosed" />
        </div>

        <!-- 安装 -->
        <div class="group">
          <div class="group-title">本机安装</div>
          <div class="field">
            <label>默认安装目录</label>
            <div class="row">
              <input v-model="form.installDir" class="input mono" placeholder="不填则每次询问" />
              <button class="btn" @click="pickInstallDir">浏览</button>
            </div>
          </div>
          <div class="grid-2" style="margin-top: 12px">
            <div class="field">
              <label>默认安装方式</label>
              <select v-model="form.installMode" class="select">
                <option value="manual">手动安装（打开安装向导）</option>
                <option value="silent">静默安装到指定目录</option>
              </select>
            </div>
            <div class="field">
              <label>每页结果数</label>
              <select v-model.number="form.perPage" class="select">
                <option :value="10">10</option>
                <option :value="20">20</option>
                <option :value="30">30</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-modal {
  max-width: 760px;
}
.group {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.group:first-child {
  padding-top: 0;
}
.group:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
</style>
