import { app, shell, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { runWindowsExe, ensureWindowsDir } from '../lib/shell'
import { saveApp } from '../lib/managed'
import type { ManagedAppItem } from '../../shared/types'

interface DownloadJob {
  controller: AbortController
  target: string
}

const jobs = new Map<string, DownloadJob>()

export interface InstallInput {
  url: string
  fileName: string
  mode: 'silent' | 'manual'
  installDir: string
  /** 记录到管理页需要的仓库信息，缺省则不记 */
  fullName?: string
  name?: string
  version?: string
  record?: boolean
}

export interface InstallOutcome {
  ok: boolean
  message: string
  filePath?: string
  /** 是否已写入管理台账 */
  recorded?: boolean
}

type Phase = 'download' | 'install' | 'done'

function safeFileName(name: string): string {
  const base = path.basename(String(name || 'setup.exe'))
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  return cleaned || 'setup.exe'
}

export function downloadDir(): string {
  const dir = path.join(app.getPath('temp'), 'gitfinder-downloads')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function detectInstallerKind(file: string): ManagedAppItem['installerKind'] {
  if (/\.msi$/i.test(file)) return 'msi'
  try {
    // 读文件头判断 PE 里的字符串特征，粗略区分 NSIS / Squirrel
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(2 * 1024 * 1024, fs.statSync(file).size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const head = buf.toString('latin1')
    if (head.includes('Nullsoft') || head.includes('NSIS')) return 'nsis'
    if (head.includes('Squirrel') || head.includes('Update.exe')) return 'squirrel'
  } catch {
    /* ignore */
  }
  return 'unknown'
}

/** 下载到临时目录，带背压与进度回调 */
async function fetchToFile(
  url: string,
  fileName: string,
  hooks: {
    signal?: AbortSignal
    onProgress?: (received: number, total: number, phase: Phase) => void
  } = {}
): Promise<string> {
  if (!/^https:\/\//i.test(url)) throw new Error('下载地址必须是 https')
  const target = path.join(downloadDir(), safeFileName(fileName))
  const res = await net.fetch(url, {
    signal: hooks.signal,
    redirect: 'follow',
    headers: { Accept: 'application/octet-stream' }
  })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length') || 0)
  const body = res.body
  if (!body) throw new Error('响应体为空')

  const out = fs.createWriteStream(target)
  const reader = body.getReader()
  let received = 0
  let lastTick = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    received += value.byteLength
    // 等待写入回调，天然形成背压，避免大文件把内存吃满
    await new Promise<void>((resolve, reject) => {
      out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
    })
    const now = Date.now()
    if (now - lastTick > 120) {
      lastTick = now
      hooks.onProgress?.(received, total, 'download')
    }
    if (hooks.signal?.aborted) {
      reader.cancel().catch(() => undefined)
      throw new Error('已取消下载')
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
  hooks.onProgress?.(received, total || received, 'download')

  const stat = fs.statSync(target)
  if (stat.size < 1024) throw new Error('下载的文件异常（小于 1KB），可能不是有效的安装包')
  return target
}

/** 执行安装包：manual 只是打开向导，silent 走 /S 或 msiexec */
async function runInstaller(
  file: string,
  mode: 'silent' | 'manual',
  installDir: string,
  onPhase?: (p: Phase) => void
): Promise<InstallOutcome> {
  onPhase?.('install')

  if (mode === 'manual') {
    await shell.openPath(file)
    return {
      ok: true,
      message: `已下载并打开安装程序，请按安装向导操作。文件位置：${file}`,
      filePath: file
    }
  }

  const kind = detectInstallerKind(file)
  const dir = (installDir || '').trim()

  if (kind === 'msi') {
    if (!dir) throw new Error('静默安装需要先选择安装目录')
    await ensureWindowsDir(dir)
    const r = await runWindowsExe('msiexec.exe', [
      '/i',
      file,
      '/qb',
      `/l*v`,
      path.join(downloadDir(), 'msi-install.log'),
      `INSTALLDIR=${dir}`
    ])
    onPhase?.('done')
    return { ok: r.ok, message: r.ok ? `安装完成，目录：${dir}` : r.message, filePath: file }
  }

  // NSIS / Squirrel / 未知：都走 NSIS 的 /S + /D=
  if (!dir) throw new Error('静默安装需要先选择安装目录')
  const canWrite = await ensureWindowsDir(dir)
  if (!canWrite) throw new Error(`无法创建或写入目录：${dir}`)
  // NSIS: /S 静默，/D= 指定目录且必须是最后一个参数、不能加引号
  const r = await runWindowsExe(file, ['/S', `/D=${dir}`])
  if (!r.ok) {
    return {
      ok: false,
      message: `${r.message}\n这类安装包可能不支持静默安装，建议切换到"手动安装"模式`,
      filePath: file
    }
  }
  await new Promise((res) => setTimeout(res, 1200))
  let installed = false
  try {
    installed = fs.existsSync(dir) && fs.readdirSync(dir).length > 0
  } catch {
    installed = false
  }
  onPhase?.('done')
  return {
    ok: true,
    message: installed
      ? `安装完成，目录：${dir}`
      : `安装程序已执行，但目标目录为空。该安装包可能不支持 /D 参数，建议改用手动安装并手动选择目录。`,
    filePath: file
  }
}

/** 下载 + 安装（管理页更新时直接复用，不产生界面事件） */
export async function installPackage(
  input: { url: string; fileName: string; mode: 'silent' | 'manual'; installDir: string },
  hooks: {
    signal?: AbortSignal
    onProgress?: (received: number, total: number, phase: Phase) => void
  } = {}
): Promise<InstallOutcome> {
  const file = await fetchToFile(input.url, input.fileName, hooks)
  return runInstaller(file, input.mode, input.installDir, (p) => hooks.onProgress?.(0, 0, p))
}

export async function startDownload(
  input: InstallInput,
  sender: WebContents
): Promise<{ taskId: string }> {
  const taskId = randomUUID()
  const controller = new AbortController()
  jobs.set(taskId, { controller, target: '' })

  const emitProgress = (received: number, total: number, phase: Phase): void => {
    if (sender.isDestroyed()) return
    sender.send('install:progress', {
      taskId,
      received,
      total,
      percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
      phase
    })
  }
  const emitDone = (outcome: InstallOutcome): void => {
    if (sender.isDestroyed()) return
    sender.send('install:done', {
      taskId,
      ok: outcome.ok,
      message: outcome.message,
      filePath: outcome.filePath
    })
  }

  ;(async () => {
    try {
      const outcome = await installPackage(input, {
        signal: controller.signal,
        onProgress: emitProgress
      })
      emitProgress(0, 0, 'done')

      // 装成功了才落账；手动安装也记，但标记为「路径未确认」，管理页可补指定目录
      let recorded = false
      if (outcome.ok && input.record !== false && input.fullName) {
        try {
          saveApp({
            fullName: input.fullName,
            name: input.name || input.fullName.split('/')[1] || input.fileName,
            version: input.version || '',
            installDir: (input.installDir || '').trim(),
            sourceUrl: input.url,
            fileName: input.fileName,
            installerKind: detectInstallerKind(outcome.filePath || input.fileName),
            manual: input.mode === 'manual'
          })
          recorded = true
        } catch (err) {
          console.error('[install] 写入管理台账失败', err)
        }
      }

      const note = recorded
        ? input.mode === 'manual'
          ? '\n已加入「管理」列表；安装完成后去管理页点「指定目录」确认路径，就能自动更新/卸载。'
          : '\n已加入「管理」列表，可以随时更新或卸载。'
        : ''
      emitDone({ ...outcome, message: outcome.message + note, recorded })
      jobs.delete(taskId)
    } catch (err: any) {
      const msg = controller.signal.aborted ? '已取消' : String(err?.message || err)
      emitDone({ ok: false, message: msg })
      jobs.delete(taskId)
    }
  })()

  return { taskId }
}

export function cancel(taskId: string): void {
  const job = jobs.get(taskId)
  if (!job) return
  job.controller.abort()
  jobs.delete(taskId)
}
